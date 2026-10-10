import multiprocessing
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.store import WikiError, WikiStore


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
