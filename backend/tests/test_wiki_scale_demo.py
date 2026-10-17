"""Large synthetic vault fixture safety and real-store graph contracts."""

from pathlib import Path

import pytest

from second_brain.wiki.scale_demo import ScaleFixtureError, create_scale_vault, synthetic_pages
from second_brain.wiki.store import WikiStore


def test_scale_fixture_imports_one_real_snapshot_with_curated_groups(tmp_path: Path) -> None:
    vault = tmp_path / "large-vault"
    result = create_scale_vault(vault, count=251, groups=7)
    store = WikiStore(vault)
    graph = store.graph()

    assert result["pages"] == len(graph["nodes"]) == 251
    assert result["groups"] == 7
    assert result["edges"] == len(graph["edges"])
    assert graph["missing_targets"] == graph["ambiguous_targets"] == []
    assert {node["galaxy"]["group"] for node in graph["nodes"]} == {
        f"synthetic-{number}" for number in range(1, 8)
    }
    assert all("real person, project, or event" in page["markdown"] for page in store.list_pages())


def test_scale_fixture_refuses_nonempty_destination_and_unsafe_sizes(tmp_path: Path) -> None:
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    keep = occupied / "keep.txt"
    keep.write_text("preserve me", encoding="utf-8")

    with pytest.raises(ScaleFixtureError, match="new or empty"):
        create_scale_vault(occupied)
    assert keep.read_text(encoding="utf-8") == "preserve me"
    with pytest.raises(ScaleFixtureError, match="between 251 and 2000"):
        synthetic_pages(250)
