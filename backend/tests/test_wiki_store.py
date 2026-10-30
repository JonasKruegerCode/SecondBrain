import hashlib
import json
import multiprocessing
import tempfile
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.store import WikiError, WikiStore


def test_backlinks_resolve_explicit_incoming_sources_at_one_snapshot(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    target = store.save_page("target", "# Harbor\n[[target]] [[outgoing]]", None, "target")
    for key, body in {
        "outgoing": "# Outgoing\nNo incoming link.",
        "z": "# Alpha\n[[target|Alias]] [[Harbor#Detail]]\nDepends on:: [[target]]",
        "a": "# alpha\n[[hArBoR]]\nRelated:: [[target]]\nSupports:: [[target]]",
        "code": "# Code\n`[[target]]`\n```md\n[[target]]\n```\n\n    [[target]]\n",
        "missing": "# Missing\n[[gone]] [[Shared]]",
        "shared-a": "# Shared\nNo links.",
        "shared-b": "# Shared\nNo links.",
    }.items():
        store.save_page(key, body, None, key)
    result = store.backlinks("target", 1)
    assert result["revision"] == store.graph()["revision"]
    assert result["target_revision"] == target["revision"]
    assert result["total"] == 2
    assert result["truncated"] is True
    assert result["backlinks"][0]["id"] == "a"
    assert result["backlinks"][0]["relations"] == ["related", "supports"]
    assert set(result["backlinks"][0]) == {"id", "title", "revision", "excerpt", "relations"}
    full = store.backlinks("target")
    assert [row["id"] for row in full["backlinks"]] == ["a", "z"]
    assert full["backlinks"][1]["relations"] == ["depends_on"]
    assert full["truncated"] is False
    assert store.backlinks("shared-a")["total"] == 0

    source = store.get_page("a")
    assert source is not None
    store.save_page("a", "# alpha\nLink removed.", source["revision"], "edit-a")
    edited = WikiStore(tmp_path).backlinks("target")
    assert edited["revision"] != full["revision"]
    assert edited["target_revision"] == target["revision"]
    assert [row["id"] for row in edited["backlinks"]] == ["z"]
    other = store.get_page("z")
    assert other is not None
    store.delete_page("z", other["revision"], "delete-z")
    assert WikiStore(tmp_path).backlinks("target")["total"] == 0


@pytest.mark.parametrize("limit", [0, 101, -1, True, "20", 1.5])
def test_backlinks_reject_invalid_bounds(tmp_path: Path, limit: Any) -> None:
    with pytest.raises(WikiError) as failure:
        WikiStore(tmp_path).backlinks("unknown", limit)
    assert failure.value.code == "invalid_payload"


def test_backlinks_missing_target_and_valid_bounds(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    with pytest.raises(WikiError) as failure:
        store.backlinks("unknown")
    assert failure.value.code == "not_found"
    store.save_page("target", "# Target", None, "target")
    for limit in (1, 100):
        result = store.backlinks("target", limit)
        assert result["backlinks"] == []
        assert result["total"] == 0
        assert result["truncated"] is False


def _race(path: str, base: str, name: str, barrier: Any, queue: Any) -> None:
    store = WikiStore(path)
    barrier.wait()
    try:
        result = store.save_page("harbor", f"# Harbor\n{name}", base, name)
        queue.put(result["publication"])
    except WikiError as exc:
        queue.put(exc.code)


def test_snapshot_retry_conflict_history_and_aba(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    created = store.save_page("harbor", "# Harbor\nA quiet port.", None, "create")
    assert (store.get_page("harbor") or {})["revision"] == created["revision"]
    assert store.save_page("harbor", created["markdown"], None, "create") == created
    with pytest.raises(WikiError, match="different payload"):
        store.save_page("harbor", "# Different", None, "create")
    changed = store.save_page("harbor", "# Harbor\nNew survey.", created["revision"], "update")
    with pytest.raises(WikiError) as stale:
        store.save_page("harbor", "# Harbor\nOld copy.", created["revision"], "stale")
    assert stale.value.code == "revision_conflict"
    store.delete_page("harbor", changed["revision"], "delete")
    recreated = store.save_page("harbor", created["markdown"], None, "recreate")
    assert recreated["revision"] != created["revision"]
    with pytest.raises(WikiError):
        store.save_page("harbor", "# Stale incarnation", created["revision"], "aba")
    assert len(store.history("harbor")) == 4
    # Restart and a much later retry return the original receipt, not a second mutation.
    restarted = WikiStore(tmp_path)
    assert restarted.save_page("harbor", created["markdown"], None, "create") == created
    assert (restarted.get_page("harbor") or {})["revision"] == recreated["revision"]


def test_separate_process_writers_cannot_overwrite_same_base(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    base = store.save_page("harbor", "# Harbor\nOriginal.", None, "create")["revision"]
    context = multiprocessing.get_context("spawn")
    barrier, queue = context.Barrier(2), context.Queue()
    writers = [
        context.Process(target=_race, args=(str(tmp_path), base, name, barrier, queue))
        for name in ("east", "west")
    ]
    for writer in writers:
        writer.start()
    for writer in writers:
        writer.join(15)
        assert writer.exitcode == 0
    assert sorted([queue.get(timeout=2), queue.get(timeout=2)]) == ["revision_conflict", "saved"]
    assert len(store.history("harbor")) == 2


def test_unpublished_commit_not_visible_and_lost_reply_is_recoverable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WikiStore(tmp_path)
    created = store.save_page("harbor", "# Harbor\nOriginal.", None, "create")
    original_git = store._git

    def fail_before(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "update-ref":
            raise RuntimeError("process stopped before publication")
        return original_git(*args, **kwargs)

    monkeypatch.setattr(store, "_git", fail_before)
    with pytest.raises(RuntimeError):
        store.save_page("harbor", "# Harbor\nPending.", created["revision"], "before")
    restarted = WikiStore(tmp_path)
    assert (restarted.get_page("harbor") or {})["markdown"] == created["markdown"]

    def fail_after(*args: str, **kwargs: Any) -> bytes:
        result = original_git(*args, **kwargs)
        if args[0] == "update-ref":
            raise RuntimeError("process stopped after publication")
        return result

    monkeypatch.setattr(store, "_git", fail_after)
    with pytest.raises(RuntimeError):
        store.save_page("harbor", "# Harbor\nPublished.", created["revision"], "after")
    retry = WikiStore(tmp_path).save_page(
        "harbor", "# Harbor\nPublished.", created["revision"], "after"
    )
    assert retry["publication"] == "saved"
    assert len(restarted.history("harbor")) == 2


def _pause_at_publication(path: str, base: str, boundary: str, pipe: Any, release: Any) -> None:
    store = WikiStore(path)
    child_temp = Path(path) / "child-temp"
    child_temp.mkdir()
    tempfile.tempdir = str(child_temp)
    original_git = store._git

    def paused_git(*args: str, **kwargs: Any) -> bytes:
        if args[0] != "update-ref":
            return original_git(*args, **kwargs)
        if boundary == "after":
            result = original_git(*args, **kwargs)
        pipe.send((boundary, args[2]))
        if not release.wait(30):
            raise RuntimeError("Parent did not kill the paused writer")
        return original_git(*args, **kwargs) if boundary == "before" else result

    store._git = paused_git  # type: ignore[method-assign]
    try:
        store.save_page("harbor", "# Harbor\nSynthetic survey.", base, "death-request")
    finally:
        pipe.close()


@pytest.mark.parametrize("boundary", ["before", "after"])
def test_process_death_at_ref_publication_is_recoverable(tmp_path: Path, boundary: str) -> None:
    store = WikiStore(tmp_path)
    created = store.save_page("harbor", "# Harbor\nSynthetic original.", None, "create")
    initial_head = store._head()
    initial_page = store.get_page("harbor")
    initial_history = store.history("harbor")
    context = multiprocessing.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    release = context.Event()
    process = context.Process(
        target=_pause_at_publication,
        args=(str(tmp_path), created["revision"], boundary, writer, release),
    )
    try:
        process.start()
        writer.close()
        assert reader.poll(15), "Writer did not reach the publication boundary"
        marker, candidate_head = reader.recv()
        assert marker == boundary
        assert process.is_alive()
        process.kill()
        process.join(15)
        assert not process.is_alive()
        assert process.exitcode is not None and process.exitcode < 0

        restarted = WikiStore(tmp_path)
        if boundary == "before":
            assert restarted._head() == initial_head
            assert restarted.get_page("harbor") == initial_page
            assert restarted.history("harbor") == initial_history
        else:
            assert restarted._head() == candidate_head
            assert (restarted.get_page("harbor") or {})["markdown"] == (
                "# Harbor\nSynthetic survey."
            )
            assert len(restarted.history("harbor")) == len(initial_history) + 1

        request_hash = hashlib.sha256(b"death-request").hexdigest()
        receipt_blob = restarted._blob(candidate_head, f"requests/{request_hash}.json")
        assert receipt_blob is not None
        expected_response = json.loads(receipt_blob)["result"]
        reply = restarted.save_page(
            "harbor", "# Harbor\nSynthetic survey.", created["revision"], "death-request"
        )
        assert reply == expected_response
        if boundary == "after":
            assert restarted._head() == candidate_head
        assert len(restarted.history("harbor")) == len(initial_history) + 1
        published_head = restarted._head()
        published_page = restarted.get_page("harbor")
        published_history = restarted.history("harbor")
        assert WikiStore(tmp_path).save_page(
            "harbor", "# Harbor\nSynthetic survey.", created["revision"], "death-request"
        ) == reply
        assert restarted._head() == published_head
        assert restarted.get_page("harbor") == published_page
        assert restarted.history("harbor") == published_history
    finally:
        try:
            if process.pid is not None:
                if process.is_alive():
                    process.kill()
                process.join(15)
                assert not process.is_alive(), "Owned writer failed to terminate"
                process.close()
        finally:
            reader.close()
            writer.close()


@pytest.mark.parametrize("page_id", ["../escape", "/absolute", "a/b", "..", "a\nheader"])
def test_ids_cannot_escape_vault(tmp_path: Path, page_id: str) -> None:
    with pytest.raises(WikiError):
        WikiStore(tmp_path).save_page(page_id, "# Safe", None, "unsafe")


def test_same_request_race_returns_the_published_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = WikiStore(tmp_path)
    original_git = first._git
    competitor = WikiStore(tmp_path)
    published: dict[str, Any] = {}
    intercepted = False

    def raced_git(*args: str, **kwargs: Any) -> bytes:
        nonlocal intercepted
        if args[0] == "update-ref" and not intercepted:
            intercepted = True
            competitor.save_page("other", "# Other", None, "other-request")
            published.update(competitor.save_page("home", "# Home", None, "same-request"))
        return original_git(*args, **kwargs)

    monkeypatch.setattr(first, "_git", raced_git)
    reply = first.save_page("home", "# Home", None, "same-request")
    assert reply == published
    assert reply["revision"] == (competitor.get_page("home") or {})["revision"]


def test_existing_markdown_requires_import_and_reads_need_no_providers(tmp_path: Path) -> None:
    (tmp_path / "legacy.md").write_text("# Preserve me")
    with pytest.raises(WikiError, match="controlled import"):
        WikiStore(tmp_path)
    assert (tmp_path / "legacy.md").read_text() == "# Preserve me"


def test_lexical_search_and_graph_refresh_with_delete(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("home", "# Archive\nVisit [[harbor|the harbor]] and [[missing]].", None, "a")
    harbor = store.save_page("harbor", "# Harbor\nThe fictional tide notebook.", None, "b")
    graph = store.graph()
    assert graph["edges"] == [{"source": "home", "target": "harbor", "type": "wikilink"}]
    assert graph["missing_targets"] == [{"source": "home", "target": "missing"}]
    assert store.search("TIDE notebook")[0]["id"] == "harbor"
    store.delete_page("harbor", harbor["revision"], "c")
    assert store.graph()["edges"] == []
    assert store.graph()["revision"] != graph["revision"]


def test_lexical_search_keeps_a_bounded_default_and_supports_one_extra_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = WikiStore(tmp_path)
    pages = [
        {
            "id": f"page-{index:02d}",
            "title": f"Shared result {index:02d}",
            "markdown": "# Shared result\nBounded search fixture.",
        }
        for index in range(51)
    ]
    monkeypatch.setattr(store, "list_pages", lambda: pages)

    assert len(store.search("bounded search")) == 50
    assert len(store.search("bounded search", limit=51)) == 51
    invalid_limits: list[Any] = [0, -1, True, "51"]
    for invalid in invalid_limits:
        with pytest.raises(WikiError, match="positive integer"):
            store.search("bounded search", limit=invalid)


def test_graph_does_not_treat_code_examples_as_links(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page(
        "home",
        "# Home\n[[real]]\n`[[inline]]`\n```md\n[[example]]\n```\n"
        "<!-- [[comment]] -->\n    [[indented]]",
        None,
        "create",
    )
    assert store.graph()["missing_targets"] == [{"source": "home", "target": "real"}]


@pytest.mark.parametrize("marker", ["`", "~"])
@pytest.mark.parametrize("suffix", ["not-a-close", " <!-- literal -->", "\ttext"])
def test_fence_with_trailing_text_keeps_literal_content_out_of_navigation(
    tmp_path: Path, marker: str, suffix: str
) -> None:
    store = WikiStore(tmp_path)
    fence = marker * 3
    markdown = (
        f"{fence}text\n{fence}{suffix}\n# Literal code title\n"
        f"Literal code payload [[code-target]].\n{fence}\n\n"
        "# Visible title\nVisible prose [[real-target]].\n"
    )
    page = store.save_page("home", markdown, None, "create")
    assert page["markdown"] == markdown
    assert page["title"] == "Visible title"
    assert page["excerpt"] == "Visible prose real-target."
    assert store.graph()["missing_targets"] == [{"source": "home", "target": "real-target"}]


@pytest.mark.parametrize("marker", ["`", "~"])
def test_longer_fence_with_only_trailing_whitespace_closes_code(
    tmp_path: Path, marker: str
) -> None:
    store = WikiStore(tmp_path)
    page = store.save_page(
        "home",
        f"{marker * 3}text\n# Literal title\n[[code-target]]\n{marker * 5} \t\n"
        "# Visible title\nVisible prose [[real-target]].\n",
        None,
        "create",
    )
    assert page["title"] == "Visible title"
    assert store.graph()["missing_targets"] == [{"source": "home", "target": "real-target"}]


@pytest.mark.parametrize("read", ["graph", "resolve-links"])
def test_batch_read_remains_on_one_snapshot_during_concurrent_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    read: str,
) -> None:
    store = WikiStore(tmp_path)
    home = store.save_page("home", "# Home\r\n\n[[old]]\n", None, "initial")
    before = store._head()
    original_git = store._git
    competitor = WikiStore(tmp_path)
    intercepted = False

    def raced_git(*args: str, **kwargs: Any) -> bytes:
        nonlocal intercepted
        if args[0] == "cat-file" and not intercepted:
            intercepted = True
            competitor.save_page("home", "# Updated Home\n[[new]]\n", home["revision"], "changed")
        return original_git(*args, **kwargs)

    monkeypatch.setattr(store, "_git", raced_git)
    if read == "resolve-links":
        def unexpected_graph(*args: Any, **kwargs: Any) -> dict[str, Any]:
            pytest.fail("Article link resolution must not derive graph edges")

        monkeypatch.setattr(store, "_graph", unexpected_graph)
        resolved = store.resolve_links(["Home", "Updated Home", "#Local"], "home")
        assert intercepted
        assert resolved["revision"] == before
        assert resolved["resolutions"][0]["candidates"] == [{"id": "home", "title": "Home"}]
        assert resolved["resolutions"][1]["status"] == "missing"
        assert resolved["resolutions"][2]["fragment"] == "Local"
        assert resolved["resolutions"][2]["candidates"] == [{"id": "home", "title": "Home"}]
        updated = store.resolve_links(["Home", "Updated Home"])
        assert updated["revision"] == competitor._head() != before
        assert updated["resolutions"][0]["status"] == "missing"
        assert updated["resolutions"][1]["candidates"] == [
            {"id": "home", "title": "Updated Home"}
        ]
        return
    graph = store.graph()
    assert intercepted
    assert graph["revision"] == before
    assert graph["missing_targets"] == [{"source": "home", "target": "old"}]
    assert competitor.graph()["missing_targets"] == [{"source": "home", "target": "new"}]
