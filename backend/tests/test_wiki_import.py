"""Independent contracts for explicit, atomic import of synthetic local Git vaults."""

import subprocess
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.importer import import_vault
from second_brain.wiki.store import MAX_BYTES, WikiError, WikiStore


def git(source: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(source), *args],
        check=True,
        capture_output=True,
    ).stdout


def source_repo(tmp_path: Path, files: dict[str, bytes] | None = None) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    git(source, "init", "--quiet")
    git(source, "config", "user.name", "Fictional Archive")
    git(source, "config", "user.email", "archive@example.invalid")
    if files:
        commit_files(source, files)
    return source


def commit_files(source: Path, files: dict[str, bytes]) -> str:
    for name, data in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    git(source, "add", "--all")
    git(source, "commit", "--quiet", "-m", "Synthetic archive snapshot")
    return git(source, "rev-parse", "HEAD").decode().strip()


def pages(store: WikiStore) -> dict[str, str]:
    return {page["id"]: page["markdown"] for page in store.list_pages()}


def test_source_history_treats_pathspec_syntax_as_literal(tmp_path: Path) -> None:
    source = source_repo(tmp_path, {":(glob)/home.md": b"# Literal fictional source\n"})
    commit = git(source, "rev-parse", "HEAD").decode().strip()
    store = WikiStore(tmp_path / "managed")
    import_vault(store, source, prefix=":(glob)", base_revision=None, request_id="literal")
    assert commit in {row["commit"] for row in store.history("home")}
    assert pages(store) == {"home": "# Literal fictional source\n"}


def test_nested_prefix_preserves_bytes_source_and_history(tmp_path: Path) -> None:
    original = "# Küstenarchiv\r\n\r\nFiktiv: Grüße 🌊. [[sky]]\r\n".encode()
    source = source_repo(
        tmp_path,
        {
            "1_knowledge/wiki/home.md": original,
            "1_knowledge/wiki/astronomy/sky.md": b"# Fictional sky\n\n[[home]]\n",
            "outside.md": b"# Excluded\n",
            "1_knowledge/wiki/notes.txt": b"Non-Markdown source asset\n",
        },
    )
    git(source, "remote", "add", "origin", "https://example.invalid/synthetic-archive.git")
    source_config = (source / ".git" / "config").read_bytes()
    first = git(source, "rev-parse", "HEAD").decode().strip()
    second = commit_files(source, {"history-only.txt": b"Synthetic provenance\n"})
    before = {
        p.relative_to(source): p.read_bytes()
        for p in source.rglob("*")
        if p.is_file() and ".git" not in p.relative_to(source).parts
    }
    store = WikiStore(tmp_path / "managed")
    result = import_vault(
        store,
        source,
        prefix="1_knowledge/wiki",
        base_revision=None,
        request_id="import-1",
    )
    assert result["publication"] == "imported"
    assert result["pages"] == 2
    assert result["source_revision"] == second
    assert result["revision"] == store._head()
    assert result["index"] == {"graph": "pending", "vector": "pending"}
    assert result["remote_sync"] == "not_configured"
    assert pages(store)["home"].encode() == original
    assert set(pages(store)) == {"home", "sky"}
    parents = store._git("show", "-s", "--format=%P", result["revision"]).decode().split()
    assert second in parents
    assert store._git("cat-file", "commit", second) == git(source, "cat-file", "commit", second)
    assert store._git("cat-file", "commit", first) == git(source, "cat-file", "commit", first)
    assert store._git("show", f"{second}:1_knowledge/wiki/home.md") == original
    assert git(source, "rev-parse", "HEAD").decode().strip() == second
    assert git(source, "status", "--porcelain") == b""
    after = {
        p.relative_to(source): p.read_bytes()
        for p in source.rglob("*")
        if p.is_file() and ".git" not in p.relative_to(source).parts
    }
    assert after == before
    assert (source / ".git" / "config").read_bytes() == source_config
    assert b"example.invalid" not in (store.repo / "config").read_bytes()
    for data in store._snapshot_blobs(store._head(), "imports/").values():
        assert str(source).encode() not in data
        assert b"example.invalid" not in data


def test_full_snapshot_replacement_requires_current_head_and_replays_receipt(
    tmp_path: Path,
) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Fictional home\n"})
    store = WikiStore(tmp_path / "managed")
    store.save_page("old", "# Old synthetic page\n", None, "old-create")
    base = store._head()
    result = import_vault(store, source, base_revision=base, request_id="replace")
    assert pages(store) == {"home": "# Fictional home\n"}
    head = store._head()
    assert (
        import_vault(
            WikiStore(store.path),
            source,
            base_revision=base,
            request_id="replace",
        )
        == result
    )
    assert store._head() == head
    # A receipt remains recoverable after a later foreign save.
    store.save_page("later", "# Later synthetic page\n", None, "later-create")
    later_head = store._head()
    assert (
        import_vault(
            WikiStore(store.path),
            source,
            base_revision=base,
            request_id="replace",
        )
        == result
    )
    assert store._head() == later_head
    assert "later" in pages(store)


def test_changed_source_and_stale_or_missing_base_cannot_overwrite(tmp_path: Path) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Fictional home\n"})
    store = WikiStore(tmp_path / "managed")
    first = import_vault(store, source, base_revision=None, request_id="first")
    base = store._head()
    store.save_page("new", "# Foreign synthetic edit\n", None, "foreign")
    commit_files(source, {"home.md": b"# Changed fictional home\n"})
    before, head = pages(store), store._head()
    for stale in (None, base):
        with pytest.raises(WikiError):
            import_vault(store, source, base_revision=stale, request_id=f"stale-{stale}")
        assert pages(store) == before
        assert store._head() == head
    with pytest.raises(WikiError):
        import_vault(store, source, base_revision=None, request_id="first")
    assert store._head() == head
    current = import_vault(store, source, base_revision=head, request_id="fresh")
    assert current["source_revision"] != first["source_revision"]
    assert pages(store) == {"home": "# Changed fictional home\n"}


@pytest.mark.parametrize("dirty", ["tracked", "untracked", "staged"])
def test_dirty_git_is_refused_without_publication(tmp_path: Path, dirty: str) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Fictional home\n"})
    path = source / ("new.md" if dirty == "untracked" else "home.md")
    path.write_bytes(b"# Unsaved synthetic change\n")
    if dirty == "staged":
        git(source, "add", "home.md")
    store = WikiStore(tmp_path / "managed")
    with pytest.raises(WikiError):
        import_vault(store, source, base_revision=None, request_id="dirty")
    assert pages(store) == {}
    assert not store._head()
    assert path.read_bytes() == b"# Unsaved synthetic change\n"


@pytest.mark.parametrize("kind", ["duplicate", "unsafe", "utf8", "oversize", "symlink"])
def test_invalid_snapshot_has_no_partial_pages(tmp_path: Path, kind: str) -> None:
    source = source_repo(tmp_path)
    files = {"a-valid.md": b"# Valid fictional page\n"}
    if kind == "duplicate":
        files.update({"one/home.md": b"# One\n", "two/home.md": b"# Two\n"})
    elif kind == "unsafe":
        files["unsafe name.md"] = b"# Unsafe\n"
    elif kind == "utf8":
        files["invalid.md"] = b"# Invalid\n\xff"
    elif kind == "oversize":
        files["large.md"] = b"# Large\n" + b"x" * MAX_BYTES
    commit_files(source, files)
    if kind == "symlink":
        (source / "link.md").symlink_to("a-valid.md")
        git(source, "add", "link.md")
        git(source, "commit", "--quiet", "-m", "Synthetic symlink")
    store = WikiStore(tmp_path / "managed")
    store.save_page("existing", "# Keep this fictional page\n", None, "existing")
    base, before = store._head(), pages(store)
    with pytest.raises(WikiError):
        import_vault(store, source, base_revision=base, request_id="invalid")
    assert store._head() == base
    assert pages(store) == before


@pytest.mark.parametrize("prefix", ["../escape", "/absolute", "one/../../escape"])
def test_unsafe_prefix_is_refused(tmp_path: Path, prefix: str) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Fictional\n"})
    store = WikiStore(tmp_path / "managed")
    with pytest.raises(WikiError):
        import_vault(store, source, prefix=prefix, base_revision=None, request_id="prefix")
    assert not store._head()


def test_plain_directory_and_overlapping_paths_are_refused(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "home.md").write_text("# Fictional\n")
    store = WikiStore(tmp_path / "managed")
    with pytest.raises(WikiError):
        import_vault(store, plain, base_revision=None, request_id="plain")
    source = source_repo(tmp_path, {"home.md": b"# Fictional\n"})
    inside = WikiStore(source / "managed")
    with pytest.raises(WikiError):
        import_vault(inside, source, base_revision=None, request_id="inside")
    with pytest.raises(WikiError):
        import_vault(store, store.path, base_revision=None, request_id="same")
    # Source nested below a managed target must also be refused.
    nested = source_repo(store.path, {"home.md": b"# Fictional\n"})
    with pytest.raises(WikiError):
        import_vault(store, nested, base_revision=None, request_id="nested")
    assert not store._head()


def test_empty_unborn_git_import_and_retry(tmp_path: Path) -> None:
    source = source_repo(tmp_path)
    store = WikiStore(tmp_path / "managed")
    result = import_vault(store, source, base_revision=None, request_id="empty")
    assert result["publication"] == "imported"
    assert result["pages"] == 0
    assert result["source_revision"] is None
    assert result["revision"] == store._head()
    assert pages(store) == {}
    assert import_vault(store, source, base_revision=None, request_id="empty") == result


@pytest.mark.parametrize("phase", ["before", "after"])
def test_import_publication_fault_is_atomic_and_retryable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Home\n", "sky.md": b"# Sky\n"})
    store = WikiStore(tmp_path / "managed")
    store.save_page("old", "# Old fictional page\n", None, "old")
    base, original_git = store._head(), store._git

    def faulty_git(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "update-ref" and phase == "before":
            raise RuntimeError("before publication")
        result = original_git(*args, **kwargs)
        if args[0] == "update-ref" and phase == "after":
            raise RuntimeError("reply lost after publication")
        return result

    monkeypatch.setattr(store, "_git", faulty_git)
    with pytest.raises(RuntimeError):
        import_vault(store, source, base_revision=base, request_id=f"fault-{phase}")
    restarted = WikiStore(store.path)
    expected = (
        {"old": "# Old fictional page\n"}
        if phase == "before"
        else {
            "home": "# Home\n",
            "sky": "# Sky\n",
        }
    )
    assert pages(restarted) == expected
    published_head = restarted._head()
    result = import_vault(
        restarted,
        source,
        base_revision=base,
        request_id=f"fault-{phase}",
    )
    assert pages(restarted) == {"home": "# Home\n", "sky": "# Sky\n"}
    if phase == "after":
        assert result["revision"] == published_head
    assert result["revision"] == restarted._head()


def test_competing_foreign_save_wins_without_partial_import(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Imported home\n", "sky.md": b"# Sky\n"})
    store = WikiStore(tmp_path / "managed")
    store.save_page("old", "# Old\n", None, "old")
    base, original_git = store._head(), store._git
    competitor = WikiStore(store.path)
    raced = False

    def race(*args: str, **kwargs: Any) -> bytes:
        nonlocal raced
        if args[0] == "update-ref" and not raced:
            raced = True
            competitor.save_page("foreign", "# Foreign\n", None, "foreign")
        return original_git(*args, **kwargs)

    monkeypatch.setattr(store, "_git", race)
    with pytest.raises(WikiError):
        import_vault(store, source, base_revision=base, request_id="race")
    assert raced
    assert pages(competitor) == {"old": "# Old\n", "foreign": "# Foreign\n"}
    assert competitor._head() != base


def test_changed_prefix_is_a_different_request_even_with_no_pages(tmp_path: Path) -> None:
    source = source_repo(
        tmp_path,
        {
            "alpha/readme.txt": b"Synthetic alpha asset\n",
            "beta/readme.txt": b"Synthetic beta asset\n",
        },
    )
    store = WikiStore(tmp_path / "managed")
    result = import_vault(
        store,
        source,
        prefix="alpha",
        base_revision=None,
        request_id="one-prefix",
    )
    assert result["pages"] == 0
    head = store._head()
    with pytest.raises(WikiError):
        import_vault(
            store,
            source,
            prefix="beta",
            base_revision=None,
            request_id="one-prefix",
        )
    assert store._head() == head


@pytest.mark.parametrize("prefix", ["missing", "1_knowledge/missing"])
def test_missing_prefix_cannot_publish_empty_replacement(tmp_path: Path, prefix: str) -> None:
    source = source_repo(tmp_path, {"home.md": b"# Fictional source\n"})
    store = WikiStore(tmp_path / "managed")
    store.save_page("keep", "# Keep fictional content\n", None, "keep")
    base = store._head()
    with pytest.raises(WikiError):
        import_vault(store, source, prefix=prefix, base_revision=base, request_id="missing")
    assert store._head() == base
    assert pages(store) == {"keep": "# Keep fictional content\n"}


@pytest.mark.parametrize("unborn", [False, True])
def test_empty_import_cannot_replace_a_published_snapshot(tmp_path: Path, unborn: bool) -> None:
    source = source_repo(tmp_path, None if unborn else {"asset.txt": b"Fictional asset\n"})
    store = WikiStore(tmp_path / "managed")
    store.save_page("keep", "# Keep fictional content\n", None, "keep")
    base = store._head()
    with pytest.raises(WikiError):
        import_vault(store, source, base_revision=base, request_id="empty-replacement")
    assert store._head() == base
    assert pages(store) == {"keep": "# Keep fictional content\n"}


def test_shallow_source_is_refused_without_publication(tmp_path: Path) -> None:
    original = source_repo(tmp_path, {"home.md": b"# Fictional first\n"})
    commit_files(original, {"home.md": b"# Fictional second\n"})
    shallow = tmp_path / "shallow"
    git(original, "clone", "--quiet", "--depth", "1", original.as_uri(), str(shallow))
    assert git(shallow, "rev-parse", "--is-shallow-repository").strip() == b"true"
    store = WikiStore(tmp_path / "managed")
    with pytest.raises(WikiError):
        import_vault(store, shallow, base_revision=None, request_id="shallow")
    assert not store._head()
    assert pages(store) == {}


def test_history_exposes_original_commits_for_nested_imported_page(tmp_path: Path) -> None:
    source = source_repo(tmp_path, {"wiki/nested/home.md": b"# Fictional first\n"})
    first = git(source, "rev-parse", "HEAD").decode().strip()
    second = commit_files(source, {"wiki/nested/home.md": b"# Fictional second\n"})
    store = WikiStore(tmp_path / "managed")
    result = import_vault(
        store,
        source,
        prefix="wiki",
        base_revision=None,
        request_id="history",
    )
    commits = {entry["commit"] for entry in store.history("home")}
    assert {first, second, result["revision"]} <= commits
    assert pages(store) == {"home": "# Fictional second\n"}
