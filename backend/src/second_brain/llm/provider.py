from typing import Any


def provider_routing(name: str) -> dict[str, Any]:
    """Pins a request to a specific OpenRouter provider, with fallback.

    See https://openrouter.ai/docs/features/provider-routing
    """
    if not name:
        return {}
    return {"provider": {"order": [name], "allow_fallbacks": True}}
