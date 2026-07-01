"""Unit tests for the typed vault operations (agent action space)."""
from pathlib import Path

from second_brain.agent.operations import (
    AddClaim,
    CreatePage,
    EditSection,
    Link,
    MarkOutdated,
    Merge,
    apply_operations,
    parse_operations,
)

PAGE_A = """\
# Second Brain

last_updated: 2026-01-01

A personal memory system.

## Architecture

Wiki is the source of truth.

## Open Bugs

Neo4j get_neighbors is flaky.
"""

PAGE_B = """\
# SecondBrain Project

last_updated: 2026-01-01

Duplicate page about the same [[second-brain|memory system]] project.
"""

PAGE_C = """\
# Watchtower

last_updated: 2026-01-01

Deployment tool, see [[secondbrain-project]] and [[secondbrain-project|the project]].
"""


def _make_vault(tmp_path: Path) -> Path:
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    (wiki / "second-brain.md").write_text(PAGE_A, encoding="utf-8")
    (wiki / "secondbrain-project.md").write_text(PAGE_B, encoding="utf-8")
    (wiki / "watchtower.md").write_text(PAGE_C, encoding="utf-8")
    return wiki


# ---------------------------------------------------------------------------
# parse_operations
# ---------------------------------------------------------------------------

def test_parse_valid_and_invalid_ops() -> None:
    ops, rejected = parse_operations([
        {"op": "add_claim", "page": "second-brain", "text": "New fact."},
        {"op": "edit_section", "page": "second-brain", "section": "Architecture",
         "text": "Updated."},
        {"op": "create_page", "title": "New Page", "content": "Body."},
        {"op": "link", "page": "second-brain", "to": "watchtower"},
        {"op": "merge", "source": "a", "target": "b"},
        {"op": "mark_outdated", "page": "second-brain", "reason": "superseded"},
        {"op": "rewrite_everything", "page": "second-brain"},   # unknown op
        {"op": "add_claim", "page": "second-brain"},            # missing text
        "not an object",
    ])
    assert len(ops) == 6
    assert len(rejected) == 3
    assert isinstance(ops[0], AddClaim)
    assert isinstance(ops[1], EditSection)
    assert isinstance(ops[2], CreatePage)
    assert isinstance(ops[3], Link)
    assert isinstance(ops[4], Merge)
    assert isinstance(ops[5], MarkOutdated)


def test_parse_rejects_non_list() -> None:
    ops, rejected = parse_operations({"op": "add_claim"})
    assert ops == []
    assert rejected


# ---------------------------------------------------------------------------
# apply_operations
# ---------------------------------------------------------------------------

def test_add_claim_into_section(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    result = apply_operations(
        [AddClaim(page="second-brain", section="Open Bugs", text="Watchtower restarts.")],
        wiki,
    )
    content = (wiki / "second-brain.md").read_text(encoding="utf-8")
    assert "Watchtower restarts." in content
    # inserted inside the section, i.e. before nothing else follows — still after old bug
    assert content.index("Neo4j get_neighbors") < content.index("Watchtower restarts.")
    assert "second-brain" in result.changed
    assert "+ Watchtower restarts." in result.changed["second-brain"]


def test_add_claim_creates_missing_section(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    apply_operations(
        [AddClaim(page="second-brain", section="Decisions", text="LangGraph chosen.")],
        wiki,
    )
    content = (wiki / "second-brain.md").read_text(encoding="utf-8")
    assert "## Decisions" in content
    assert "LangGraph chosen." in content


def test_add_claim_unknown_page_is_skipped(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    result = apply_operations([AddClaim(page="nope", text="x")], wiki)
    assert not result.changed
    assert result.skipped


def test_edit_section_replaces_only_that_section(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    apply_operations(
        [EditSection(page="second-brain", section="Architecture",
                     text="Wiki is the source of truth. Graph and vectors are derived.")],
        wiki,
    )
    content = (wiki / "second-brain.md").read_text(encoding="utf-8")
    assert "Graph and vectors are derived." in content
    assert "## Open Bugs" in content
    assert "Neo4j get_neighbors is flaky." in content


def test_edit_section_updates_last_updated(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    apply_operations(
        [EditSection(page="second-brain", section="Architecture", text="New body.")],
        wiki,
    )
    content = (wiki / "second-brain.md").read_text(encoding="utf-8")
    assert "last_updated: 2026-01-01" not in content
    assert content.count("last_updated:") == 1


def test_create_page(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    result = apply_operations(
        [CreatePage(title="LangGraph Agent", content="Shared edit_vault core.")],
        wiki,
    )
    page = wiki / "langgraph-agent.md"
    assert page.exists()
    content = page.read_text(encoding="utf-8")
    assert content.startswith("# LangGraph Agent")
    assert "last_updated:" in content
    assert "langgraph-agent" in result.created


def test_create_page_refuses_existing(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    result = apply_operations(
        [CreatePage(title="Second Brain", content="Would overwrite.")],
        wiki,
    )
    assert not result.created
    assert result.skipped
    assert "Would overwrite." not in (wiki / "second-brain.md").read_text(encoding="utf-8")


def test_link_injects_at_mention(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    apply_operations([Link(page="second-brain", to="watchtower")], wiki)
    content = (wiki / "second-brain.md").read_text(encoding="utf-8")
    assert "[[watchtower|" in content.lower() or "Related: [[watchtower]]" in content


def test_link_appends_when_no_mention(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    (wiki / "unrelated.md").write_text("# Unrelated\n\nNothing here.\n", encoding="utf-8")
    apply_operations([Link(page="unrelated", to="watchtower")], wiki)
    content = (wiki / "unrelated.md").read_text(encoding="utf-8")
    assert "Related: [[watchtower]]" in content


def test_merge_is_lossless_and_rewires_backlinks(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    result = apply_operations(
        [Merge(source="secondbrain-project", target="second-brain")], wiki
    )
    target = (wiki / "second-brain.md").read_text(encoding="utf-8")
    assert "## Merged from: SecondBrain Project" in target
    assert "Duplicate page about the same" in target

    # Source became a redirect stub
    stub = (wiki / "secondbrain-project.md").read_text(encoding="utf-8")
    assert "merged into [[second-brain]]" in stub

    # Backlinks in third pages were rewired, display text preserved
    watchtower = (wiki / "watchtower.md").read_text(encoding="utf-8")
    assert "[[secondbrain-project]]" not in watchtower
    assert "[[second-brain]]" in watchtower
    assert "[[second-brain|the project]]" in watchtower

    assert result.merged
    assert {"second-brain", "secondbrain-project", "watchtower"} <= set(result.changed)


def test_mark_outdated(tmp_path: Path) -> None:
    wiki = _make_vault(tmp_path)
    apply_operations(
        [MarkOutdated(page="watchtower", reason="replaced by manual deploys")], wiki
    )
    content = (wiki / "watchtower.md").read_text(encoding="utf-8")
    assert "> **Outdated:** replaced by manual deploys" in content
    # marker sits right below the H1
    assert content.splitlines()[2].startswith("> **Outdated:**")
