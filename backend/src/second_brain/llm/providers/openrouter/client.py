"""OpenRouter LLM client — implements the generic LLMClient interface."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_http_instrumentation
from opentelemetry.trace import Status, StatusCode

from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.llm.base import LLMClient, LLMError
from second_brain.llm.providers.openrouter.routing import provider_routing

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

_BASE_URL = "https://openrouter.ai/api/v1"
_RETRY_DELAYS = (1.0, 3.0, 9.0)
_PROVIDER_REQUEST: ContextVar[bool] = ContextVar("openrouter_request", default=False)


class _ProviderLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # HTTPX INFO and HTTPcore DEBUG can include peer-controlled reason
        # phrases, headers and exception text. Other tasks retain their logs.
        return not _PROVIDER_REQUEST.get()


# Logger filters do not run on child records propagated to parent handlers.
# Attach to the actual HTTPcore transport emitters, not just its parent logger.
for _transport_logger in (
    "httpx",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
):
    logging.getLogger(_transport_logger).addFilter(_ProviderLogFilter())


@contextmanager
def _bounded_transport_logs() -> Iterator[None]:
    token = _PROVIDER_REQUEST.set(True)
    try:
        yield
    finally:
        _PROVIDER_REQUEST.reset(token)


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
        except json.JSONDecodeError:
            raise OpenRouterError("OpenRouter returned invalid model JSON.") from None

    async def tool_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int = 1200,
    ) -> dict[str, Any]:
        """Return one OpenAI-compatible assistant message, including tool calls."""
        payload = {
            "model": model or settings.DEFAULT_MODEL,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": max_tokens,
            **provider_routing(settings.OPENROUTER_CHAT_PROVIDER),
        }
        data = await self._post_json_with_retry(payload)
        try:
            choice = data["choices"][0]
            message = choice["message"]
            finish = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError) as exc:
            raise OpenRouterError("OpenRouter returned no assistant message.") from exc
        if not isinstance(message, dict):
            raise OpenRouterError("OpenRouter returned an invalid assistant message.")
        # A non-streaming generation must explicitly complete. Partial text or
        # even a parseable tool call can precede a token limit/provider failure.
        # Reject outside the transport retry loop: do not silently issue another
        # potentially billable generation or execute an unfinished tool batch.
        if finish not in ("stop", "tool_calls"):
            raise OpenRouterError("OpenRouter did not complete the assistant generation.")
        return message

    async def _post_with_retry(self, payload: dict[str, Any]) -> str:
        data = await self._post_json_with_retry(payload)
        try:
            return str(data["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as exc:
            raise OpenRouterError("OpenRouter returned no text response.") from exc

    async def _post_json_with_retry(self, payload: dict[str, Any]) -> dict[str, Any]:
        with tracer.start_as_current_span(
            "openrouter.post_with_retry", record_exception=False, set_status_on_exception=False
        ) as root_span:
            root_span.set_attribute("model", str(payload.get("model", "")))
            for attempt, delay in enumerate((*_RETRY_DELAYS, None), start=1):
                with tracer.start_as_current_span(
                    "openrouter.attempt", record_exception=False, set_status_on_exception=False
                ) as span:
                    span.set_attribute("attempt", attempt)
                    try:
                        # Automatic HTTPX spans may retain raw transport exceptions.
                        # Keep our bounded status/timing spans instead.
                        with suppress_http_instrumentation(), _bounded_transport_logs():
                            async with httpx.AsyncClient(timeout=60.0) as client:
                                with tracer.start_as_current_span(
                                    "openrouter.http_request",
                                    record_exception=False,
                                    set_status_on_exception=False,
                                ) as rs:
                                    resp = await client.post(
                                        f"{_BASE_URL}/chat/completions",
                                        headers=self._headers,
                                        json=payload,
                                    )
                                    rs.set_attribute("http.status_code", resp.status_code)
                        with tracer.start_as_current_span(
                            "openrouter.parse_response",
                            record_exception=False,
                            set_status_on_exception=False,
                        ):
                            resp.raise_for_status()
                            data = resp.json()
                            if not isinstance(data, dict):
                                raise OpenRouterError("OpenRouter returned an invalid response.")
                        return data
                    except Exception as exc:
                        error_type = type(exc).__name__
                        status = (
                            exc.response.status_code
                            if isinstance(exc, httpx.HTTPStatusError)
                            else 0
                        )
                        span.set_attribute("error.type", error_type)
                        span.set_attribute("http.status_code", status)
                        span.set_status(Status(StatusCode.ERROR))
                        logger.warning(
                            "OpenRouter attempt %d failed (%s, HTTP status %d)",
                            attempt, error_type, status,
                        )
                if delay is not None:
                    with tracer.start_as_current_span("openrouter.retry_backoff") as span:
                        span.set_attribute("delay_seconds", delay)
                        await asyncio.sleep(delay)
            root_span.set_status(Status(StatusCode.ERROR))
            raise OpenRouterError(f"All {len(_RETRY_DELAYS) + 1} attempts failed.") from None
