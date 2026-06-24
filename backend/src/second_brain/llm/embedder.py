"""Embedder factory.

Import ``get_embedder()`` to obtain a provider-agnostic embedder.
The concrete implementation is selected by ``settings.LLM_PROVIDER``.

Backward-compat re-exports
--------------------------
``OpenRouterEmbedder`` is still importable from here during migration.
"""
from second_brain.core.config import settings
from second_brain.llm.base import LLMEmbedder
from second_brain.llm.providers.openrouter.embedder import OpenRouterEmbedder

__all__ = ["get_embedder", "LLMEmbedder", "OpenRouterEmbedder"]

_instance: LLMEmbedder | None = None


def get_embedder() -> LLMEmbedder:
    """Return a cached embedder instance for the configured provider."""
    global _instance
    if _instance is None:
        if settings.LLM_PROVIDER == "gcp":
            from second_brain.llm.providers.gcp.embedder import GCPEmbedder  # noqa: PLC0415
            _instance = GCPEmbedder()
        else:
            _instance = OpenRouterEmbedder()
    return _instance
