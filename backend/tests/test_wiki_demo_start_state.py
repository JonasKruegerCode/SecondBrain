"""Real seed state gates service launch; subprocesses are explicit test doubles."""

from __future__ import annotations

import json
import runpy
import signal
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from second_brain.wiki import demo
from second_brain.wiki.store import WikiStore


def launcher(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, MagicMock]:
    script = Path(__file__).resolve().parents[2] / "scripts" / "run-wiki-demo.py"
    main = runpy.run_path(str(script), run_name="demo_state_test")["main"]
    (tmp_path / "frontend" / "node_modules").mkdir(parents=True)
    monkeypatch.setitem(main.__globals__, "__file__", str(tmp_path / "scripts" / script.name))
    processes = MagicMock(side_effect=[MagicMock(pid=4321), MagicMock(pid=4322)])
    monkeypatch.setitem(main.__globals__, "subprocess", SimpleNamespace(Popen=processes))
    monkeypatch.setitem(
        main.__globals__,
        "signal",
        SimpleNamespace(
            SIGTERM=signal.SIGTERM,
            SIGINT=signal.SIGINT,
            signal=lambda *args: None,
        ),
    )
    monkeypatch.setitem(main.__globals__, "_wait_for_children", lambda children: 1)
    monkeypatch.setitem(main.__globals__, "_stop_children", lambda children: None)
    monkeypatch.setitem(
        main.__globals__,
        "seed_vault",
        MagicMock(
            side_effect=AssertionError("An existing managed vault must not be reseeded"),
        ),
    )
    return main, processes


def snapshot(vault: Path) -> dict[str, bytes]:
    return {str(p.relative_to(vault)): p.read_bytes() for p in vault.rglob("*") if p.is_file()}


@pytest.mark.parametrize("mode", [[], ["--empty"], ["--scale-pages", "251"]])
@pytest.mark.parametrize("target_exists", [False, True])
def test_symlink_vault_is_refused_before_seeding_or_launch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: list[str],
    target_exists: bool,
    capsys: pytest.CaptureFixture[str],
) -> None:
    target = tmp_path / "outside"
    if target_exists:
        target.mkdir()
    link = tmp_path / "vault-link"
    link.symlink_to(target, target_is_directory=True)
    main, processes = launcher(tmp_path, monkeypatch)
    # Exercise the real seeder: a pre-resolved link would otherwise write pages.
    monkeypatch.setitem(main.__globals__, "seed_vault", demo.seed_vault)
    with pytest.raises(SystemExit) as caught:
        main(["--vault", str(link), *mode])
    assert caught.value.code == 2
    assert "symbolic link" in capsys.readouterr().err
    processes.assert_not_called()
    assert link.is_symlink()
    assert target.exists() == target_exists
    assert not target.exists() or not any(target.iterdir())


def test_default_demo_vault_symlink_is_also_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    target = tmp_path / "outside"
    target.mkdir()
    demo_root = tmp_path / ".demo"
    demo_root.mkdir()
    (demo_root / "vault").symlink_to(target, target_is_directory=True)
    main, processes = launcher(tmp_path, monkeypatch)
    monkeypatch.setitem(main.__globals__, "seed_vault", demo.seed_vault)
    with pytest.raises(SystemExit) as caught:
        main([])
    assert caught.value.code == 2
    assert "symbolic link" in capsys.readouterr().err
    processes.assert_not_called()
    assert not any(target.iterdir())


def test_fresh_scale_profile_does_not_use_default_demo_vault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "outside"
    target.mkdir()
    demo_root = tmp_path / ".demo"
    demo_root.mkdir()
    (demo_root / "vault").symlink_to(target, target_is_directory=True)
    main, processes = launcher(tmp_path, monkeypatch)
    assert main(["--scale-pages", "251"]) == 1  # Simulated service exit.
    assert processes.call_count == 2
    assert not any(target.iterdir())
    scale = next(demo_root.glob("scale-vault-*/vault"))
    assert len(WikiStore(scale).list_pages()) == 251


@pytest.mark.parametrize("empty", [False, True])
def test_partial_seed_requires_explicit_resume_before_any_service(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    empty: bool,
) -> None:
    template = tmp_path / "template"
    template.mkdir()
    (template / "home.md").write_text("# Synthetic home\n\n[[sky]]\n")
    (template / "sky.md").write_text("# Synthetic sky\n\n[[home]]\n")
    vault = tmp_path / "vault"
    save = WikiStore.save_page

    def interrupt(self: WikiStore, page_id: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
        if page_id == "sky":
            raise RuntimeError("Synthetic interrupted seed")
        return save(self, page_id, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(WikiStore, "save_page", interrupt)
        with pytest.raises(RuntimeError, match="Synthetic interrupted"):
            demo.seed_vault(vault, template)
    assert len(WikiStore(vault).list_pages()) == 1
    assert json.loads((vault / demo.MARKER).read_text())["state"] == "seeding"
    before = snapshot(vault)
    main, processes = launcher(tmp_path, monkeypatch)
    arguments = ["--vault", str(vault)] + (["--empty"] if empty else [])
    with pytest.raises(SystemExit, match="--resume"):
        main(arguments)
    processes.assert_not_called()
    assert snapshot(vault) == before

    # Explicit recovery uses the real seed/store, then later edits remain valid.
    assert demo.seed_vault(vault, template, resume=True)["status"] == "created"
    store = WikiStore(vault)
    home = store.get_page("home")
    assert home is not None
    store.save_page("home", "# Synthetic edited home\n", home["revision"], "edited-home")
    edited = snapshot(vault)
    assert main(arguments) == 1  # Deliberately simulated unexpected service exit.
    assert processes.call_count == 2
    assert snapshot(vault) == edited


@pytest.mark.parametrize(
    "marker",
    [
        "{",
        "[]",
        '{"format":2,"state":"complete"}',
        '{"format":1,"state":"unknown"}',
        '{"format":1,"state":[]}',
        '{"format":1,"state":{}}',
    ],
)
def test_invalid_demo_marker_never_starts_services(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    marker: str,
) -> None:
    vault = tmp_path / "vault"
    WikiStore(vault)
    (vault / demo.MARKER).write_text(marker)
    before = snapshot(vault)
    main, processes = launcher(tmp_path, monkeypatch)
    with pytest.raises(SystemExit, match="marker"):
        main(["--vault", str(vault)])
    processes.assert_not_called()
    assert snapshot(vault) == before


@pytest.mark.parametrize("populated", [False, True])
def test_markerless_managed_profiles_remain_openable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    populated: bool,
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    if populated:
        store.save_page("home", "# Synthetic imported page\n", None, "imported")
    before = snapshot(vault)
    main, processes = launcher(tmp_path, monkeypatch)
    assert main(["--vault", str(vault), "--empty"]) == 1
    assert processes.call_count == 2
    assert snapshot(vault) == before


@pytest.mark.parametrize("empty", [False, True])
def test_completed_marker_without_repository_does_not_create_an_empty_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    empty: bool,
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / demo.MARKER).write_text('{"format":1,"state":"complete"}')
    before = snapshot(vault)
    main, processes = launcher(tmp_path, monkeypatch)
    with pytest.raises(SystemExit, match="repository is missing"):
        main(["--vault", str(vault)] + (["--empty"] if empty else []))
    processes.assert_not_called()
    assert snapshot(vault) == before
