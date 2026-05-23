import asyncio
import json
import logging
from typing import Any

import httpx

from second_brain.core.config import settings

logger = logging.getLogger(__name__)

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_RETRY_DELAYS = (1.0, 3.0, 9.0)


class OpenRouterError(Exception):
    pass


class OpenRouterClient:
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
    ) -> str:
        payload = {
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
    ) -> Any:
        payload = {
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
            raise OpenRouterError(f"Invalid JSON from LLM: {raw[:200]}") from exc

    async def _post_with_retry(self, payload: dict[str, Any]) -> str:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*_RETRY_DELAYS, None), start=1):
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    resp = await client.post(
                        f"{_OPENROUTER_BASE}/chat/completions",
                        headers=self._headers,
                        json=payload,
                    )
                resp.raise_for_status()
                data = resp.json()
                return str(data["choices"][0]["message"]["content"])
            except Exception as exc:
                last_exc = exc
                logger.warning("OpenRouter attempt %d failed: %s", attempt, exc)
                if delay is not None:
                    await asyncio.sleep(delay)
        raise OpenRouterError(f"All {len(_RETRY_DELAYS)+1} attempts failed.") from last_exc
