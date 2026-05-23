import logging

import httpx

from second_brain.core.config import settings

logger = logging.getLogger(__name__)

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_instance: "OpenRouterEmbedder | None" = None


class OpenRouterEmbedder:
    def __init__(self) -> None:
        if not settings.OPENROUTER_API_KEY:
            raise RuntimeError("OPENROUTER_API_KEY is not set.")
        self._headers = {
            "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        self._model = settings.EMBEDDING_MODEL
        logger.info("OpenRouter Embedder initialized (model: %s)", self._model)

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        resp = httpx.post(
            f"{_OPENROUTER_BASE}/embeddings",
            headers=self._headers,
            json={"model": self._model, "input": texts},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        # Sorted by index in case the API doesn't guarantee order
        items = sorted(data["data"], key=lambda x: x["index"])
        return [item["embedding"] for item in items]


def get_embedder() -> OpenRouterEmbedder:
    global _instance
    if _instance is None:
        _instance = OpenRouterEmbedder()
    return _instance
