"""Escaped literal brackets must not swallow a following real wiki token.

Expectations match the installed frontend Marked12 tokenizer. Only the rejected
escaped opener is skipped; accepted wikilinks still consume their whole token.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize(
    "markdown,targets",
    [
        (r"\[[[shown]]]", {"shown"}),
        (r"prefix \[[[shown|Readable]]] suffix", {"shown"}),
        (r"\[[[shown#notes|Readable]]]", {"shown"}),
        (r"\[[literal]] [[shown]]", {"shown"}),
        (r"\[[shown]]", set()),
        (r"\\[[shown]]", {"shown"}),
        (r"\\\[[[shown]]]", {"shown"}),
        (r"[[outer [[hidden]] tail]] [[shown]]", {"shown"}),
        (r"[[[hidden]]] [[shown]]", {"shown"}),
        (r"`\[[[hidden]]]` [[shown]]", {"shown"}),
        (r"[label](/path/\[[[hidden]]]) [[shown]]", {"shown"}),
        (r"![alt \[[[hidden]]]](/image.png) [[shown]]", {"hidden", "shown"}),
    ],
)
def test_escaped_opener_graph_matches_visible_tokens(markdown: str, targets: set[str]) -> None:
    pages = [{"id": target, "title": target, "markdown": ""} for target in ("shown", "hidden")]
    pages.append({"id": "source", "title": "Source", "markdown": markdown})
    graph = WikiStore._graph(pages, "synthetic-revision")
    assert {edge["target"] for edge in graph["edges"]} == targets
    assert all(edge["source"] == "source" for edge in graph["edges"])


def test_literal_prefix_does_not_invent_a_typed_relation(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("shown", "# Shown", None, "target")
    markdown = "# Synthetic bracket guide\r\n\r\nrelated:: \\[[[shown|Readable]]]\r\n"
    saved = store.save_page("source", markdown, None, "source")
    reopened = WikiStore(tmp_path)
    assert reopened.graph()["edges"] == [
        {"source": "source", "target": "shown", "type": "wikilink"}
    ]
    assert reopened.backlinks("shown")["total"] == 1
    assert reopened.get_page("source")["markdown"] == markdown
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    assert len(reopened.history("source")) == 1
    changed = "# Synthetic bracket guide\n\nrelated:: [[shown|Readable]]\n"
    reopened.save_page("source", changed, saved["revision"], "typed")
    assert WikiStore(tmp_path).graph()["edges"] == [
        {"source": "source", "target": "shown", "type": "wikilink", "rel": "related"}
    ]
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()


@pytest.mark.parametrize(
    "markdown,missing",
    [
        ("[[outer [[hidden]] tail]] [[shown]]", "outer [[hidden"),
        ("[[[hidden]]] [[shown]]", "[hidden"),
    ],
)
def test_accepted_outer_token_does_not_expose_nested_target(markdown: str, missing: str) -> None:
    pages = [{"id": target, "title": target, "markdown": ""} for target in ("shown", "hidden")]
    pages.append({"id": "source", "title": "Source", "markdown": markdown})
    graph = WikiStore._graph(pages, "synthetic-revision")
    assert graph["edges"] == [{"source": "source", "target": "shown", "type": "wikilink"}]
    assert graph["missing_targets"] == [{"source": "source", "target": missing}]
