"""Safety and managed-write guarantees for the opt-in demo seeder."""

import json
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki import demo
from second_brain.wiki.store import WikiStore


def template_at(tmp_path: Path) -> Path:
    template = tmp_path / "template"
    template.mkdir()
    (template / "home.md").write_text(
        "# Fictional harbor\n\nAn invented demonstration. See [[sky]].\n", encoding="utf-8"
    )
    (template / "sky.md").write_text(
        "# Fictional sky\n\nAn invented observation. Return to [[home]].\n", encoding="utf-8"
    )
    return template


def file_snapshot(path: Path) -> dict[str, bytes]:
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob("*") if p.is_file()}


def test_nonempty_vault_is_untouched(tmp_path: Path) -> None:
    template = template_at(tmp_path)
    vault = tmp_path / "personal-vault"
    vault.mkdir()
    (vault / "private.md").write_text("Existing content\n", encoding="utf-8")
    before = file_snapshot(vault)
    with pytest.raises(demo.DemoSeedError, match="nonempty"):
        demo.seed_vault(vault, template)
    assert file_snapshot(vault) == before


def test_seed_uses_managed_pages_and_exact_repeat_is_noop(tmp_path: Path) -> None:
    template = template_at(tmp_path)
    vault = tmp_path / "demo"
    result = demo.seed_vault(vault, template)
    assert result["status"] == "created"
    pages = WikiStore(vault).list_pages()
    assert {page["id"] for page in pages} == {"home", "sky"}
    assert all(page["revision"] for page in pages)
    assert not (vault / "home.md").exists()
    before = file_snapshot(vault)
    assert demo.seed_vault(vault, template)["status"] == "unchanged"
    assert file_snapshot(vault) == before


def test_edited_completed_demo_is_not_overwritten(tmp_path: Path) -> None:
    template = template_at(tmp_path)
    vault = tmp_path / "demo"
    demo.seed_vault(vault, template)
    store = WikiStore(vault)
    page = store.get_page("home")
    assert page is not None
    store.save_page("home", "# My edited page\n", page["revision"], "user-edit")
    before = file_snapshot(vault)
    with pytest.raises(demo.DemoSeedError, match="changed or added"):
        demo.seed_vault(vault, template)
    assert file_snapshot(vault) == before


def test_different_template_is_refused(tmp_path: Path) -> None:
    template = template_at(tmp_path)
    vault = tmp_path / "demo"
    demo.seed_vault(vault, template)
    (template / "sky.md").write_text("# Another fictional sky\n", encoding="utf-8")
    before = file_snapshot(vault)
    with pytest.raises(demo.DemoSeedError, match="Template differs"):
        demo.seed_vault(vault, template)
    assert file_snapshot(vault) == before


def test_interruption_leaves_marker_and_retry_refuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    template = template_at(tmp_path)
    vault = tmp_path / "demo"
    original = WikiStore.save_page
    count = 0

    def interrupted_save(self: WikiStore, *args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal count
        count += 1
        if count == 2:
            raise RuntimeError("simulated process interruption")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(WikiStore, "save_page", interrupted_save)
    with pytest.raises(RuntimeError, match="simulated"):
        demo.seed_vault(vault, template)
    marker = json.loads((vault / demo.MARKER).read_text(encoding="utf-8"))
    assert marker["state"] == "seeding"
    assert len(WikiStore(vault).list_pages()) == 1
    before = file_snapshot(vault)
    with pytest.raises(demo.DemoSeedError, match="interrupted"):
        demo.seed_vault(vault, template)
    assert file_snapshot(vault) == before
    monkeypatch.setattr(WikiStore, "save_page", original)
    assert demo.seed_vault(vault, template, resume=True)["status"] == "created"
    assert len(WikiStore(vault).list_pages()) == 2
    assert demo.seed_vault(vault, template)["status"] == "unchanged"


def test_resume_refuses_edited_partial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    template = template_at(tmp_path)
    vault = tmp_path / "demo"
    original = WikiStore.save_page

    def fail_on_sky(self: WikiStore, page_id: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
        if page_id == "sky":
            raise RuntimeError("interrupted")
        return original(self, page_id, *args, **kwargs)

    monkeypatch.setattr(WikiStore, "save_page", fail_on_sky)
    with pytest.raises(RuntimeError):
        demo.seed_vault(vault, template)
    monkeypatch.setattr(WikiStore, "save_page", original)
    store = WikiStore(vault)
    home = store.get_page("home")
    assert home is not None
    store.save_page("home", "# User change\n", home["revision"], "partial-edit")
    before = file_snapshot(vault)
    with pytest.raises(demo.DemoSeedError, match="changed or added"):
        demo.seed_vault(vault, template, resume=True)
    assert file_snapshot(vault) == before
    assert store.get_page("sky") is None


def test_cli_requires_explicit_vault_and_reports_refusal(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        demo.main([])
    assert exc.value.code == 2
    template = template_at(tmp_path)
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    (occupied / "note").write_text("Keep me", encoding="utf-8")
    assert demo.main(["--vault", str(occupied), "--template", str(template)]) == 1
    assert "Demo seed refused" in capsys.readouterr().err


def test_shipped_demo_has_twelve_fictional_pages_and_no_dangling_links(tmp_path: Path) -> None:
    import re

    template = demo.default_template()
    pages = demo._read_template(template)
    assert len(pages) == 12
    assert all("Fictional demonstration" in markdown for markdown in pages.values())
    targets = {
        target
        for markdown in pages.values()
        for target in re.findall(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", markdown)
    }
    assert targets <= pages.keys()
    vault = tmp_path / "full-demo"
    assert demo.seed_vault(vault)["pages"] == 12
    assert len(WikiStore(vault).list_pages()) == 12
