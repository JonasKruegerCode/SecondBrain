"""
Derived-index maintenance: Neo4j graph + Qdrant vectors + wikilink injection.

The wiki (Markdown files in the vault) is the source of truth. Everything in
this module derives graph nodes/edges and embeddings from it, or performs
deterministic link maintenance on the Markdown itself.
"""
from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path

from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.llm.embedder import get_embedder
from second_brain.memory.graph import Neo4jStore
from second_brain.memory.vector import QdrantStore

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

WIKI_COLLECTION = "wiki_pages"


def wiki_base_path() -> Path:
    return Path(settings.VAULT_PATH) / "1_knowledge" / "wiki"


def slugify(title: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", title.lower()).strip()
    return re.sub(r"[\s_]+", "-", slug)


def slug_to_uuid(slug: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, slug))


def parse_wikilinks(markdown: str) -> list[str]:
    # Handles [[slug]] and [[slug|DisplayText]] — always returns the slug part
    return [m.split("|")[0].strip() for m in re.findall(r"\[\[([^\]]+)\]\]", markdown)]


def read_title(path: Path) -> str:
    """Reads the first # heading from a Markdown file as the title."""
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return path.stem


def build_slug_title_map(wiki_base: Path) -> dict[str, str]:
    """slug → title (from first # heading) for all wiki pages."""
    result = {}
    for f in wiki_base.rglob("*.md"):
        result[f.stem] = read_title(f)
    return result


def inject_links_into_text(content: str, own_slug: str, slug_title_map: dict[str, str]) -> str:
    """Scans text for title mentions and injects [[slug]] links.

    Matches the title (prose) and the slug — slug is used as link target
    so links always point to actually existing pages.
    """
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
    return content


def inject_links_into_page(path: Path, slug_title_map: dict[str, str]) -> bool:
    """File-level wrapper around inject_links_into_text. Returns True if changed."""
    if not path.exists():
        return False
    original = path.read_text(encoding="utf-8")
    content = inject_links_into_text(original, path.stem, slug_title_map)
    if content != original:
        path.write_text(content, encoding="utf-8")
        return True
    return False


def backfill_wikilinks(new_slug: str, new_title: str, wiki_base: Path) -> list[str]:
    """Scans ALL existing pages for mentions of the new page.

    Called when a new wiki page is created so that already existing articles
    automatically link to the new page. Returns the slugs of changed pages.
    """
    partial_map = {new_slug: new_title}
    changed: list[str] = []
    for f in wiki_base.rglob("*.md"):
        if f.stem == new_slug:
            continue
        if inject_links_into_page(f, partial_map):
            changed.append(f.stem)
    return changed


def update_graph_and_vectors(updated_pages: list[tuple[str, str, str]]) -> None:
    """Writes nodes + edges to Neo4j and embeddings to Qdrant.

    Two-pass graph write: all nodes first, then all edges. This ensures
    upsert_edge (which uses MATCH) can find target nodes even when source
    and target are both part of the same batch (e.g. full reindex).
    """
    with tracer.start_as_current_span("indexing.update_graph_and_vectors") as span:
        span.set_attribute("pages", len(updated_pages))
        embedder = get_embedder()
        vector_store = QdrantStore(settings.QDRANT_URL)
        graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
        try:
            # Pass 1: nodes + vectors
            for slug, title, page_md in updated_pages:
                vault_path = f"1_knowledge/wiki/{slug}.md"
                graph.upsert_page_node(slug, title, "wiki", vault_path)
                vec = embedder.embed(page_md[:2000])
                vector_store.upsert(
                    WIKI_COLLECTION,
                    vec,
                    {"slug": slug, "title": title, "type": "wiki", "vault_path": vault_path},
                    point_id=slug_to_uuid(slug),
                )

            # Pass 2: edges — build a lookup so wikilinks like [[Python]] resolve
            # to the correct slug even when the node ID is [[topic-python]].
            all_nodes = graph.execute_query(
                "MATCH (n:WikiPage) RETURN n.id AS id, n.title AS title"
            )
            slug_lookup: dict[str, str] = {}
            for row in all_nodes:
                node_id = row.get("id", "")
                title = row.get("title", "")
                if node_id:
                    slug_lookup[node_id] = node_id
                    slug_lookup[slugify(node_id)] = node_id
                    if title:
                        slug_lookup[title.lower()] = node_id
                        slug_lookup[slugify(title)] = node_id

            for slug, _, page_md in updated_pages:
                for linked in parse_wikilinks(page_md):
                    target = (
                        slug_lookup.get(linked)
                        or slug_lookup.get(slugify(linked))
                        or slug_lookup.get(linked.lower())
                    )
                    if target and target != slug:
                        graph.upsert_edge(slug, target)
        finally:
            graph.close()


def apply_index_diff(changed: list[str], deleted: list[str]) -> str:
    """Re-embed changed pages and purge deleted pages from graph + vectors."""
    if not changed and not deleted:
        return "no_changes"

    wiki_base = wiki_base_path()

    if changed:
        pages = []
        for slug in changed:
            path = wiki_base / f"{slug}.md"
            if path.exists():
                pages.append((slug, read_title(path), path.read_text(encoding="utf-8")))
        if pages:
            update_graph_and_vectors(pages)

    if deleted:
        graph = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
        vector_store = QdrantStore(settings.QDRANT_URL)
        try:
            for slug in deleted:
                graph.delete_page_node(slug)
                vector_store.delete(WIKI_COLLECTION, slug_to_uuid(slug))
        finally:
            graph.close()

    return f"ok:+{len(changed)}/-{len(deleted)}"
