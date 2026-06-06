"""
Celery ingestion tasks.

process_ingestion  — Wikipedia-agent model:
  1. Semantic search for relevant wiki pages (Qdrant)
  2. Planning agent: which pages to update, which to create?
  3. Update agent writes complete pages
  4. Inject wikilinks
  5. Derive Neo4j graph from [[wikilinks]]
  6. Upsert Qdrant embeddings
  7. Git commit + push

wiki_review_hourly — hourly quality agent:
  Reviews a semantic cluster of wiki pages for missing links and contradictions.
"""
import asyncio
import difflib
import json
import logging
import random
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from second_brain.core.celery_app import celery_app
from second_brain.core.config import settings
from second_brain.git_sync import get_git_sync
from second_brain.llm.embedder import get_embedder
from second_brain.llm.wiki_writer import (
    WikiEditPlan,
    plan_wiki_edits,
    review_wiki_pages,
    slugify,
    split_into_topics,
    update_wiki_page,
)
from second_brain.memory.graph import Neo4jStore
from second_brain.memory.vector import QdrantStore

logger = logging.getLogger(__name__)

WIKI_COLLECTION = "wiki_pages"
REVIEW_SAMPLE_SIZE = 8


# ---------------------------------------------------------------------------
# Ingestion log helpers
# ---------------------------------------------------------------------------

def _log_path(task_id: str) -> Path:
    log_dir = Path(settings.VAULT_PATH) / "3_operations" / "ingestion-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / f"{task_id}.json"


def _write_log(task_id: str, data: dict[str, Any]) -> None:
    try:
        _log_path(task_id).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed to write log: %s", exc)


def _log_start(task_id: str, content: str) -> None:
    _write_log(task_id, {
        "task_id": task_id,
        "status": "running",
        "started": datetime.now().isoformat(timespec="seconds"),
        "finished": None,
        "input_preview": content[:120],
        "pages_updated": [],
        "pages_created": [],
        "error": None,
    })


def _page_diff_summary(old: str, new: str, max_lines: int = 10) -> str:
    """Returns changed lines (+/-) as a compact string."""
    lines = []
    for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm=""):
        if line.startswith(("---", "+++", "@@")):
            continue
        if line.startswith(("+", "-")):
            body = line[1:].strip()
            if body and not body.startswith("last_updated"):
                lines.append(line[0] + " " + body)
    preview = lines[:max_lines]
    suffix = f"\n… ({len(lines) - max_lines} more)" if len(lines) > max_lines else ""
    return "\n".join(preview) + suffix


def _log_done(
    task_id: str,
    pages_updated: list[dict[str, Any]],
    pages_created: list[dict[str, Any]],
) -> None:
    path = _log_path(task_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {"task_id": task_id}
    data.update({
        "status": "done",
        "finished": datetime.now().isoformat(timespec="seconds"),
        "pages_updated": pages_updated,
        "pages_created": pages_created,
    })
    _write_log(task_id, data)


def _log_failed(task_id: str, error: str) -> None:
    path = _log_path(task_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {"task_id": task_id}
    data.update({
        "status": "failed",
        "finished": datetime.now().isoformat(timespec="seconds"),
        "error": error,
    })
    _write_log(task_id, data)


def _parse_wikilinks(markdown: str) -> list[str]:
    # Handles [[slug]] and [[slug|DisplayText]] — always returns the slug part
    return [m.split("|")[0].strip() for m in re.findall(r"\[\[([^\]]+)\]\]", markdown)]


def _run_async(coro: Any) -> Any:
    return asyncio.run(coro)


def _slug_to_uuid(slug: str) -> str:
    import uuid  # noqa: PLC0415
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, slug))


def _read_title(path: Path) -> str:
    """Reads the first # heading from a Markdown file as the title."""
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return path.stem


def _build_slug_title_map(wiki_base: Path) -> dict[str, str]:
    """slug → title (from first # heading) for all wiki pages."""
    result = {}
    for f in wiki_base.rglob("*.md"):
        result[f.stem] = _read_title(f)
    return result


def _inject_links_into_page(path: Path, slug_title_map: dict[str, str]) -> bool:
    """Scans a page for title mentions and injects [[slug]] links.

    Matches the title (prose) and the slug — slug is used as link target
    so links always point to actually existing pages.
    """
    if not path.exists():
        return False
    content = original = path.read_text(encoding="utf-8")
    own_slug = path.stem

    for slug, title in slug_title_map.items():
        if slug == own_slug:
            continue
        # Case-insensitive: already present as a wikilink?
        if re.search(rf"\[\[{re.escape(slug)}[\]|]", content, re.IGNORECASE):
            continue
        if title and re.search(rf"\[\[{re.escape(title)}[\]|]", content, re.IGNORECASE):
            continue
        for term in dict.fromkeys([title, slug]):
            if not term:
                continue
            # Don't match inside existing [[...]]:
            # lookbehind prevents match after [ or | (= inside a link)
            pattern = rf"(?i)(?<![|\[])\b({re.escape(term)})\b(?!\])(?!\|)"
            if re.search(pattern, content):
                content = re.sub(pattern, rf"[[{slug}|\1]]", content, count=1)
                break

    if content != original:
        path.write_text(content, encoding="utf-8")
        return True
    return False


def _backfill_wikilinks(new_slug: str, new_title: str, wiki_base: Path) -> None:
    """Scans ALL existing pages for mentions of the new page.

    Called when a new wiki page is created so that already existing articles
    automatically link to the new page.
    """
    partial_map = {new_slug: new_title}
    for f in wiki_base.rglob("*.md"):
        if f.stem == new_slug:
            continue
        _inject_links_into_page(f, partial_map)


def _apply_diff(changed: list[str], deleted: list[str]) -> str:
    """Re-embed changed pages and purge deleted pages from graph + vectors."""
    if not changed and not deleted:
        return "no_changes"

    wiki_base = Path(settings.VAULT_PATH) / "1_knowledge" / "wiki"

    if changed:
        pages = []
        for slug in changed:
            path = wiki_base / f"{slug}.md"
            if path.exists():
                pages.append((slug, _read_title(path), path.read_text(encoding="utf-8")))
        if pages:
            _update_graph_and_vectors(pages)

    if deleted:
        graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
        vector_store = QdrantStore(settings.QDRANT_URL)
        try:
            for slug in deleted:
                graph.delete_page_node(slug)
                vector_store.delete(WIKI_COLLECTION, _slug_to_uuid(slug))
        finally:
            graph.close()

    return f"ok:+{len(changed)}/-{len(deleted)}"


def _update_graph_and_vectors(updated_pages: list[tuple[str, str, str]]) -> None:
    """Writes nodes + edges to Neo4j and embeddings to Qdrant."""
    embedder = get_embedder()
    vector_store = QdrantStore(settings.QDRANT_URL)
    graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
    try:
        for slug, title, page_md in updated_pages:
            vault_path = f"1_knowledge/wiki/{slug}.md"

            # Graph: page node
            graph.upsert_page_node(slug, title, "wiki", vault_path)

            # Graph: edges from [[wikilinks]]
            for linked in _parse_wikilinks(page_md):
                target = slugify(linked)
                if target and target != slug:
                    graph.upsert_edge(slug, target)

            # Vector embedding
            vec = embedder.embed(page_md[:2000])
            vector_store.upsert(
                WIKI_COLLECTION,
                vec,
                {"slug": slug, "title": title, "type": "wiki", "vault_path": vault_path},
                point_id=_slug_to_uuid(slug),
            )
    finally:
        graph.close()


def _find_candidates(content: str, wiki_base: Path) -> list[dict[str, Any]]:
    """Finds relevant wiki pages via Qdrant search."""
    embedder = get_embedder()
    vector_store = QdrantStore(settings.QDRANT_URL)
    try:
        vec = embedder.embed(content[:2000])
        hits = vector_store.search(WIKI_COLLECTION, vec, limit=8)
        candidates = []
        for hit in hits:
            slug = hit.get("slug", "")
            title = hit.get("title", slug)
            wiki_path = wiki_base / f"{slug}.md"
            if wiki_path.exists():
                preview = wiki_path.read_text(encoding="utf-8")[:300]
                candidates.append({"slug": slug, "title": title, "preview": preview})
        return candidates
    except Exception as exc:
        logger.warning("Candidate search failed (Qdrant empty?): %s", exc)
        return []


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

@celery_app.task(name="second_brain.worker.tasks.process_ingestion", bind=True)  # type: ignore[untyped-decorator]
def process_ingestion(self: Any, content: str, _metadata: dict[str, Any] | None = None) -> str:
    task_id: str = self.request.id or "unknown"
    _log_start(task_id, content)

    try:
        return _process_ingestion_inner(task_id, content)
    except Exception as exc:
        _log_failed(task_id, str(exc))
        raise


def _process_ingestion_inner(task_id: str, content: str) -> str:
    wiki_base = Path(settings.VAULT_PATH) / "1_knowledge" / "wiki"
    wiki_base.mkdir(parents=True, exist_ok=True)

    # 1. Split input into independent topics
    topics = _run_async(split_into_topics(content))
    logger.info("Split input into %d topic(s)", len(topics))

    # updated_pages as dict (slug → tuple) so later topics can overwrite pages
    # already updated by earlier topics
    updated_pages_map: dict[str, tuple[str, str, str]] = {}
    created_slugs: set[str] = set()
    # slug → {slug, title, changes/preview} for the log
    log_updated: dict[str, dict[str, Any]] = {}
    log_created: dict[str, dict[str, Any]] = {}

    for topic in topics:
        # 2. Find relevant pages (reads current disk state)
        candidates = _find_candidates(topic, wiki_base)

        # 3. Planning agent
        plan: WikiEditPlan = _run_async(plan_wiki_edits(topic, candidates))

        if not plan.updates and not plan.new_pages:
            logger.warning("Planning agent found no changes for topic '%s...'", topic[:40])
            continue

        # 4. Update existing pages
        for item in plan.updates:
            slug = item.get("slug", "")
            title = item.get("title", slug)
            if not slug:
                continue
            wiki_path = wiki_base / f"{slug}.md"
            existing = wiki_path.read_text(encoding="utf-8") if wiki_path.exists() else ""
            updated_md = _run_async(update_wiki_page(title, topic, existing))
            wiki_path.write_text(updated_md, encoding="utf-8")
            logger.info("Updated wiki page: %s", slug)
            updated_pages_map[slug] = (slug, title, updated_md)
            diff = _page_diff_summary(existing, updated_md)
            log_updated[slug] = {"slug": slug, "title": title, "changes": diff}

        # 5. Create new pages
        for item in plan.new_pages:
            title = item.get("title", "")
            if not title:
                continue
            slug = slugify(title)
            wiki_path = wiki_base / f"{slug}.md"
            existing = wiki_path.read_text(encoding="utf-8") if wiki_path.exists() else ""
            updated_md = _run_async(update_wiki_page(title, topic, existing))
            wiki_path.write_text(updated_md, encoding="utf-8")
            logger.info("Created new wiki page: %s", slug)
            updated_pages_map[slug] = (slug, title, updated_md)
            created_slugs.add(slug)
            diff = _page_diff_summary("", updated_md)
            log_created[slug] = {"slug": slug, "title": title, "preview": diff}

    updated_pages = list(updated_pages_map.values())

    if not updated_pages:
        _log_done(task_id, [], [])
        return "no_changes"

    # 5. Deterministically inject wikilinks
    slug_title_map = _build_slug_title_map(wiki_base)

    new_slugs = {slug for slug, _, _ in updated_pages}
    existing_slugs = set(slug_title_map.keys()) - new_slugs

    # 5a. Forward: scan updated pages for all known titles
    for slug, _, _ in updated_pages:
        _inject_links_into_page(wiki_base / f"{slug}.md", slug_title_map)

    # 5b. Backward: link existing pages to newly created pages
    for slug, title, _ in updated_pages:
        if slug not in existing_slugs:  # only backfill genuinely new pages
            _backfill_wikilinks(slug, title, wiki_base)

    # 5c. Re-read so injected links land in the embedding
    updated_pages = [
        (s, t, (wiki_base / f"{s}.md").read_text(encoding="utf-8"))
        for s, t, _ in updated_pages
    ]

    # 6. Graph + embeddings
    _update_graph_and_vectors(updated_pages)

    _log_done(task_id, list(log_updated.values()), list(log_created.values()))

    return f"ok:{len(updated_pages)}_pages"


@celery_app.task(name="second_brain.worker.tasks.wiki_review_hourly")  # type: ignore[untyped-decorator]
def wiki_review_hourly() -> str:
    graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
    try:
        deleted = graph.delete_ghost_nodes()
        if deleted:
            logger.info("Deleted %d ghost node(s) from graph", deleted)
    finally:
        graph.close()

    wiki_base = Path(settings.VAULT_PATH) / "1_knowledge" / "wiki"
    if not wiki_base.exists():
        return "no_wiki"

    pages = list(wiki_base.rglob("*.md"))
    if not pages:
        return "empty_wiki"

    all_content = {p.stem: p.read_text(encoding="utf-8") for p in pages}

    # Orphans: pages with no incoming links — prioritise these
    orphans = [
        slug for slug, _ in all_content.items()
        if not any(
            f"[[{slug}]]" in other or f"[[{slug}|" in other
            for other_slug, other in all_content.items()
            if other_slug != slug
        )
    ]

    # Seed: random orphan, otherwise oldest page
    if orphans:
        seed_slug = random.choice(orphans)
    else:
        seed_slug = sorted(pages, key=lambda p: p.stat().st_mtime)[0].stem

    # Cluster: semantically similar pages via Qdrant
    cluster_slugs: set[str] = {seed_slug}
    try:
        embedder = get_embedder()
        vector_store = QdrantStore(settings.QDRANT_URL)
        vec = embedder.embed(all_content[seed_slug][:2000])
        hits = vector_store.search(WIKI_COLLECTION, vec, limit=REVIEW_SAMPLE_SIZE)
        for hit in hits:
            slug = hit.get("slug", "")
            if slug and slug in all_content:
                cluster_slugs.add(slug)
    except Exception as exc:
        logger.warning("Cluster search failed, using seed page only: %s", exc)

    logger.info("Wiki review cluster: %s", list(cluster_slugs))
    page_data = [(slug, all_content[slug]) for slug in cluster_slugs]
    updates = _run_async(review_wiki_pages(page_data))

    if not updates:
        logger.info("Wiki review: no improvements needed.")
        return "no_changes"

    updated_pages: list[tuple[str, str, str]] = []
    for slug, updated_md in updates:
        wiki_path = wiki_base / f"{slug}.md"
        if not wiki_path.exists():
            logger.warning("Review tried to update non-existent page: %s", slug)
            continue
        wiki_path.write_text(updated_md, encoding="utf-8")
        title = slug.replace("-", " ").title()
        updated_pages.append((slug, title, updated_md))
        logger.info("Wiki review: improved %s", slug)

    if updated_pages:
        _update_graph_and_vectors(updated_pages)

    return f"ok:{len(updated_pages)}_improved"


@celery_app.task(name="second_brain.worker.tasks.git_sync_daily")  # type: ignore[untyped-decorator]
def git_sync_daily() -> str:
    get_git_sync().push("chore: daily vault sync")
    return "ok:git_sync_daily"


@celery_app.task(name="second_brain.worker.tasks.reindex_after_pull")  # type: ignore[untyped-decorator]
def reindex_after_pull() -> str:
    """Pull vault from Git and re-embed only changed/deleted wiki pages."""
    changed, deleted = get_git_sync().pull_and_diff()
    return _apply_diff(changed, deleted)


@celery_app.task(name="second_brain.worker.tasks.reindex_all_wiki")  # type: ignore[untyped-decorator]
def reindex_all_wiki() -> str:
    """Re-embed all wiki pages — used after a fresh clone or full DB reset."""
    wiki_base = Path(settings.VAULT_PATH) / "1_knowledge" / "wiki"
    if not wiki_base.exists():
        return "no_wiki"
    slugs = [f.stem for f in wiki_base.rglob("*.md")]
    logger.info("Full reindex: %d wiki pages", len(slugs))
    return _apply_diff(slugs, [])
