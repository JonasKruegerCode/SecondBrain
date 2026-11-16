#!/usr/bin/env python3
"""Synthetic held chat for isolated proxy acceptance, never production."""

from __future__ import annotations

import asyncio
import os
from typing import Any

import uvicorn
from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiError, WikiStore
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

KEYS = frozenset({"proxy-cancel", "proxy-survivor", "proxy-retry"})


class HeldProvider:
    """Hold each invocation until explicitly released or cancelled."""

    def __init__(self) -> None:
        self.started: set[str] = set()
        self.cancelled: set[str] = set()
        self.finished: set[str] = set()
        self.pending: dict[str, list[asyncio.Event]] = {}

    async def tool_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int = 1200,
    ) -> dict[str, Any]:
        key = next(
            (m.get("content") for m in reversed(messages) if m.get("role") == "user"),
            None,
        )
        if not isinstance(key, str) or key not in KEYS:
            raise WikiError("chat_unavailable", "Unknown synthetic acceptance request.")
        released = asyncio.Event()
        self.pending.setdefault(key, []).append(released)
        self.started.add(key)
        try:
            await released.wait()
            return {"content": f"Synthetic acceptance answer: {key}", "tool_calls": []}
        except asyncio.CancelledError:
            self.cancelled.add(key)
            raise
        finally:
            self.pending[key].remove(released)
            if not self.pending[key]:
                del self.pending[key]
            self.finished.add(key)

    async def control(self, request: Request) -> JSONResponse:
        if request.method == "POST":
            try:
                body = await request.json()
            except (ValueError, UnicodeDecodeError) as exc:
                raise WikiError("invalid_payload", "Provide a JSON release request.") from exc
            if (
                not isinstance(body, dict)
                or set(body) != {"release"}
                or not isinstance(body["release"], str)
                or body["release"] not in KEYS
            ):
                raise WikiError("invalid_payload", "Provide a known synthetic release key.")
            for released in self.pending.get(body["release"], []):
                released.set()
        return JSONResponse(
            {
                "started": sorted(self.started),
                "cancelled": sorted(self.cancelled),
                "finished": sorted(self.finished),
            }
        )


def main() -> None:
    path = os.environ.get("SECOND_BRAIN_WIKI_VAULT")
    if not path:
        raise RuntimeError("Set SECOND_BRAIN_WIKI_VAULT to an isolated acceptance vault.")
    store = WikiStore(path)
    indexes = IndexCoordinator(store)
    provider = HeldProvider()
    app = create_app(
        path,
        indexes=indexes,
        chat=WikiChat(store, indexes, provider),
        close_indexes=True,
        automatic_delivery=False,
    )
    app.routes.append(
        Route("/api/wiki/__acceptance/chat-control", provider.control, methods=["GET", "POST"])
    )
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
