"""Selected emphasis/URL boundaries checked against frontend Marked 12.0.2.

Static expectations were independently checked with the main.ts wiki tokenizer;
Marked/Node are not backend test dependencies. No general nested-Markdown parity
is asserted by this deliberately bounded matrix.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, _markdown_escaped, prose_links

URL = "HTTPS://example.test/[[hidden]]"
CASES = [
    (f"**{URL}** *note* [[shown]]", {"shown"}),
    (f"*note* **{URL}** [[shown]]", {"shown"}),
    (f"**{URL}** [label](/path) [[shown]]", {"shown"}),
    (f"**{URL}** `code` [[shown]]", {"shown"}),
    (f"**{URL}** &amp; [[shown]]", {"shown"}),
    (f"**{URL}** <span>note</span> [[shown]]", {"shown"}),
    (f"**{URL}** ![image](/image.png) [[shown]]", {"shown"}),
    (f"(**{URL}**) [[shown]]", {"shown"}),
    (f"**{URL}**\n*note* [[shown]]", {"shown"}),
    (f"*{URL}* *note* [[shown]]", {"shown"}),
    (f"***{URL}*** *note* [[shown]]", {"shown"}),
    (f"__{URL}__ *note* [[shown]]", {"shown"}),
    (f"**{URL}** **HTTPS://other.test/[[hidden2]]** [[shown]]", {"shown"}),
    (f"**{URL} prose [[shown]]**", {"shown"}),
    (f"**prose {URL} [[shown]]**", {"hidden", "shown"}),
    (f"`**{URL}**` [[shown]]", {"shown"}),
    (f"<a href='/'>**{URL}**</a> [[shown]]", {"hidden", "shown"}),
    (f'[label](/path "**{URL}**") [[shown]]', {"shown"}),
    (rf"prefix \*word {URL}* [[shown]]", {"hidden", "shown"}),
    (f"**{URL}**word [[shown]]", {"hidden", "shown"}),
    (f"word__{URL}__ [[shown]]", {"hidden", "shown"}),
    (f"prefix {URL} [[shown]]", {"hidden", "shown"}),
    ("prefix https://example.test/[[hidden]] [[shown]]", {"shown"}),
    (f"**{URL}**\u001cword [[shown]]", {"hidden", "shown"}),
    (f"**{URL}**\u0085word [[shown]]", {"hidden", "shown"}),
]


@pytest.mark.parametrize("markdown,expected", CASES)
def test_emphasis_url_scopes(markdown: str, expected: set[str]) -> None:
    prose = prose_links(markdown)
    actual = {
        match.group(1).strip()
        for match in LINK_RE.finditer(prose)
        if not _markdown_escaped(prose, match.start())
    }
    assert actual == expected


def test_emphasis_scopes_preserve_source_history_and_rebuilt_edges(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "hidden2", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# Scoped emphasis\r\n\r\n"
        f"**{URL}** *note* [[shown|Visible]]\r\n\r\n"
        "__HTTPS://other.test/[[hidden2]]__ `code`\r\n"
    )
    saved = store.save_page("source", markdown, None, "first")
    reopened = WikiStore(tmp_path)
    current = reopened.get_page("source")
    assert current is not None
    assert current["markdown"] == markdown
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    assert "HTTPS://example.test/" in saved["excerpt"]
    assert "note" in saved["excerpt"]
    assert reopened.graph()["edges"] == [
        {"source": "source", "target": "shown", "type": "wikilink"}
    ]
    assert reopened.backlinks("shown")["total"] == 1
    for target in ("hidden", "hidden2"):
        assert reopened.backlinks(target)["total"] == 0
    changed = markdown + "\r\n[[hidden|Deliberate]]\r\n"
    reopened.save_page("source", changed, saved["revision"], "second")
    updated = WikiStore(tmp_path)
    assert updated.backlinks("hidden")["total"] == 1
    assert updated.backlinks("hidden2")["total"] == 0
    assert len(updated.history("source")) == 2
    assert updated._git("show", "HEAD~1:pages/source.md") == markdown.encode()
    assert updated._git("show", "HEAD:pages/source.md") == changed.encode()
