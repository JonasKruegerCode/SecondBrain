"""Navigation projections preserve live Git semantics without repeated parsing."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from second_brain.wiki.store import WikiError, WikiStore

from .test_wiki_navigation_cost import count_git, seed_catalog


def test_818_page_navigation_shares_warm_projection_and_refreshes_changed_blobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    seed_catalog(wiki)
    calls = count_git(wiki, monkeypatch)
    summaries = wiki.list_page_summaries()
    assert len(summaries) == 818
    assert all("markdown" not in p for p in summaries)
    assert calls == [("ls-tree", 0), ("cat-file", 1636)]
    calls.clear()
    assert wiki.resolve_links(["article-817"])["resolutions"][0]["status"] == "resolved"
    assert calls == []  # The resolver can reuse the already-published navigation titles.
    first_graph = wiki.graph()
    for _ in range(3):
        assert wiki.list_page_summaries() == summaries
        assert wiki.graph() == first_graph
        assert wiki.backlinks("article-817")["total"] == 0
    assert calls == []

    writer = WikiStore(tmp_path)
    page = writer.get_page("article-817")
    assert page is not None
    updated = writer.save_page(
        "article-817", "# Changed\nUses:: [[article-0]]", page["revision"], "edit"
    )
    links = wiki.backlinks("article-0")
    assert links["backlinks"][0]["revision"] == updated["revision"]
    assert links["backlinks"][0]["title"] == "Changed"
    assert links["backlinks"][0]["relations"] == ["uses"]
    assert calls == [("ls-tree", 0), ("cat-file", 2)]
    calls.clear()
    assert wiki.graph()["revision"] != first_graph["revision"]
    assert wiki.graph()["edges"] == [
        {"source": "article-817", "target": "article-0", "type": "wikilink", "rel": "uses"}
    ]
    assert calls == []
    writer.delete_page("article-817", updated["revision"], "delete")
    assert wiki.backlinks("article-0")["total"] == 0
    assert len(wiki.list_page_summaries()) == 817
    assert wiki.graph() == writer.snapshot()["graph"]
    calls.clear()
    writer.save_page("article-817", "# Recreated\n[[article-0]]", None, "recreate")
    assert wiki.backlinks("article-0")["total"] == 1
    assert calls == [("ls-tree", 0), ("cat-file", 2)]
    assert WikiStore(tmp_path).graph() == wiki.graph()


def test_title_changes_reresolve_unchanged_sources_and_removal_drops_ambiguity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    wiki.save_page("source", "# Source\n[[Harbor]]", None, "source")
    wiki.save_page("port", "# Harbor", None, "port")
    peer = wiki.save_page("peer", "# Dock", None, "peer")
    assert wiki.backlinks("port")["total"] == 1
    writer = WikiStore(tmp_path)
    changed = writer.save_page("peer", "# HARBOR", peer["revision"], "rename")
    calls = count_git(wiki, monkeypatch)
    graph = wiki.graph()
    assert graph["edges"] == []
    assert graph["ambiguous_targets"] == [
        {"source": "source", "target": "Harbor", "candidates": ["peer", "port"]}
    ]
    assert calls == [("ls-tree", 0), ("cat-file", 2)]
    writer.delete_page("peer", changed["revision"], "delete")
    assert wiki.backlinks("port")["total"] == 1
    assert wiki.graph() == wiki.snapshot()["graph"]


def test_callers_cannot_mutate_cached_metadata_links_or_galaxy(tmp_path: Path) -> None:
    wiki = WikiStore(tmp_path)
    wiki.save_page("home", "---\ngalaxy_group: survey\n---\n# Home\n[[target]]", None, "home")
    wiki.save_page("target", "# Target", None, "target")
    expected = wiki.snapshot()["graph"]
    rows = wiki.list_page_summaries()
    rows[0]["galaxy"]["group"] = "caller"
    rows[0]["title"] = "caller"
    graph = wiki.graph()
    graph["nodes"][0]["galaxy"]["group"] = "caller"
    graph["edges"].clear()
    incoming = wiki.backlinks("target")
    incoming["backlinks"][0]["relations"].append("caller")
    assert wiki.graph() == expected
    assert wiki.list_page_summaries()[0]["galaxy"]["group"] == "survey"
    assert wiki.backlinks("target")["backlinks"][0]["relations"] == []


def test_revision_only_edit_preserves_metadata_and_reuses_markdown_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    saved = wiki.save_page("home", "# Home\n[[absent]]", None, "seed")
    wiki.graph()
    writer = WikiStore(tmp_path)
    updated = writer.save_page("home", saved["markdown"], saved["revision"], "same-text")
    assert updated["revision"] != saved["revision"]
    calls = count_git(wiki, monkeypatch)
    assert wiki.list_page_summaries()[0]["revision"] == updated["revision"]
    assert calls == [("ls-tree", 0), ("cat-file", 1)]
    assert wiki.graph() == writer.snapshot()["graph"]


def test_projection_refresh_failure_retries_and_does_not_poison_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    first = wiki.save_page("home", "# Before\n[[missing]]", None, "seed")
    wiki.graph()
    writer = WikiStore(tmp_path)
    writer.save_page("home", "# After", first["revision"], "edit")
    read = wiki._read_blobs

    def unavailable(entries: dict[str, bytes]) -> dict[str, bytes]:
        raise WikiError("storage_unavailable", "Synthetic read failure")

    monkeypatch.setattr(wiki, "_read_blobs", unavailable)
    with pytest.raises(WikiError, match="Synthetic read failure"):
        wiki.graph()
    monkeypatch.setattr(wiki, "_read_blobs", read)
    assert wiki.graph() == writer.snapshot()["graph"]
    assert wiki.list_page_summaries()[0]["title"] == "After"


def test_cold_projection_stays_on_captured_commit_during_external_save(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    saved = wiki.save_page("home", "# Before\n[[missing]]", None, "seed")
    captured = wiki.snapshot()
    writer = WikiStore(tmp_path)
    read = wiki._read_blobs
    advanced = False

    def race(entries: dict[str, bytes]) -> dict[str, bytes]:
        nonlocal advanced
        if not advanced:
            advanced = True
            writer.save_page("home", "# After", saved["revision"], "edit")
        return read(entries)

    monkeypatch.setattr(wiki, "_read_blobs", race)
    assert wiki.graph() == captured["graph"]
    assert wiki.graph() == writer.snapshot()["graph"]


def test_parallel_navigation_readers_share_construction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    seed_catalog(wiki, 20)
    calls = count_git(wiki, monkeypatch)
    barrier = Barrier(6)

    def navigate(index: int) -> int:
        barrier.wait(timeout=10)
        if index % 3 == 0:
            return len(wiki.list_page_summaries())
        if index % 3 == 1:
            return len(wiki.graph()["nodes"])
        return int(wiki.backlinks("article-0")["total"])

    with ThreadPoolExecutor(max_workers=6) as pool:
        assert list(pool.map(navigate, range(6))) == [20, 20, 0, 20, 20, 0]
    assert calls == [("ls-tree", 0), ("cat-file", 40)]


def test_empty_navigation_observes_first_save(tmp_path: Path) -> None:
    wiki = WikiStore(tmp_path)
    assert wiki.list_page_summaries() == []
    assert wiki.graph()["revision"] is None
    wiki.save_page("home", "# Home", None, "seed")
    assert wiki.list_page_summaries()[0]["id"] == "home"
    assert wiki.graph()["revision"] is not None
