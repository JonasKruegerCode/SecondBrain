import logging
from pathlib import Path
from typing import Protocol

from second_brain.core.telemetry import get_tracer
from second_brain.llm.client import get_llm_client
from second_brain.memory.graph import Neo4jStore
from second_brain.memory.vault import FileSystemVault
from second_brain.memory.vector import QdrantStore

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

WIKI_COLLECTION = "wiki_pages"

_SYNTH_SYSTEM = """\
You are a knowledge assistant. Answer the query exclusively based on the
provided wiki pages. If the pages contain no relevant information, say so clearly.
Respond in the language of the query.
"""


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]:
        ...


class HybridRAG:
    def __init__(
        self,
        vector_store: QdrantStore,
        graph_store: Neo4jStore,
        vault_store: FileSystemVault,
        embedder: Embedder,
    ) -> None:
        self.vector_store = vector_store
        self.graph_store = graph_store
        self.vault_store = vault_store
        self.embedder = embedder

    async def retrieve_context(self, query: str, limit: int = 5) -> str:
        return await self._retrieve_async(query, limit)

    async def search(
        self, query: str, limit: int = 15, hpos: int = 0
    ) -> list[dict[str, object]]:
        """Hybrid vector search without LLM synthesis.

        Returns the top `limit` semantic hits as {id, title}. If `hpos` is 1 or 2,
        each hit also carries its direct (1) or 2-hop (2) graph neighbors as {id, title}.
        """
        with tracer.start_as_current_span("hybrid_rag.search") as root_span:
            root_span.set_attribute("query.length", len(query))
            root_span.set_attribute("query.limit", limit)
            root_span.set_attribute("query.hpos", hpos)

            with tracer.start_as_current_span("hybrid_rag.embed_query"):
                query_vec: list[float] = self.embedder.embed(query)

            with tracer.start_as_current_span("hybrid_rag.vector_search") as span:
                hits = self.vector_store.search(WIKI_COLLECTION, query_vec, limit=limit)
                span.set_attribute("hits", len(hits))

            results: list[dict[str, object]] = []
            for hit in hits:
                slug = hit.get("slug")
                if not slug:
                    continue
                entry: dict[str, object] = {"id": slug, "title": hit.get("title", slug)}
                if hpos in (1, 2):
                    try:
                        entry["neighbors"] = self.graph_store.get_neighbors_with_titles(
                            slug, hops=hpos
                        )
                    except Exception as exc:
                        logger.warning("Neo4j neighbor query failed for %s: %s", slug, exc)
                        entry["neighbors"] = []
                results.append(entry)
            return results

    async def _retrieve_async(self, query: str, limit: int) -> str:
        with tracer.start_as_current_span("hybrid_rag.retrieve_context") as root_span:
            root_span.set_attribute("query.length", len(query))
            root_span.set_attribute("query.limit", limit)

            # 1. Embed query
            with tracer.start_as_current_span("hybrid_rag.embed_query"):
                query_vec: list[float] = self.embedder.embed(query)

            # 2. Qdrant: semantically similar wiki pages
            with tracer.start_as_current_span("hybrid_rag.vector_search") as span:
                hits = self.vector_store.search(WIKI_COLLECTION, query_vec, limit=limit)
                span.set_attribute("hits", len(hits))
            seed_slugs = [h["slug"] for h in hits if "slug" in h]
            seed_paths = [h["vault_path"] for h in hits if "vault_path" in h]

            # 3. Neo4j: 2-hop neighbors
            neighbor_slugs: list[str] = []
            if seed_slugs:
                with tracer.start_as_current_span("hybrid_rag.graph_neighbors") as span:
                    try:
                        neighbor_slugs = self.graph_store.get_neighbors(seed_slugs, hops=2)
                        span.set_attribute("neighbors", len(neighbor_slugs))
                    except Exception as exc:
                        span.record_exception(exc)
                        logger.warning("Neo4j query failed: %s", exc)

            # 4. Collect all vault paths (deduplicated, max 10)
            neighbor_paths = [f"1_knowledge/wiki/{s}.md" for s in neighbor_slugs]
            all_paths = list(dict.fromkeys(seed_paths + neighbor_paths))[:10]

            # 5. Load Markdown
            with tracer.start_as_current_span("hybrid_rag.load_vault_pages") as span:
                wiki_contents: list[str] = []
                for path in all_paths:
                    content = self.vault_store.read_file(path)
                    if content:
                        wiki_contents.append(f"## {Path(path).stem}\n\n{content}")
                span.set_attribute("pages_loaded", len(wiki_contents))

            if not wiki_contents:
                return "No relevant wiki pages found."

            # 6. LLM synthesis
            context_block = "\n\n---\n\n".join(wiki_contents)
            user_prompt = f"Query: {query}\n\n---\n\n{context_block}"
            with tracer.start_as_current_span("hybrid_rag.llm_synthesis") as span:
                try:
                    client = get_llm_client()
                    return await client.complete(_SYNTH_SYSTEM, user_prompt)
                except Exception as exc:
                    span.record_exception(exc)
                    logger.error("LLM synthesis failed: %s", exc)
                    return f"Raw wiki contents (LLM unavailable):\n\n{context_block[:3000]}"
