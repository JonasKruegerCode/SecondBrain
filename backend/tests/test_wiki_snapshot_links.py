from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.store import WikiStore


def test_empty_snapshot_has_no_revision(tmp_path: Path) -> None:
    snapshot = WikiStore(tmp_path).snapshot()
    assert snapshot["revision"] is None
    assert snapshot["pages"] == []
    assert snapshot["graph"]["revision"] is None
    assert snapshot["graph"]["edges"] == []


def test_snapshot_keeps_pages_and_graph_on_captured_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = WikiStore(tmp_path)
    original = store.save_page("home", "# Home\n[[old]]", None, "create")
    captured = store._head()
    writer = WikiStore(tmp_path)
    read_git: Callable[..., bytes] = store._git
    advanced = False

    def advance_after_tree_read(*args: str, **kwargs: Any) -> bytes:
        nonlocal advanced
        if args[0] == "cat-file" and not advanced:
            advanced = True
            writer.save_page("home", "# Changed\n[[new]]", original["revision"], "edit")
            writer.save_page("new", "# New", None, "new")
        return read_git(*args, **kwargs)

    monkeypatch.setattr(store, "_git", advance_after_tree_read)
    snapshot = store.snapshot()
    assert advanced
    assert snapshot["revision"] == snapshot["graph"]["revision"] == captured
    assert [(p["id"], p["title"], p["revision"]) for p in snapshot["pages"]] == [
        ("home", "Home", original["revision"])
    ]
    assert snapshot["pages"][0]["markdown"] == original["markdown"]
    assert snapshot["graph"]["missing_targets"] == [{"source": "home", "target": "old"}]
    assert writer.snapshot()["revision"] != captured


def test_graph_delegates_to_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = WikiStore(tmp_path)
    graph = {"revision": "captured"}
    monkeypatch.setattr(store, "snapshot", lambda: {"graph": graph})
    assert store.graph() is graph


def test_typed_relations_resolve_aliases_and_take_precedence(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("docker", "# Container Engine", None, "docker")
    markdown = (
        "# Home\n[[docker]] [[Container Engine|alias]]\n"
        "- Depends On:: [[CONTAINER ENGINE#Install|engine]]\n"
        "Depends On:: [[docker]]\n* uses:: [[docker]]\n"
        "`fake:: [[inline]]`\n<!-- hidden:: [[comment]] -->\n"
        "```md\nexample:: [[fenced]]\n```\n"
        "~~~\nother:: [[tilde]]\n~~~\n    indented:: [[indent]]\n"
    )
    store.save_page("home", markdown, None, "home")
    graph = store.graph()
    assert graph["edges"] == [
        {"source": "home", "target": "docker", "type": "wikilink", "rel": "depends_on"},
        {"source": "home", "target": "docker", "type": "wikilink", "rel": "uses"},
    ]
    assert graph["missing_targets"] == []
    saved = store.get_page("home")
    assert saved is not None
    assert saved["markdown"] == markdown


def test_stable_ids_precede_titles_and_ambiguous_titles_are_reported(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for page_id, title in [("first", "Shared"), ("second", "SHARED"), ("Shared", "Other")]:
        store.save_page(page_id, f"# {title}", None, page_id)
    store.save_page(
        "home",
        "# Home\n[[Shared]] [[shared|ambiguous]] [[first#Section]] [[OTHER]] [[absent]]",
        None,
        "home",
    )
    graph = store.graph()
    assert graph["edges"] == [
        {"source": "home", "target": "Shared", "type": "wikilink"},
        {"source": "home", "target": "first", "type": "wikilink"},
    ]
    assert graph["ambiguous_targets"] == [
        {"source": "home", "target": "shared", "candidates": ["first", "second"]}
    ]
    assert graph["missing_targets"] == [{"source": "home", "target": "absent"}]


def test_anchor_only_links_are_local_and_typed_duplicates_are_collapsed(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page(
        "home",
        "# Home\n[[#Section]] [[home#Other]]\nreferences:: [[#Section]]\nreferences:: [[home]]\n",
        None,
        "home",
    )
    graph = store.graph()
    assert graph["edges"] == [
        {"source": "home", "target": "home", "type": "wikilink", "rel": "references"}
    ]
    assert graph["missing_targets"] == graph["ambiguous_targets"] == []
