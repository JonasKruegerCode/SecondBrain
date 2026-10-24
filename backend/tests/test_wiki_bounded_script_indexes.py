"""Same-content old receipt invalidation; adapters are deliberate local doubles."""

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.index_config import configured_indexes
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiError, WikiStore


class Adapter:
    def __init__(self) -> None:
        self.snapshots: dict[str, Any] = {}
        self.fail = False

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("synthetic provider failure")
        self.snapshots[generation] = snapshot

    def neighbors(self, generation: str, seeds: list[str], hops: int, limit: int) -> list[str]:
        return [
            e["target"]
            for e in self.snapshots[generation]["graph"]["edges"]
            if e["source"] in seeds
        ][:limit]

    def search(self, generation: str, query: str, limit: int) -> list[dict[str, Any]]:
        return [
            {"id": p["id"], "revision": p["revision"], "score": 1.0}
            for p in self.snapshots[generation]["pages"]
        ][:limit]


def test_script_projection_invalidates_both_old_receipts_at_same_head(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GRAPH_INDEX", "0")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_VECTOR_INDEX", "0")
    store = WikiStore(tmp_path)
    store.save_page(
        "home", "# Home\nNote <script>hidden [[target]]</script> [[visible]].", None, "home"
    )
    store.save_page("target", "# Target", None, "target")
    store.save_page("visible", "# Visible", None, "visible")
    before = store.snapshot()
    history = store.history("home")
    adapters = {"graph": Adapter(), "vector": Adapter()}
    old_id = hashlib.sha256(
        json.dumps({"schema": "managed-snapshots-v35"}, sort_keys=True).encode()
    ).hexdigest()
    old = IndexCoordinator(store, adapters, config_id=old_id)
    old.run_once()
    receipts = {kind: old._receipt(kind) for kind in adapters}
    current = configured_indexes(store)
    current.adapters = adapters
    assert current.config_id != old_id
    for kind in adapters:
        assert current.status()["indexes"][kind]["state"] == "pending"
    for read in (lambda: current.neighbors(["home"]), lambda: current.semantic_search("Home")):
        with pytest.raises(WikiError) as error:
            read()
        assert error.value.code == "index_pending"
    adapters["vector"].fail = True
    current.run_once()
    assert current.status()["indexes"]["graph"]["state"] == "current"
    assert current.status()["indexes"]["vector"]["state"] == "error"
    with pytest.raises(WikiError) as error:
        current.semantic_search("Home")
    assert error.value.code == "index_pending"
    adapters["vector"].fail = False
    current.run_once()
    assert [p["id"] for p in current.neighbors(["home"])["pages"]] == ["visible"]
    assert current.semantic_search("Home")["results"]
    for kind in adapters:
        assert current._receipt(kind)["generation"] != receipts[kind]["generation"]
        assert current._receipt(kind)["revision"] == before["revision"]
    assert store.snapshot() == before
    assert store.history("home") == history
