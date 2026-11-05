"""OpenRouter LLM client — implements the generic LLMClient interface."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.llm.base import LLMClient, LLMError
from second_brain.llm.providers.openrouter.routing import provider_routing

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

_BASE_URL = "https://openrouter.ai/api/v1"
_RETRY_DELAYS = (1.0, 3.0, 9.0)


class OpenRouterError(LLMError):
    pass


class OpenRouterClient(LLMClient):
    def __init__(self) -> None:
        if not settings.OPENROUTER_API_KEY:
            raise OpenRouterError("OPENROUTER_API_KEY is not set.")
        self._headers = {
            "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }

    async def complete(
        self,
        system: str,
        user: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> str:
        provider: str = kwargs.get("provider", "") or settings.OPENROUTER_CHAT_PROVIDER
        payload = {
            "model": model or settings.DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            **provider_routing(provider),
        }
        return await self._post_with_retry(payload)

    async def chat_json(
        self,
        system: str,
        user: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> Any:
        provider: str = kwargs.get("provider", "") or settings.OPENROUTER_CHAT_PROVIDER
        payload = {
            "model": model or settings.DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            **provider_routing(provider),
        }
        raw = await self._post_with_retry(payload)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise OpenRouterError(f"Invalid JSON from LLM: {raw[:200]}") from exc

    async def _post_with_retry(self, payload: dict[str, Any]) -> str:
        with tracer.start_as_current_span("openrouter.post_with_retry") as root_span:
            root_span.set_attribute("model", str(payload.get("model", "")))
            last_exc: Exception | None = None
            for attempt, delay in enumerate((*_RETRY_DELAYS, None), start=1):
                with tracer.start_as_current_span("openrouter.attempt") as span:
                    span.set_attribute("attempt", attempt)
                    try:
                        async with httpx.AsyncClient(timeout=60.0) as client:
                            with tracer.start_as_current_span(
                                "openrouter.http_request"
                            ) as rs:
                                resp = await client.post(
                                    f"{_BASE_URL}/chat/completions",
                                    headers=self._headers,
                                    json=payload,
                                )
                                rs.set_attribute("http.status_code", resp.status_code)
                        with tracer.start_as_current_span("openrouter.parse_response"):
                            resp.raise_for_status()
                            data = resp.json()
                            content = str(data["choices"][0]["message"]["content"])
                        return content
                    except Exception as exc:
                        last_exc = exc
                        span.record_exception(exc)
                        logger.warning("OpenRouter attempt %d failed: %s", attempt, exc)
                if delay is not None:
                    with tracer.start_as_current_span("openrouter.retry_backoff") as span:
                        span.set_attribute("delay_seconds", delay)
                        await asyncio.sleep(delay)
            raise OpenRouterError(
                f"All {len(_RETRY_DELAYS) + 1} attempts failed."
            ) from last_exc
