"""
LLM Wiki Writer — Wikipedia-agent model.

Three functions:
  plan_wiki_edits(content, candidates)  → WikiEditPlan
  update_wiki_page(title, content, existing) → str
  review_wiki_pages(pages)              → list[(slug, md)]
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from second_brain.llm.client import OpenRouterClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Slug helper
# ---------------------------------------------------------------------------

def slugify(title: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", title.lower()).strip()
    return re.sub(r"[\s_]+", "-", slug)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class WikiEditPlan:
    updates: list[dict[str, Any]] = field(default_factory=list)   # [{slug, title}]
    new_pages: list[dict[str, Any]] = field(default_factory=list)  # [{title}]


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_PLAN_SYSTEM = """\
You are an experienced Wikipedia editor. You receive new information and a list
of existing wiki articles (slug, title, preview).

Decide:
1. Which existing articles need to be updated with the new information?
2. Does a completely new article need to be created? (only if NO suitable one exists)

Important rules:
- Recognise synonyms and abbreviations: treat "BU" and "Berufsunfähigkeit" as the same article.
- Prefer expanding an existing article over creating unnecessary new ones.
- If no candidates exist, create a new article.

Reply ONLY with valid JSON, no comments:
{
  "updates": [{"slug": "existing-slug", "title": "Page Title"}],
  "new_pages": [{"title": "New Page Title"}]
}
"""

_PLAN_USER_TEMPLATE = """\
New information:
{content}

Existing wiki articles (candidates):
{candidates_block}

Decide which articles to update and whether new ones need to be created.
"""

_UPDATE_SYSTEM_TEMPLATE = """\
You maintain a personal knowledge base. Write or update a wiki article
based on the given information.

Strict rules:
1. Return the COMPLETE updated article — no truncation.
2. Outdated or contradictory facts may be corrected — judge like a good editor.
3. Write ONLY what follows from the new information — do not invent general world knowledge.
4. Choose the structure freely based on the content — no fixed required sections.
5. Update the `last_updated` field to today's date.
6. Reply ONLY with the Markdown content. No code blocks, no comments.
"""

_UPDATE_USER_TEMPLATE = """\
Article: {title}
Current date and time: {now}

New information:
{content}

Existing article content:
{existing}

Create or update the complete wiki article for '{title}'.
"""

_REVIEW_SYSTEM = """\
You maintain a personal knowledge base. You receive a cluster of thematically
related wiki pages.

Your tasks:
1. Add missing cross-links between pages in the cluster
2. Resolve contradictions between pages
3. Expand very short pages if related pages provide enough information

Do not invent new content. Leave pages unchanged if there is no real need.

Reply ONLY with valid JSON:
{
  "updates": [
    {"slug": "article-slug", "content": "complete updated markdown content"}
  ]
}
"""


# ---------------------------------------------------------------------------
# Prompts — Topic Split
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def split_into_topics(content: str) -> list[str]:
    """Splits a text into thematically independent units of information."""
    if len(content) < 80:
        return [content]
    client = OpenRouterClient()
    try:
        data = await client.chat_json(_SPLIT_SYSTEM, content)
        topics = data.get("topics", [])
        if isinstance(topics, list) and all(isinstance(t, str) for t in topics):
            return [t for t in topics if t.strip()] or [content]
    except Exception as exc:
        logger.warning("Topic split failed, processing as whole: %s", exc)
    return [content]


async def plan_wiki_edits(
    content: str,
    candidates: list[dict[str, Any]],
) -> WikiEditPlan:
    """Agent decides which wiki pages to update."""
    client = OpenRouterClient()

    if candidates:
        candidates_block = "\n\n".join(
            f"- Slug: {c['slug']}\n  Title: {c['title']}\n  Preview: {c['preview'][:200]}"
            for c in candidates
        )
    else:
        candidates_block = "(Wiki is still empty — create a new article)"

    user = _PLAN_USER_TEMPLATE.format(
        content=content[:3000],
        candidates_block=candidates_block,
    )

    try:
        data = await client.chat_json(_PLAN_SYSTEM, user)
        return WikiEditPlan(
            updates=data.get("updates", []),
            new_pages=data.get("new_pages", []),
        )
    except Exception as exc:
        logger.error("Wiki planning failed: %s", exc)
        # Fallback: create a new article
        title = _extract_title_heuristic(content)
        return WikiEditPlan(new_pages=[{"title": title}])


async def update_wiki_page(
    title: str,
    content: str,
    existing: str,
) -> str:
    """Updates or creates a single wiki article."""
    from datetime import datetime  # noqa: PLC0415
    client = OpenRouterClient()
    user = _UPDATE_USER_TEMPLATE.format(
        title=title,
        now=datetime.now().strftime("%Y-%m-%d %H:%M"),
        content=content,
        existing=existing or "(no article yet)",
    )
    try:
        return await client.complete(_UPDATE_SYSTEM_TEMPLATE, user)
    except Exception as exc:
        logger.error("Wiki update for '%s' failed: %s", title, exc)
        return existing or _fallback_page(title)


async def review_wiki_pages(pages: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Hourly review agent: checks pages for missing links and contradictions."""
    if not pages:
        return []

    client = OpenRouterClient()
    pages_json = json.dumps(
        [{"slug": slug, "content": content[:800]} for slug, content in pages],
        ensure_ascii=False,
        indent=2,
    )
    try:
        data = await client.chat_json(_REVIEW_SYSTEM, pages_json)
        updates = data.get("updates", [])
        return [(u["slug"], u["content"]) for u in updates if "slug" in u and "content" in u]
    except Exception as exc:
        logger.error("Wiki review failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_title_heuristic(text: str) -> str:
    """Uses the first sentence as a title fallback."""
    first = text.strip().split("\n")[0][:60]
    return first or "Unknown Topic"


def _fallback_page(title: str) -> str:
    from datetime import date  # noqa: PLC0415
    return (
        f"# {title}\n\n"
        f"last_updated: {date.today().isoformat()}\n\n"
        f"*(Page could not be created automatically)*\n"
    )
