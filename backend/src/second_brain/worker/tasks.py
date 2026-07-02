"""
Celery tasks — thin entry points into the shared edit_vault agent.

process_ingestion   remember: split input into topics, run edit_vault per topic.
vault_repair_hourly repair: pick one page (orphans first, then oldest) and let
                    the same agent garden it (dedupe/merge, contradictions,
                    links, staleness).

The wiki is the source of truth; graph, vectors, and Git commits are handled
inside the agent's finalize step. The remaining tasks only sync derived
indexes after Git pulls.
"""
import asyncio
import json
import logging
import random
from datetime import datetime
from pathlib import Path
from typing import Any

from second_brain.agent.edit_vault import EditVaultResult, edit_vault, split_into_topics
from second_brain.core.celery_app import celery_app
from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.git_sync import get_git_sync
from second_brain.memory.graph import Neo4jStore
from second_brain.memory.indexing import (
    apply_index_diff,
    read_title,
    sync_vault,
    wiki_base_path,
)

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)


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
        "input_preview": content[:360],
        "input": content,
        "pages_updated": [],
        "pages_created": [],
        "error": None,
    })


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


def _run_async(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# remember — ingestion entry point
# ---------------------------------------------------------------------------

@celery_app.task(name="second_brain.worker.tasks.process_ingestion", bind=True)  # type: ignore[untyped-decorator]
def process_ingestion(self: Any, content: str, _metadata: dict[str, Any] | None = None) -> str:
    task_id: str = self.request.id or "unknown"
    # Sync bracket: pull before any work …
    sync_vault()
    _log_start(task_id, content)

    try:
        return _process_ingestion_inner(task_id, content)
    except Exception as exc:
        _log_failed(task_id, str(exc))
        raise
    finally:
        # … and ONE push at the very end, after the log reached its final
        # state (done/failed). Pushing earlier leaves the log "running"
        # forever on every other instance.
        get_git_sync().push(f"remember: {content[:120]}")


def _process_ingestion_inner(task_id: str, content: str) -> str:
    with tracer.start_as_current_span("ingestion.split_into_topics") as span:
        topics = _run_async(split_into_topics(content))
        span.set_attribute("topics", len(topics))
    logger.info("Split input into %d topic(s)", len(topics))

    log_updated: dict[str, dict[str, Any]] = {}
    log_created: dict[str, dict[str, Any]] = {}
    total_changed: set[str] = set()

    for topic in topics:
        with tracer.start_as_current_span("ingestion.topic") as topic_span:
            topic_span.set_attribute("topic.preview", topic[:80])
            result: EditVaultResult = _run_async(
                edit_vault("remember", topic, source=topic[:120])
            )
            for slug, diff in result.changed.items():
                total_changed.add(slug)
                page_path = wiki_base_path() / f"{slug}.md"
                title = read_title(page_path) if page_path.exists() else slug
                entry = {"slug": slug, "title": title, "changes": diff}
                if slug in result.created:
                    entry["preview"] = entry.pop("changes")
                    log_created[slug] = entry
                else:
                    log_updated[slug] = entry

    if not total_changed:
        _log_done(task_id, [], [])
        return "no_changes"

    _log_done(task_id, list(log_updated.values()), list(log_created.values()))
    return f"ok:{len(total_changed)}_pages"


# ---------------------------------------------------------------------------
# repair — hourly gardening entry point
# ---------------------------------------------------------------------------

def _pick_repair_seed(wiki_base: Path) -> str | None:
    """Orphans (no incoming links) first, otherwise the oldest page."""
    pages = list(wiki_base.rglob("*.md"))
    if not pages:
        return None

    all_content = {p.stem: p.read_text(encoding="utf-8") for p in pages}
    orphans = [
        slug for slug in all_content
        if not any(
            f"[[{slug}]]" in other or f"[[{slug}|" in other
            for other_slug, other in all_content.items()
            if other_slug != slug
        )
    ]
    if orphans:
        return random.choice(orphans)
    return sorted(pages, key=lambda p: p.stat().st_mtime)[0].stem


@celery_app.task(name="second_brain.worker.tasks.vault_repair_hourly")  # type: ignore[untyped-decorator]
def vault_repair_hourly() -> str:
    sync_vault()

    graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
    try:
        deleted = graph.delete_ghost_nodes()
        if deleted:
            logger.info("Deleted %d ghost node(s) from graph", deleted)
    finally:
        graph.close()

    wiki_base = wiki_base_path()
    if not wiki_base.exists():
        return "no_wiki"

    seed = _pick_repair_seed(wiki_base)
    if seed is None:
        return "empty_wiki"

    logger.info("Vault repair: gardening page '%s'", seed)
    try:
        result: EditVaultResult = _run_async(edit_vault("repair", seed, source=seed))
    finally:
        get_git_sync().push(f"repair: {seed}")
    if result.applied:
        logger.info("Vault repair applied: %s", result.applied)
    return result.result


# ---------------------------------------------------------------------------
# Git / index sync
# ---------------------------------------------------------------------------

@celery_app.task(name="second_brain.worker.tasks.git_sync_daily")  # type: ignore[untyped-decorator]
def git_sync_daily() -> str:
    """Daily pull + incremental reindex + push."""
    changed, deleted = get_git_sync().pull_and_diff()
    apply_index_diff(changed, deleted)
    get_git_sync().push("chore: daily vault sync")
    return "ok:git_sync_daily"


@celery_app.task(name="second_brain.worker.tasks.reindex_after_pull")  # type: ignore[untyped-decorator]
def reindex_after_pull() -> str:
    """Pull and reindex changed pages. Falls back to full reindex if DB is empty."""
    changed, deleted = get_git_sync().pull_and_diff()
    if not changed and not deleted:
        wiki_base = wiki_base_path()
        if wiki_base.exists():
            graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
            try:
                rows = graph.execute_query("MATCH (n:WikiPage) RETURN count(n) AS c")
                db_empty = not rows or rows[0].get("c", 0) == 0
            except Exception:
                db_empty = False
            finally:
                graph.close()
            if db_empty:
                slugs = [f.stem for f in wiki_base.rglob("*.md")]
                logger.info("DB empty, running full reindex: %d pages", len(slugs))
                return apply_index_diff(slugs, [])
    return apply_index_diff(changed, deleted)


@celery_app.task(name="second_brain.worker.tasks.reindex_all_wiki")  # type: ignore[untyped-decorator]
def reindex_all_wiki() -> str:
    """Full reindex from disk — the wiki files are the source of truth.

    Re-embeds every page AND purges graph/vector entries for pages that no
    longer exist on disk (renamed, merged, or deleted outside the app).
    """
    wiki_base = wiki_base_path()
    if not wiki_base.exists():
        return "no_wiki"
    slugs = [f.stem for f in wiki_base.rglob("*.md")]

    graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
    try:
        rows = graph.execute_query("MATCH (n:WikiPage) RETURN n.id AS id")
    finally:
        graph.close()
    indexed = {str(r["id"]) for r in rows if r.get("id")}
    stale = sorted(indexed - set(slugs))

    logger.info("Full reindex: %d wiki pages, purging %d stale nodes", len(slugs), len(stale))
    return apply_index_diff(slugs, stale)
