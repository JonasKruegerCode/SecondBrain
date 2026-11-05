"""GCP embedder — OpenAI-compatible embeddings endpoint with API-key auth.

Configure via environment variables:

  GCP_API_KEY          — required
  GCP_ENDPOINT_URL     — base URL (default: Gemini OpenAI-compat endpoint)
  EMBEDDING_MODEL      — model name for this provider (e.g. "text-embedding-004")
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.llm.base import LLMEmbedder

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)


class GCPEmbedder(LLMEmbedder):
    def __init__(self) -> None:
        if not settings.GCP_API_KEY:
            raise RuntimeError("GCP_API_KEY is not set.")
        self._base_url = settings.GCP_ENDPOINT_URL.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {settings.GCP_API_KEY}",
            "Content-Type": "application/json",
        }
        self._model = settings.EMBEDDING_MODEL
        logger.info("GCP Embedder initialized (model: %s)", self._model)

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        with tracer.start_as_current_span("embedder.embed_batch") as span:
            span.set_attribute("embedder.model", self._model)
            span.set_attribute("embedder.batch_size", len(texts))
            resp = httpx.post(
                f"{self._base_url}/embeddings",
                headers=self._headers,
                json={"model": self._model, "input": texts},
                timeout=30.0,
            )
            resp.raise_for_status()
            data = resp.json()
            raw: list[dict[str, Any]] = data["data"]
            # Gemini's OpenAI-compat endpoint omits "index"; only sort when present
            if raw and "index" in raw[0]:
                raw = sorted(raw, key=lambda x: x["index"])
            return [item["embedding"] for item in raw]
