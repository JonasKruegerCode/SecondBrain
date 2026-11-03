"""Literal expectations verified with Marked 12 and main.ts's wikilink extension.

Node is used only when deriving this corpus, never when running these tests.
Whitespace-only markers can be paragraphs; a four-column continuation can
remain paragraph text in a wide ordered item, but becomes code after a blank.
"""

import subprocess
from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore

CASES = [
    pytest.param("- \n\n    [[x]]\n\n[[y]]", ["y"], id="whitespace-marker"),
    pytest.param("-\t\n\n    [[x]]\n\n[[y]]", ["y"], id="tab-marker"),
    pytest.param("-\n\n    [[x]]\n\n[[y]]", ["y"], id="bare-empty-item"),
    pytest.param("-  \n\n    [[x]]\n\n[[y]]", ["x", "y"], id="two-space-empty-item"),
    pytest.param("+ \n\n    [[x]]\n\n[[y]]", ["y"], id="plus-marker"),
    pytest.param("1. \n\n    [[x]]\n\n[[y]]", ["y"], id="empty-ordered-marker"),
    pytest.param("- outer\n  - \n\n      [[x]]\n\n[[y]]", ["y"], id="nested-empty"),
    pytest.param("123. [[x]]\n    [[y]]\n\n[[z]]", ["x", "y", "z"], id="wide-lazy-prose"),
    pytest.param("123. [[x]]\n\t[[y]]\n\n[[z]]", ["x", "y", "z"], id="wide-tab-prose"),
    pytest.param("123. [[x]]\n\n    [[y]]\n\n[[z]]", ["x", "z"], id="wide-blank-code"),
    pytest.param("1. [[x]]\n    [[y]]\n\n[[z]]", ["x", "y", "z"], id="narrow-prose"),
    pytest.param("- [[x]]\n    [[y]]\n\n[[z]]", ["x", "y", "z"], id="bullet-prose"),
    pytest.param(
        "- outer\n  123. [[x]]\n      [[y]]\n\n[[z]]", ["x", "y", "z"], id="nested-wide-prose"
    ),
    pytest.param("    [[x]]\n\n[[y]]", ["y"], id="standalone-code"),
    pytest.param("Intro\n    [[x]]\n\n[[y]]", ["x", "y"], id="paragraph-continuation"),
    pytest.param("123. ## Heading\n    [[x]]\n\n[[y]]", ["y"], id="heading-ends-paragraph"),
    pytest.param("> - \n>\n>     [[x]]\n\n[[y]]", ["y"], id="quoted-empty-marker"),
    pytest.param("- ```\n  [[x]]\n  ```\n\n[[y]]", ["y"], id="list-fence"),
    pytest.param("- <!--\n  [[x]]\n  -->\n\n[[y]]", ["y"], id="list-comment"),
    pytest.param("Heading\n===\n    [[x]]\n\n[[y]]", ["y"], id="setext-heading"),
    pytest.param("| a |\n| - |\n    [[x]]\n\n[[y]]", ["y"], id="gfm-table-boundary"),
    pytest.param("[ref]: /url\n    [[x]]\n\n[[y]]", ["y"], id="definition-boundary"),
    pytest.param('[ref]: /url "title"\n    [[x]]\n\n[[y]]', ["y"], id="definition-with-title"),
    pytest.param("[ref]:\n  /url\n    [[x]]\n\n[[y]]", ["y"], id="multiline-definition"),
    pytest.param("123. [ref]: /url\n    [[x]]\n\n[[y]]", ["y"], id="ordered-definition"),
    pytest.param("<div>\n    [[x]]\n\n[[y]]", ["y"], id="html-block-boundary"),
    pytest.param("<div>\nbody\n    [[x]]\n\n[[y]]", ["y"], id="html-block-body"),
    pytest.param("<span>\n    [[x]]\n\n[[y]]", ["y"], id="standalone-custom-html"),
    pytest.param('<custom title="<">\n    [[x]]\n\n[[y]]', ["y"], id="quoted-html-angle"),
    pytest.param("<?pi?>\n    [[x]]\n\n[[y]]", ["y"], id="processing-instruction"),
    pytest.param("<!DOCTYPE html>\n    [[x]]\n\n[[y]]", ["y"], id="html-declaration"),
    pytest.param("<![CDATA[raw]]>\n    [[x]]\n\n[[y]]", ["y"], id="cdata-boundary"),
    pytest.param("<span>inline</span>\n    [[x]]\n\n[[y]]", ["x", "y"], id="inline-html-prose"),
    pytest.param(
        '<span title="x">inline</span>\n    [[x]]\n\n[[y]]',
        ["x", "y"],
        id="inline-html-attribute-prose",
    ),
    pytest.param("<https://example.org>\n    [[x]]\n\n[[y]]", ["x", "y"], id="autolink-prose"),
    pytest.param(
        "[ref]: /url\n\nIntro\n    [[x]]\n\n[[y]]",
        ["x", "y"],
        id="definition-blank-resumes-prose",
    ),
    pytest.param(
        "<div>\n\nIntro\n    [[x]]\n\n[[y]]",
        ["x", "y"],
        id="html-blank-resumes-prose",
    ),
]


@pytest.mark.parametrize("markdown, expected", CASES)
def test_list_paragraph_boundaries_preserve_store_evidence(
    tmp_path: Path, markdown: str, expected: list[str]
) -> None:
    store = WikiStore(tmp_path / "vault")
    for target in ("x", "y", "z"):
        store.save_page(target, f"# Target {target}", None, target)
    saved = store.save_page("source", markdown, None, "source")
    reopened = WikiStore(store.path)
    read = reopened.get_page("source")
    assert read is not None
    assert read["markdown"] == markdown
    assert read["title"] == "source"
    assert read["excerpt"] == saved["excerpt"]
    assert read["revision"] == saved["revision"]
    raw = subprocess.run(
        ["git", "--git-dir", str(store.repo), "show", "HEAD:pages/source.md"],
        capture_output=True,
        check=True,
    ).stdout
    assert raw == markdown.encode("utf-8")
    history = reopened.history("source")
    assert len(history) == 1
    historical = subprocess.run(
        ["git", "--git-dir", str(store.repo), "show", f"{history[0]['commit']}:pages/source.md"],
        capture_output=True,
        check=True,
    ).stdout
    assert historical == raw
    graph = reopened.graph()
    assert graph["edges"] == [
        {"source": "source", "target": target, "type": "wikilink"} for target in expected
    ]
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []
    for target in ("x", "y", "z"):
        backlinks = reopened.backlinks(target)
        assert backlinks["revision"] == graph["revision"]
        assert backlinks["total"] == int(target in expected)
        assert [row["id"] for row in backlinks["backlinks"]] == (
            ["source"] if target in expected else []
        )


def test_list_paragraph_edit_retains_history_title_and_excerpt(tmp_path: Path) -> None:
    store = WikiStore(tmp_path / "vault")
    for target in ("x", "y", "z"):
        store.save_page(target, f"# Target {target}", None, target)
    before_body = "123. [[x]]\n    [[y]]\n\n[[z]]"
    before = store.save_page("source", before_body, None, "before")
    after_body = "123. [[x]]\n\n    # Hidden heading\n    [[y]]\n\n# Actual heading\n[[z]]"
    after = store.save_page("source", after_body, before["revision"], "after")
    reopened = WikiStore(store.path)
    read = reopened.get_page("source")
    assert read is not None
    assert read["markdown"] == after_body
    assert read["title"] == "Actual heading"
    assert read["excerpt"] == "x z"
    assert after["revision"] != before["revision"]
    assert reopened.backlinks("y")["total"] == 0
    assert [edge["target"] for edge in reopened.graph()["edges"]] == ["x", "z"]
    history = reopened.history("source")
    assert len(history) == 2
    historical = [
        subprocess.run(
            ["git", "--git-dir", str(store.repo), "show", f"{row['commit']}:pages/source.md"],
            capture_output=True,
            check=True,
        ).stdout
        for row in history
    ]
    assert set(historical) == {before_body.encode(), after_body.encode()}
