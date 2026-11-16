"""Startup and shutdown release every owned resource on failure."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from second_brain.wiki import mcp as wiki_mcp
from second_brain.wiki.api import create_app
from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.delivery_runtime import DeliveryWorker
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


def test_index_close_continues_after_a_driver_close_failure(tmp_path: Path) -> None:
    driver, client = Mock(), Mock()
    error = RuntimeError("synthetic driver close")
    driver.close.side_effect = error
    indexes = IndexCoordinator(
        WikiStore(tmp_path / "vault"),
        {"graph": SimpleNamespace(driver=driver), "vector": SimpleNamespace(client=client)},
    )
    with pytest.raises(RuntimeError) as caught:
        indexes.close()
    assert caught.value is error
    client.close.assert_called_once_with()


def test_failed_worker_thread_start_can_stop_and_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    indexes = IndexCoordinator(WikiStore(tmp_path / "vault"))
    worker = DeliveryWorker(DeliveryCoordinator(indexes.store, indexes))
    with monkeypatch.context() as patch:
        patch.setattr(threading.Thread, "start", Mock(side_effect=RuntimeError("synthetic start")))
        with pytest.raises(RuntimeError, match="synthetic start"):
            worker.start()
    try:
        worker.stop()
        assert worker.status()["background_worker"]["state"] == "stopped"
        worker.start()
        assert worker.status()["background_worker"]["state"] == "running"
    finally:
        worker.stop()
        indexes.close()


@pytest.mark.parametrize("transport", ["rest", "mcp"])
@pytest.mark.parametrize("fault", ["start", "stop"])
def test_transport_lifespan_closes_owned_indexes_after_worker_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: str, transport: str
) -> None:
    indexes = IndexCoordinator(WikiStore(tmp_path / "vault"))
    close = Mock(wraps=indexes.close)
    monkeypatch.setattr(indexes, "close", close)
    monkeypatch.setattr(DeliveryWorker, "start", Mock())
    monkeypatch.setattr(DeliveryWorker, "stop", Mock())
    error = RuntimeError("synthetic lifecycle failure")
    monkeypatch.setattr(DeliveryWorker, fault, Mock(side_effect=error))
    app = (
        create_app(indexes.store.path, indexes=indexes, automatic_delivery=True, close_indexes=True)
        if transport == "rest"
        else wiki_mcp.create_http_app(
            indexes.store, indexes=indexes, automatic_delivery=True, close_indexes=True
        )
    )

    async def run() -> None:
        async with app.router.lifespan_context(app):
            assert fault != "start"

    with pytest.raises(RuntimeError) as caught:
        asyncio.run(run())
    assert caught.value is error
    close.assert_called_once_with()


def test_stdio_closes_owned_indexes_when_worker_stop_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from second_brain.wiki import index_config

    indexes = IndexCoordinator(WikiStore(tmp_path / "vault"))
    close = Mock(wraps=indexes.close)
    monkeypatch.setattr(indexes, "close", close)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_VAULT", str(indexes.store.path))
    monkeypatch.setenv("SECOND_BRAIN_WIKI_DELIVERY", "1")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_SYNC", "0")
    monkeypatch.setattr(index_config, "configured_indexes", Mock(return_value=indexes))
    monkeypatch.setattr(DeliveryWorker, "start", Mock())
    error = RuntimeError("synthetic stdio stop")
    monkeypatch.setattr(DeliveryWorker, "stop", Mock(side_effect=error))
    server = SimpleNamespace(run=Mock())
    monkeypatch.setattr(wiki_mcp, "create_mcp", Mock(return_value=server))
    with pytest.raises(RuntimeError) as caught:
        wiki_mcp.main()
    assert caught.value is error
    server.run.assert_called_once_with(transport="stdio")
    close.assert_called_once_with()
