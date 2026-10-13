"""Provider failures keep useful diagnostics without retaining private text."""

import asyncio
import logging
import traceback
from contextlib import suppress
from typing import Any

import httpx
import pytest
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON

from second_brain.core.config import settings
from second_brain.llm.providers.openrouter import client as module
from second_brain.llm.providers.openrouter.client import OpenRouterClient, OpenRouterError

PRIVATE = "synthetic-private-provider-echo"


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> OpenRouterClient:
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "synthetic-key")
    monkeypatch.setattr(module, "_RETRY_DELAYS", (0.0, 0.0, 0.0))
    return OpenRouterClient()


def install_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Any, tracing: TracerProvider | None = None
) -> list[httpx.AsyncClient]:
    real_client = httpx.AsyncClient
    clients: list[httpx.AsyncClient] = []

    def local_client(**kwargs: Any) -> httpx.AsyncClient:
        client = real_client(transport=httpx.MockTransport(handler), **kwargs)
        if tracing is not None:
            # Global instrumentation wraps the default transport only. Wrap the
            # synthetic transport explicitly through the same public API.
            HTTPXClientInstrumentor.instrument_client(client, tracer_provider=tracing)
        clients.append(client)
        return client

    monkeypatch.setattr(httpx, "AsyncClient", local_client)
    return clients


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["http", "transport", "json"])
async def test_failures_redact_logs_traces_and_exception_chain(
    provider: OpenRouterClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
) -> None:
    attempts = 0

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if failure == "transport":
            raise httpx.ReadError(PRIVATE, request=request)
        if failure == "json":
            return httpx.Response(200, text=PRIVATE)
        return httpx.Response(
            503, text=PRIVATE, extensions={"reason_phrase": PRIVATE.encode()}
        )

    exporter = InMemorySpanExporter()
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")
    tracing = TracerProvider(sampler=ALWAYS_ON)
    tracing.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(module, "tracer", tracing.get_tracer("provider-test"))
    # Production can enable global HTTPX instrumentation. It must not add raw
    # transport exceptions alongside the client's deliberately bounded spans.
    instrumentation = HTTPXClientInstrumentor()
    instrumentation.instrument(tracer_provider=tracing)
    try:
        install_transport(monkeypatch, response, tracing)
        # A positive control proves HTTPX tracing is active for this transport;
        # an empty export must not accidentally satisfy the privacy check.
        async with httpx.AsyncClient() as control:
            with suppress(httpx.ReadError):
                await control.post("https://provider.invalid/chat")
        assert any(span.name == "POST" for span in exporter.get_finished_spans())
        exporter.clear()
        attempts = 0
        with caplog.at_level(logging.INFO), pytest.raises(OpenRouterError) as caught:
            await provider.tool_chat([{"role": "user", "content": PRIVATE}], [])
        rendered = "".join(traceback.format_exception(caught.value))
        spans = exporter.get_finished_spans()
        diagnostics = "".join(span.to_json() for span in spans)
        assert PRIVATE not in caplog.text + rendered + diagnostics
        assert attempts == 4
        assert "All 4 attempts failed" in str(caught.value)
        expected_type = {
            "http": "HTTPStatusError", "transport": "ReadError", "json": "JSONDecodeError"
        }[failure]
        assert expected_type in caplog.text
        assert len([span for span in spans if span.name == "openrouter.attempt"]) == 4
        assert not any(span.name == "POST" for span in spans)
    finally:
        instrumentation.uninstrument()
        tracing.shutdown()


@pytest.mark.asyncio
async def test_retry_recovers_and_keeps_structured_response(
    provider: OpenRouterClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempts = 0
    expected = {"content": None, "tool_calls": [{"id": "read-1"}]}

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        assert request.headers["authorization"] == "Bearer synthetic-key"
        if attempts == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"choices": [{"message": expected}]})

    clients = install_transport(monkeypatch, response)
    assert await provider.tool_chat([{"role": "user", "content": "Hello"}], []) == expected
    assert attempts == 2
    assert all(client.is_closed for client in clients)


@pytest.mark.asyncio
async def test_invalid_json_does_not_include_model_answer(
    provider: OpenRouterClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": PRIVATE}}]})

    clients = install_transport(monkeypatch, response)
    with pytest.raises(OpenRouterError) as caught:
        await provider.chat_json("system", "user")
    assert PRIVATE not in "".join(traceback.format_exception(caught.value))
    assert all(client.is_closed for client in clients)


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["request", "backoff"])
async def test_cancellation_closes_request_without_another_retry(
    provider: OpenRouterClient, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    started, stopped = asyncio.Event(), asyncio.Event()
    attempts = 0
    real_sleep = asyncio.sleep

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if phase == "request":
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        return httpx.Response(503)

    async def held_backoff(delay: float) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    clients = install_transport(monkeypatch, response)
    if phase == "backoff":
        monkeypatch.setattr(asyncio, "sleep", held_backoff)
    task = asyncio.create_task(provider.tool_chat([{"role": "user", "content": "Hi"}], []))
    try:
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        await real_sleep(0)
        assert stopped.is_set()
        assert attempts == 1
        assert len(clients) == 1 and clients[0].is_closed
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_httpx_log_suppression_does_not_mute_concurrent_requests(
    provider: OpenRouterClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    started, release = asyncio.Event(), asyncio.Event()

    async def response(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openrouter.ai":
            started.set()
            await release.wait()
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Hello"}}]},
                extensions={"reason_phrase": PRIVATE.encode()},
            )
        return httpx.Response(200)

    clients = install_transport(monkeypatch, response)
    with caplog.at_level(logging.INFO):
        task = asyncio.create_task(provider.tool_chat([{"role": "user", "content": "Hi"}], []))
        try:
            await asyncio.wait_for(started.wait(), 2)
            async with httpx.AsyncClient() as ordinary:
                await ordinary.get("https://ordinary.invalid/health")
            release.set()
            assert (await asyncio.wait_for(task, 2))["content"] == "Hello"
            # The same task's context is restored after the provider returns.
            assert (await provider.tool_chat([{"role": "user", "content": "Hi"}], []))[
                "content"
            ] == "Hello"
            async with httpx.AsyncClient() as after:
                await after.get("https://ordinary.invalid/after")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert PRIVATE not in caplog.text
    assert "ordinary.invalid/health" in caplog.text
    assert "ordinary.invalid/after" in caplog.text
    assert all(client.is_closed for client in clients)
