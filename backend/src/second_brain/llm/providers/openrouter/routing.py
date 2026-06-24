"""OpenRouter-specific provider routing helper.

Pins a request to a specific upstream provider via OpenRouter's
provider-routing feature, with automatic fallback.

See https://openrouter.ai/docs/features/provider-routing
"""
from typing import Any


def provider_routing(name: str) -> dict[str, Any]:
    """Return OpenRouter provider-routing extra fields, or {} if name is empty."""
    if not name:
        return {}
    return {"provider": {"order": [name], "allow_fallbacks": True}}
