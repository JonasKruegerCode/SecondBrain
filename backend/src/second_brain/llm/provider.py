"""Backward-compat shim — provider_routing moved to providers/openrouter/routing.py."""
from second_brain.llm.providers.openrouter.routing import provider_routing

__all__ = ["provider_routing"]
