"""LLM client factory.

Import ``get_llm_client()`` to obtain a provider-agnostic client.
The concrete implementation is selected by ``settings.LLM_PROVIDER``.

Backward-compat re-exports
--------------------------
``OpenRouterClient`` and ``OpenRouterError`` are still importable from here
so that existing call sites don't break during a gradual migration.
"""
from second_brain.core.config import settings
from second_brain.llm.base import LLMClient

# Re-exports for backward compatibility
from second_brain.llm.providers.openrouter.client import OpenRouterClient, OpenRouterError

__all__ = ["get_llm_client", "LLMClient", "OpenRouterClient", "OpenRouterError"]


def get_llm_client() -> LLMClient:
    """Return the configured LLM client instance."""
    if settings.LLM_PROVIDER == "gcp":
        from second_brain.llm.providers.gcp.client import GCPClient  # noqa: PLC0415
        return GCPClient()
    return OpenRouterClient()
