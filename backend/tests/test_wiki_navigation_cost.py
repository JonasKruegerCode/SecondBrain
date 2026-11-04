"""Real Git snapshots, with work counts rather than machine-dependent timings."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import Any

import pytest

from second_brain.wiki.store import REF, WikiError, WikiStore


def seed_catalog(wiki: WikiStore, count: int = 818) -> None:
    commands = [f"commit {REF}\ncommitter Synthetic <fixture@example.test> 0 +0000\n"]
    commands.append("data 7\nFixture\n")
    for number in range(count):
        body = f"# Synthetic article {number}\n\n" + "Synthetic body.\n" * 40
        commands.append(f"M 100644 inline pages/article-{number}.md\ndata {len(body)}\n{body}")
        revision = hashlib.sha256(body.encode()).hexdigest()
        commands.append(f"M 100644 inline revisions/article-{number}\ndata 64\n{revision}\n")
    wiki._git("fast-import", "--quiet", data="".join(commands).encode())


def count_git(wiki: WikiStore, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, int]]:
    original = wiki._git
    calls: list[tuple[str, int]] = []

    def counted(*args: str, **kwargs: Any) -> bytes:
        calls.append((args[0], len(kwargs.get("data", b"").splitlines())))
        return original(*args, **kwargs)

    monkeypatch.setattr(wiki, "_git", counted)
    return calls


def test_818_page_link_resolution_reads_once_then_only_changed_articles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    seed_catalog(wiki)
    calls = count_git(wiki, monkeypatch)
    targets = ["article-817", "SYNTHETIC ARTICLE 400#Details", "absent"]
    first = wiki.resolve_links(targets)
    assert [item["status"] for item in first["resolutions"]] == ["resolved", "resolved", "missing"]
    assert calls == [("ls-tree", 0), ("cat-file", 818)]
    calls.clear()
    for _ in range(5):
        assert wiki.resolve_links(targets) == first
    assert calls == []  # _head still checks the live ref through _git_result.

    # An independent writer models incoming delivery or another server process.
    writer = WikiStore(tmp_path)
    page = writer.get_page("article-817")
    assert page is not None
    writer.save_page("article-817", "# Renamed article", page["revision"], "rename")
    changed = wiki.resolve_links(["article-817", "Synthetic article 817", "Renamed article"])
    assert changed["revision"] != first["revision"]
    assert [item["status"] for item in changed["resolutions"]] == [
        "resolved",
        "missing",
        "resolved",
    ]
    assert changed["resolutions"][0]["candidates"] == [
        {"id": "article-817", "title": "Renamed article"}
    ]
    assert calls == [("ls-tree", 0), ("cat-file", 1)]
    calls.clear()

    updated = writer.get_page("article-817")
    assert updated is not None
    writer.delete_page("article-817", updated["revision"], "delete")
    assert (
        wiki.resolve_links(["article-817", "Renamed article"])["resolutions"][0]["status"]
        == "missing"
    )
    assert calls == [("ls-tree", 0)]  # Removing a page needs no article reads.
    calls.clear()
    writer.save_page("article-817", "# Recreated article", None, "recreate")
    assert wiki.resolve_links(["Recreated article"])["resolutions"][0]["status"] == "resolved"
    assert calls == [("ls-tree", 0), ("cat-file", 1)]
    assert WikiStore(tmp_path).resolve_links(["Recreated article"]) == wiki.resolve_links(
        ["Recreated article"]
    )


def test_cached_resolution_keeps_identity_ambiguity_fragments_and_private_results(
    tmp_path: Path,
) -> None:
    wiki = WikiStore(tmp_path)
    for key, body in {
        "first": "---\ngalaxy_group: test\n---\n```md\n# False title\n```\n# Shared",
        "second": "# SHARED",
        "Shared": "# Direct identity",
        "straße": "# Straße",
    }.items():
        wiki.save_page(key, body, None, key)
    targets = ["Shared", "shared#Detail", "#Local", "STRASSE", "absent"]
    result = wiki.resolve_links(targets, "straße")
    assert [r["status"] for r in result["resolutions"]] == [
        "resolved",
        "ambiguous",
        "resolved",
        "resolved",
        "missing",
    ]
    assert result["resolutions"][0]["candidates"] == [{"id": "Shared", "title": "Direct identity"}]
    assert result["resolutions"][1]["candidates"] == [
        {"id": "first", "title": "Shared"},
        {"id": "second", "title": "SHARED"},
    ]
    assert result["resolutions"][2]["fragment"] == "Local"
    result["resolutions"][1]["candidates"][0]["title"] = "Caller changed a result"
    assert (
        wiki.resolve_links(targets, "straße")["resolutions"][1]["candidates"][0]["title"]
        == "Shared"
    )


def test_catalog_race_returns_captured_commit_then_observes_external_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    original = wiki.save_page("home", "# Before", None, "seed")
    captured = wiki._head()
    writer = WikiStore(tmp_path)
    read_git = wiki._git
    advanced = False

    def race(*args: str, **kwargs: Any) -> bytes:
        nonlocal advanced
        if args[0] == "cat-file" and not advanced:
            advanced = True
            writer.save_page("home", "# After", original["revision"], "change")
        return read_git(*args, **kwargs)

    monkeypatch.setattr(wiki, "_git", race)
    before = wiki.resolve_links(["Before", "After"])
    assert before["revision"] == captured
    assert [r["status"] for r in before["resolutions"]] == ["resolved", "missing"]
    after = wiki.resolve_links(["Before", "After"])
    assert after["revision"] != captured
    assert [r["status"] for r in after["resolutions"]] == ["missing", "resolved"]


def test_parallel_cold_readers_share_one_catalog_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    seed_catalog(wiki, 20)
    calls = count_git(wiki, monkeypatch)
    barrier = Barrier(6)

    def resolve(_: int) -> dict[str, Any]:
        barrier.wait(timeout=10)
        return wiki.resolve_links(["Synthetic article 19"])

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(resolve, range(6)))
    assert all(result == results[0] for result in results)
    assert calls == [("ls-tree", 0), ("cat-file", 20)]


def test_single_page_reads_only_its_content_and_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    expected = wiki.save_page("a.b", "# Exact page", None, "seed")
    wiki.save_page("a.b-other", "# Unrelated", None, "other")
    calls = count_git(wiki, monkeypatch)
    assert wiki.get_page("a.b") == {
        key: expected[key] for key in ("id", "title", "markdown", "revision", "excerpt")
    }
    assert calls == [("ls-tree", 0), ("cat-file", 2)]
    calls.clear()
    assert wiki.get_page("absent") is None
    assert calls == [("ls-tree", 0)]


def test_unborn_catalog_observes_first_page(tmp_path: Path) -> None:
    wiki = WikiStore(tmp_path)
    assert wiki.resolve_links(["home"]) == {
        "revision": None,
        "resolutions": [{"target": "home", "status": "missing", "fragment": "", "candidates": []}],
    }
    wiki.save_page("home", "# First page", None, "seed")
    assert wiki.resolve_links(["First page"])["resolutions"][0]["status"] == "resolved"


def test_failed_catalog_refresh_can_retry_without_publishing_partial_titles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    original = wiki.save_page("home", "# Before", None, "seed")
    wiki.resolve_links(["Before"])
    wiki.save_page("home", "# After", original["revision"], "edit")
    read_blobs = wiki._read_blobs

    def unavailable(entries: dict[str, bytes]) -> dict[str, bytes]:
        raise WikiError("storage_unavailable", "Synthetic failed read")

    monkeypatch.setattr(wiki, "_read_blobs", unavailable)
    with pytest.raises(WikiError, match="Synthetic failed read"):
        wiki.resolve_links(["Before", "After"])
    monkeypatch.setattr(wiki, "_read_blobs", read_blobs)
    result = wiki.resolve_links(["Before", "After"])
    assert [r["status"] for r in result["resolutions"]] == ["missing", "resolved"]


def test_targeted_page_read_keeps_content_and_revision_on_captured_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wiki = WikiStore(tmp_path)
    before = wiki.save_page("home", "# Before", None, "seed")
    writer = WikiStore(tmp_path)
    read_git = wiki._git

    def race(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "cat-file":
            writer.save_page("home", "# After", before["revision"], "edit")
        return read_git(*args, **kwargs)

    monkeypatch.setattr(wiki, "_git", race)
    page = wiki.get_page("home")
    assert page is not None
    assert (page["markdown"], page["revision"]) == ("# Before", before["revision"])
    assert (writer.get_page("home") or {})["markdown"] == "# After"
