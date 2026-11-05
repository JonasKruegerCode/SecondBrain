"""GCP LLM client — OpenAI-compatible endpoint with API-key auth.

Supports Google AI (Gemini) and any other GCP-hosted OpenAI-compatible
endpoint. Configure via environment variables:

  GCP_API_KEY          — required
  GCP_ENDPOINT_URL     — base URL (default: Gemini OpenAI-compat endpoint)
  DEFAULT_MODEL        — model name for this provider (e.g. "gemini-2.0-flash")
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer
from second_brain.llm.base import LLMClient, LLMError

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

_RETRY_DELAYS = (1.0, 3.0, 9.0)


class GCPError(LLMError):
    pass


class GCPClient(LLMClient):
    """OpenAI-compatible client for GCP / Google AI endpoints."""

    def __init__(self) -> None:
        if not settings.GCP_API_KEY:
            raise GCPError("GCP_API_KEY is not set.")
        self._base_url = settings.GCP_ENDPOINT_URL.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {settings.GCP_API_KEY}",
            "Content-Type": "application/json",
        }

    async def complete(
        self,
        system: str,
        user: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> str:
        payload: dict[str, Any] = {
            "model": model or settings.DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        return await self._post_with_retry(payload)

    async def chat_json(
        self,
        system: str,
        user: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> Any:
        payload: dict[str, Any] = {
            "model": model or settings.DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        raw = await self._post_with_retry(payload)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise GCPError(f"Invalid JSON from LLM: {raw[:200]}") from exc

    async def _post_with_retry(self, payload: dict[str, Any]) -> str:
        with tracer.start_as_current_span("gcp.post_with_retry") as root_span:
            root_span.set_attribute("model", str(payload.get("model", "")))
            last_exc: Exception | None = None
            for attempt, delay in enumerate((*_RETRY_DELAYS, None), start=1):
                with tracer.start_as_current_span("gcp.attempt") as span:
                    span.set_attribute("attempt", attempt)
                    try:
                        async with httpx.AsyncClient(timeout=60.0) as client:
                            with tracer.start_as_current_span("gcp.http_request") as rs:
                                resp = await client.post(
                                    f"{self._base_url}/chat/completions",
                                    headers=self._headers,
                                    json=payload,
                                )
                                rs.set_attribute("http.status_code", resp.status_code)
                        with tracer.start_as_current_span("gcp.parse_response"):
                            resp.raise_for_status()
                            data = resp.json()
                            content = str(data["choices"][0]["message"]["content"])
                        return content
                    except Exception as exc:
                        last_exc = exc
                        span.record_exception(exc)
                        logger.warning("GCP attempt %d failed: %s", attempt, exc)
                if delay is not None:
                    with tracer.start_as_current_span("gcp.retry_backoff") as span:
                        span.set_attribute("delay_seconds", delay)
                        await asyncio.sleep(delay)
            raise GCPError(
                f"All {len(_RETRY_DELAYS) + 1} attempts failed."
            ) from last_exc
