"""
edit_vault — the one LangGraph agent that remember and repair share.

    gather → plan → apply →(create/merge?)→ reconcile → finalize
                          └──────────────────────────→ finalize

gather   resolves the focus to seed pages via vector search (routing =
         retrieval, not guessing) and loads their full Markdown.
plan     is a single LLM call that returns typed operations instead of
         rewritten prose — the constrained generation that prevents
         confabulation (see agent/operations.py).
apply    executes the operations deterministically.
reconcile runs only after create_page/merge and rewires backlinks.
finalize re-derives graph + vectors for changed pages. Git sync happens in
         the calling task: pull before the run, one push after the ingestion
         log reached its final state (audit/revert net).

Entry points differ only in how gather resolves the focus:
  remember(text)  → focus is new information
  repair(slug)    → focus is an existing page to garden
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from second_brain.agent.operations import (
    CreatePage,
    Operation,
    apply_operations,
    parse_operations,
)
from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.llm.client import get_llm_client
from second_brain.llm.embedder import get_embedder
from second_brain.memory.indexing import (
    WIKI_COLLECTION,
    backfill_wikilinks,
    build_slug_title_map,
    inject_links_into_page,
    read_title,
    update_graph_and_vectors,
    wiki_base_path,
)
from second_brain.memory.vector import QdrantStore

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

GATHER_LIMIT = 6
PAGE_PROMPT_CHARS = 4000

Mode = Literal["remember", "repair"]


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


class EditVaultState(TypedDict):
    mode: Mode
    focus: str  # new text (remember) or page slug (repair)
    source: str  # trigger description → git commit message
    pages: dict[str, str]  # slug → full markdown, loaded by gather
    operations: list[Operation]
    rejected: list[str]
    changed: dict[str, str]  # slug → diff summary
    created: list[str]
    skipped: list[str]
    applied: list[str]
    needs_reconcile: bool
    result: str


@dataclass
class EditVaultResult:
    result: str
    changed: dict[str, str] = field(default_factory=dict)
    created: list[str] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_PLAN_SYSTEM = """\
You maintain a personal wiki. You never rewrite pages as free prose — you
propose a minimal list of typed operations as JSON.

Available operations:
- {"op": "add_claim", "page": "<slug>", "section": "<heading or null>", "text": "..."}
  Append one statement to a page (into the given section, or at the end).
- {"op": "edit_section", "page": "<slug>", "section": "<heading>", "text": "..."}
  Replace the body of one section. Repeat every sentence that stays unchanged verbatim.
- {"op": "create_page", "title": "...", "content": "..."}
  Only if no shown page fits the information.
- {"op": "link", "page": "<slug>", "to": "<slug>", "type": "<relation or null>"}
  Add a wikilink between two shown pages. Give "type" (a short snake_case label
  like "uses", "part_of", "works_at", "decided_against") ONLY when the input or
  the pages state that relation explicitly — otherwise leave it null.
- {"op": "merge", "source": "<slug>", "target": "<slug>"}
  Only for true duplicates. Contents are combined mechanically — do not rewrite them.
- {"op": "mark_outdated", "page": "<slug>", "reason": "..."}
  Flag a statement or page that is contradicted or superseded.

Grounding rules (strict):
1. Every sentence you write must come from the given input or from the shown
   pages. No background knowledge, no interpretations, no plausible details.
   If a name resembles a well-known term, do NOT infer anything from that
   resemblance.
2. Prefer the smallest edit that captures the information:
   add_claim over edit_section over create_page.
3. Reuse existing wording verbatim wherever possible.
4. An empty operation list is a valid answer.

Reply ONLY with valid JSON, no comments:
{"operations": [ ... ]}
"""

_REMEMBER_TASK = """\
New information (current date: {now}):
{focus}

Store this in the wiki. Update the shown pages where they cover the topic;
create a new page only if none fits.
"""

_REPAIR_TASK = """\
You are gardening the wiki. Page under review: {focus}

Check, using ONLY the shown pages:
- Is another shown page a true duplicate of it? → merge
- Do shown pages contradict each other? → mark_outdated the superseded statement
- Are two shown pages clearly related but not linked? → link
  (add "type" only if the pages state the relation explicitly)
- Is a section obviously stale? → mark_outdated

Do not use create_page. Do not add new content. If everything is fine,
return an empty operation list.
"""

_PAGES_BLOCK_EMPTY = "(the wiki has no relevant pages yet)"


# ---------------------------------------------------------------------------
# Topic split (used by the remember entry point)
# ---------------------------------------------------------------------------

_SPLIT_SYSTEM = """\
You are a knowledge analyst. Check whether the text contains multiple thematically
independent units of information that would be better stored separately in a knowledge base.

If yes: split into separate units.
If no: return the text as a single unit.

Reply ONLY with valid JSON:
{"topics": ["unit 1", "unit 2"]}

Example:
Input: "I broke my foot today and called my mother."
Output: {"topics": ["I broke my foot today.", "I called my mother today."]}
"""


async def split_into_topics(content: str) -> list[str]:
    """Splits a text into thematically independent units of information."""
    if len(content) < 80:
        return [content]
    client = get_llm_client()
    try:
        data = await client.chat_json(_SPLIT_SYSTEM, content)
        topics = data.get("topics", [])
        if isinstance(topics, list) and all(isinstance(t, str) for t in topics):
            return [t for t in topics if t.strip()] or [content]
    except Exception as exc:
        logger.warning("Topic split failed, processing as whole: %s", exc)
    return [content]


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


def _load_pages(slugs: list[str]) -> dict[str, str]:
    wiki_base = wiki_base_path()
    pages: dict[str, str] = {}
    for slug in slugs:
        path = wiki_base / f"{slug}.md"
        if path.exists() and slug not in pages:
            pages[slug] = path.read_text(encoding="utf-8")
    return pages


def _search_slugs(query_text: str, limit: int = GATHER_LIMIT) -> list[str]:
    try:
        vec = get_embedder().embed(query_text[:2000])
        hits = QdrantStore(settings.QDRANT_URL).search(
            WIKI_COLLECTION, vec, limit=limit
        )
        return [str(h["slug"]) for h in hits if h.get("slug")]
    except Exception as exc:
        logger.warning("Gather search failed (Qdrant empty?): %s", exc)
        return []


async def _gather(state: EditVaultState) -> dict[str, Any]:
    with tracer.start_as_current_span("edit_vault.gather") as span:
        if state["mode"] == "remember":
            slugs = _search_slugs(state["focus"])
        else:
            page = _load_pages([state["focus"]])
            content = page.get(state["focus"], state["focus"])
            slugs = [state["focus"], *_search_slugs(content)]
        pages = _load_pages(slugs)
        span.set_attribute("pages", len(pages))
        return {"pages": pages}


async def _plan(state: EditVaultState) -> dict[str, Any]:
    with tracer.start_as_current_span("edit_vault.plan") as span:
        if state["mode"] == "repair" and state["focus"] not in state["pages"]:
            return {"operations": [], "rejected": [f"page not found: {state['focus']}"]}

        if state["pages"]:
            pages_block = "\n\n".join(
                f"### Page: {slug}\n{content[:PAGE_PROMPT_CHARS]}"
                for slug, content in state["pages"].items()
            )
        else:
            pages_block = _PAGES_BLOCK_EMPTY

        task_template = _REMEMBER_TASK if state["mode"] == "remember" else _REPAIR_TASK
        task = task_template.format(
            focus=state["focus"], now=datetime.now().strftime("%Y-%m-%d %H:%M")
        )
        user = f"{task}\nWiki pages:\n\n{pages_block}"

        try:
            data = await get_llm_client().chat_json(_PLAN_SYSTEM, user)
        except Exception as exc:
            logger.error("Planning failed: %s", exc)
            return {"operations": [], "rejected": [f"planning LLM call failed: {exc}"]}

        ops, rejected = parse_operations(
            data.get("operations") if isinstance(data, dict) else None
        )
        if state["mode"] == "repair":
            creates = [op for op in ops if isinstance(op, CreatePage)]
            if creates:
                rejected += [
                    f"create_page not allowed in repair: {op.title}" for op in creates
                ]
                ops = [op for op in ops if not isinstance(op, CreatePage)]
        span.set_attribute("operations", len(ops))
        span.set_attribute("rejected", len(rejected))
        return {"operations": ops, "rejected": rejected}


async def _apply(state: EditVaultState) -> dict[str, Any]:
    with tracer.start_as_current_span("edit_vault.apply") as span:
        result = apply_operations(state["operations"], wiki_base_path())
        span.set_attribute("changed", len(result.changed))
        return {
            "changed": result.changed,
            "created": sorted(result.created),
            "skipped": result.skipped,
            "applied": result.applied,
            "needs_reconcile": bool(result.created) or result.merged,
        }


async def _reconcile(state: EditVaultState) -> dict[str, Any]:
    """Deterministic link maintenance after create_page/merge."""
    with tracer.start_as_current_span("edit_vault.reconcile"):
        wiki_base = wiki_base_path()
        slug_title_map = build_slug_title_map(wiki_base)
        changed = dict(state["changed"])

        # Forward: scan changed pages for all known titles
        for slug in list(changed):
            inject_links_into_page(wiki_base / f"{slug}.md", slug_title_map)

        # Backward: link existing pages to newly created pages
        for slug in state["created"]:
            title = slug_title_map.get(slug, slug)
            for touched in backfill_wikilinks(slug, title, wiki_base):
                changed.setdefault(touched, "(backfilled wikilink)")

        return {"changed": changed}


async def _finalize(state: EditVaultState) -> dict[str, Any]:
    """Re-derive graph + vectors for changed pages."""
    with tracer.start_as_current_span("edit_vault.finalize") as span:
        changed = state["changed"]
        if not changed:
            return {"result": "no_changes"}

        wiki_base = wiki_base_path()
        pages = []
        for slug in changed:
            path = wiki_base / f"{slug}.md"
            if path.exists():
                pages.append((slug, read_title(path), path.read_text(encoding="utf-8")))
        if pages:
            update_graph_and_vectors(pages)
        span.set_attribute("pages", len(pages))
        return {"result": f"ok:{len(changed)}_pages"}


def _route_after_apply(state: EditVaultState) -> str:
    return "reconcile" if state["needs_reconcile"] else "finalize"


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------


def _build_graph() -> Any:
    builder = StateGraph(EditVaultState)
    builder.add_node("gather", _gather)
    builder.add_node("plan", _plan)
    builder.add_node("apply", _apply)
    builder.add_node("reconcile", _reconcile)
    builder.add_node("finalize", _finalize)
    builder.add_edge(START, "gather")
    builder.add_edge("gather", "plan")
    builder.add_edge("plan", "apply")
    builder.add_conditional_edges(
        "apply", _route_after_apply, {"reconcile": "reconcile", "finalize": "finalize"}
    )
    builder.add_edge("reconcile", "finalize")
    builder.add_edge("finalize", END)
    return builder.compile()


_graph = _build_graph()


async def edit_vault(mode: Mode, focus: str, source: str) -> EditVaultResult:
    """Runs the shared agent. `focus` is new text (remember) or a slug (repair)."""
    initial: EditVaultState = {
        "mode": mode,
        "focus": focus,
        "source": source,
        "pages": {},
        "operations": [],
        "rejected": [],
        "changed": {},
        "created": [],
        "skipped": [],
        "applied": [],
        "needs_reconcile": False,
        "result": "no_changes",
    }
    final = await _graph.ainvoke(initial)
    if final.get("skipped"):
        logger.info("edit_vault skipped ops: %s", final["skipped"])
    if final.get("rejected"):
        logger.warning("edit_vault rejected ops: %s", final["rejected"])
    return EditVaultResult(
        result=str(final.get("result", "no_changes")),
        changed=dict(final.get("changed", {})),
        created=list(final.get("created", [])),
        applied=list(final.get("applied", [])),
        skipped=list(final.get("skipped", [])),
        rejected=list(final.get("rejected", [])),
    )
