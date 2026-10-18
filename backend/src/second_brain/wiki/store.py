"""Markdown snapshots with one Git ref as the publication boundary.

This opt-in profile uses an isolated local bare repository. It deliberately does
not turn a legacy working tree into a second writer. Remote sync and external
indices are not yet attached; reads and mutations require only local Git.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, NamedTuple

REF = "refs/heads/wiki"
ID_RE = re.compile(r"[\w-][\w.-]{0,159}\Z", re.UNICODE)
LINK_RE = re.compile(r"\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]")
TYPED_LINK_RE = re.compile(
    r"(?m)^\s*(?:[-*]\s+)?([A-Za-z][\w -]*?)::\s*"
    r"\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]"
)
MAX_BYTES = 1_000_000
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(?P<body>.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
GALAXY_GROUP_RE = re.compile(r"[A-Za-z0-9][\w.-]{0,79}\Z", re.UNICODE)


def split_frontmatter(markdown: str) -> tuple[str, dict[str, Any]]:
    """Read the tiny, documented galaxy subset without rewriting user YAML.

    The Markdown/Git bytes remain authoritative. Unknown or malformed fields are
    ignored so opening an existing Obsidian-style page never makes it unreadable.
    """
    match = FRONTMATTER_RE.match(markdown)
    if match is None:
        return markdown, {}
    fields: dict[str, str] = {}
    for line in match.group("body").splitlines():
        item = re.fullmatch(r"([a-z][a-z0-9_-]{0,63}):[ \t]*(.*)", line.strip())
        if item is None:
            continue
        value = item.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        fields[item.group(1)] = value
    group = fields.get("galaxy_group", "")
    label = fields.get("galaxy_label", "")
    if not GALAXY_GROUP_RE.fullmatch(group):
        return markdown[match.end() :], {}
    galaxy: dict[str, Any] = {"group": group}
    if label and len(label) <= 80 and "\n" not in label:
        galaxy["label"] = label
    if fields.get("galaxy_anchor", "").casefold() == "true":
        galaxy["anchor"] = True
    return markdown[match.end() :], galaxy


def _without_comments(line: str, in_comment: bool) -> tuple[str, bool]:
    """Read prose comments before interpreting fence markers, preserving inline code."""
    parts: list[str] = []
    while line:
        if in_comment:
            if not parts:
                parts.append(" ")
            _, closing, line = line.partition("-->")
            if not closing:
                return "".join(parts), True
            in_comment = False
        else:
            token = re.search(r"(?P<code>(?P<ticks>`+).*?(?P=ticks))|<!--", line)
            if token is None:
                parts.append(line)
                break
            parts.append(line[: token.start()])
            if token.group("code") is not None:
                parts.append(token.group())
            else:
                # Marked accepts these two complete inline comment tokens.
                # Their following prose must not inherit an open-comment state.
                tail = line[token.end() :]
                if tail.startswith((">", "->")):
                    line = tail[1 if tail.startswith(">") else 2 :]
                    continue
                if not "".join(parts).strip():
                    parts.append(" ")
                in_comment = True
            line = line[token.end() :]
    return "".join(parts), in_comment


# These are paragraph interrupters in the installed Marked 12 blockquote
# grammar. Quote containers admit lazy continuation, even around code fences.
_QUOTE_PREFIX = re.compile(r"^ {0,3}>[ \t]?")
_HTML_BLOCK_TAGS = (
    "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|"
    "details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|"
    "h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|"
    "noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|"
    "th|thead|title|tr|track|ul"
)
_QUOTE_INTERRUPT = re.compile(
    r"^(?: {0,3}(?:#{1,6}(?:\s|$)|>|(?:[*+-]|1[.)]) )"
    r"| {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})$"
    rf"|</?(?:{_HTML_BLOCK_TAGS})(?: +|\n|/?>)|<(?:script|pre|style|textarea|!--))",
)


def _dedent_columns(line: str, columns: int) -> str:
    """Remove only container indentation; tabs in targets and prose are data."""
    position = 0
    width = 0
    while position < len(line) and width < columns and line[position] in " \t":
        width += 1 if line[position] == " " else 4 - width % 4
        position += 1
    return " " * max(0, width - columns) + line[position:]


def _quote_end(lines: list[str], start: int, indent: int, terminated: bool) -> tuple[int, str]:
    """Collect one quote container, preserving its lazy paragraph continuations."""
    inner: list[str] = []
    index = start
    while index < len(lines):
        expanded = lines[index].expandtabs(4)
        if indent and len(expanded) - len(expanded.lstrip(" ")) < indent:
            break
        line = _dedent_columns(lines[index], indent)
        prefix = _QUOTE_PREFIX.match(line)
        if prefix is None:
            break
        content = line[prefix.end() :]
        inner.append(content)
        index += 1
        if not content:
            continue
        while index < len(lines):
            expanded = lines[index].expandtabs(4)
            if indent and len(expanded) - len(expanded.lstrip(" ")) < indent:
                break
            candidate = _dedent_columns(lines[index], indent)
            has_newline = index + 1 < len(lines) or terminated
            fence = has_newline and re.match(r"^ {0,3}(?:`{3,}(?=[^`]*$)|~{3,})", candidate)
            if (
                not candidate.strip()
                or fence
                or _QUOTE_INTERRUPT.match(candidate + ("\n" if has_newline else ""))
            ):
                break
            inner.append(candidate)
            index += 1
    return index, "\n".join(inner)


class _ProseContainer(NamedTuple):
    markdown: str
    prefix: str
    quoted: bool
    list_item: bool = False


_LIST_START = re.compile(r"^( {0,3})([-+*]|[0-9]{1,9}[.)])((?:[ \t].+)?)$")


def _list_item_end(lines: list[str], start: int, match: re.Match[str]) -> tuple[int, str, int]:
    """Normalize one list item using Marked's item/continuation boundaries.

    List indentation is removed only from the container. Outdented lazy lines
    stay in the item until a block boundary or a preceding blank ends them.
    """
    tail = re.sub(r"^\t+", lambda item: " " * (3 * len(item.group())), match.group(3))
    original = match.group(3)
    spaces = len(original) - len(original.lstrip(" "))
    spaces = 1 if spaces > 4 else spaces
    indent = len(match.group(1)) + len(match.group(2)) + (spaces if original else 1)
    inner = [tail[spaces:]]
    index = start + 1
    if not tail and index < len(lines) and not lines[index].strip(" "):
        return index + 1, "", indent
    limit = min(3, indent - 1)
    bullet = re.compile(rf"^ {{0,{limit}}}(?:[*+-]|[0-9]{{1,9}}[.)])(?:[ \t].*)?$")
    fence = re.compile(rf"^ {{0,{limit}}}(?:`{{3}}|~{{3}})")
    heading = re.compile(rf"^ {{0,{limit}}}#")
    rule = re.compile(rf"^ {{0,{limit}}}(?:(?:- *){{3,}}|(?:_ *){{3,}}|(?:\* *){{3,}})$")
    blank = False
    previous = tail
    while index < len(lines):
        line = lines[index]
        if fence.match(line) or heading.match(line) or bullet.match(line) or rule.match(line):
            break
        leading = len(line) - len(line.lstrip(" "))
        if leading >= indent or not line.strip():
            inner.append(line[indent:])
        else:
            previous_leading = len(previous) - len(previous.lstrip(" "))
            if blank or previous_leading >= 4 or fence.match(previous) or heading.match(previous):
                break
            if rule.match(previous):
                break
            inner.append(line)
        blank = blank or not line.strip()
        previous = line[indent:]
        index += 1
    return index, "\n".join(inner).rstrip("\n"), indent


def prose_blocks(markdown: str) -> str:
    """Project prose without making quoted code into links or quoted H1s into titles.

    An explicit work stack handles nested quotes without Python recursion. Only
    this derived projection changes; original Markdown remains authoritative.
    """
    output: list[str] = []
    pending: list[tuple[str | _ProseContainer, str, bool]] = [
        (_ProseContainer(markdown, "", False), "", False)
    ]
    while pending:
        segment, prefix, quoted = pending.pop()
        if isinstance(segment, _ProseContainer):
            quoted = quoted or segment.quoted
            prefix += segment.prefix
            parts = _prose_segments(segment.markdown, quoted=quoted, top=not segment.list_item)
            pending.extend((part, prefix, quoted) for part in reversed(parts))
        else:
            output.append(prefix + segment)
    return "\n".join(output)


def _prose_segments(markdown: str, *, quoted: bool, top: bool) -> list[str | _ProseContainer]:
    # Marked normalizes only line-leading tabs at each container level.
    # Expanding whole lines would change tabs inside explicit link targets.
    markdown = re.sub(
        r"(?m)^( *)(\t+)",
        lambda match: match.group(1) + "    " * len(match.group(2)),
        markdown,
    )
    lines: list[str | _ProseContainer] = []
    fence = ""
    in_comment = False
    block_comment = False
    raw_html = ""
    delimited_html = ""
    blank_html = False
    paragraph = False
    paragraph_barrier = False
    table = False
    previous_prose = ""
    source_lines = markdown.splitlines()
    skip_until = 0
    for line_number, line in enumerate(source_lines):
        if line_number < skip_until:
            continue
        expanded = line.expandtabs(4)
        indent = len(expanded) - len(expanded.lstrip(" "))
        relative = expanded
        terminated = line_number + 1 < len(source_lines) or markdown.endswith(("\r", "\n"))
        if table and (
            indent >= 4
            or _QUOTE_INTERRUPT.match(line + ("\n" if terminated else ""))
            or re.match(r"^ {0,3}(?:`{3,}(?=[^`]*$)|~{3,})", relative)
        ):
            table = False
            paragraph_barrier = False
        # Generic HTML blocks are literal until a blank, even after a closing
        # tag. This state precedes Markdown containers inside the HTML body.
        if blank_html:
            if line.strip(" "):
                continue
            blank_html = False
        # Marked's raw HTML blocks keep Markdown literal through the entire
        # closing-tag line. Blank lines, headings and fences inside are data.
        if raw_html:
            paragraph = False
            if re.search(rf"</{raw_html}>", relative, re.IGNORECASE | re.ASCII):
                raw_html = ""
            continue
        if block_comment:
            # A type-2 HTML token owns the whole closing line, including any
            # apparent Markdown suffix. Inline comments use the separate helper.
            block_comment = "-->" not in line
            continue
        # Types 3/4/5 HTML stop at their delimiter, not at a blank or the
        # end of the closing line. Marked restarts block parsing on any suffix.
        # They do not interrupt a top-level paragraph or GFM table; list block
        # text (top=False) admits them between its own text tokens.
        html_consumed = False
        while delimited_html or (
            not fence
            and not in_comment
            and not table
            and (not top or not paragraph)
            and re.match(r"^ {0,3}(?:<\?|<![A-Z]|<!\[CDATA\[)", line, re.I | re.ASCII)
        ):
            html_consumed = True
            if not delimited_html:
                opening = line.lstrip(" ")
                delimited_html = (
                    "?>"
                    if opening.startswith("<?")
                    else ("]]>" if opening[:9].upper() == "<![CDATA[" else ">")
                )
            paragraph = False
            paragraph_barrier = False
            previous_prose = ""
            _, closing, line = line.partition(delimited_html)
            if not closing:
                line = ""
                break
            delimited_html = ""
            # Container collectors below must see the remainder too. The
            # original Markdown/Git bytes are never changed by this projection.
            source_lines[line_number] = line
        if delimited_html or (html_consumed and not line):
            continue
        expanded = line if html_consumed else line.expandtabs(4)
        indent = len(expanded) - len(expanded.lstrip(" "))
        relative = expanded
        comment_open = re.match(r"^ {0,3}<!--", line) if not fence and not in_comment else None
        if comment_open and ((not table and (not top or not paragraph)) or line.startswith("<!--")):
            body = line[comment_open.end() :]
            block_comment = not (body.startswith((">", "->")) or "-->" in body)
            paragraph = False
            paragraph_barrier = False
            table = False
            previous_prose = ""
            continue
        if not fence and not in_comment and _QUOTE_PREFIX.match(relative):
            paragraph = False
            skip_until, inner = _quote_end(
                source_lines, line_number, 0, markdown.endswith(("\r", "\n"))
            )
            lines.append(_ProseContainer(inner, "> ", True))
            continue
        # Quoted fences use the renderer's exact closing grammar, including
        # mixed marker suffixes. Invalid backtick info remains visible prose.
        if quoted:
            quoted_line = line
            if fence:
                paragraph = False
                if re.fullmatch(rf" {{0,3}}{re.escape(fence)}[~`]* *", quoted_line):
                    fence = ""
                continue
            match = (
                re.match(r"^ {0,3}(`{3,}(?=[^`]*$)|~{3,})", quoted_line) if not in_comment else None
            )
            if match:
                paragraph = False
                fence = match.group(1)
                continue
        else:
            # Fence info is literal, including comment markers. Removing a
            # comment must not create a fence delimiter.
            match = re.match(r"^ {0,3}(`{3,}|~{3,})", relative) if not in_comment else None
            if match:
                paragraph = False
                marker = match.group(1)
                if not fence:
                    fence = marker
                elif (
                    marker[0] == fence[0]
                    and len(marker) >= len(fence)
                    and not relative[match.end() :].strip(" \t")
                ):
                    fence = ""
                continue
            if fence:
                paragraph = False
                continue
        if not in_comment:
            terminated = line_number + 1 < len(source_lines) or markdown.endswith(("\r", "\n"))
            html_line = relative + ("\n" if terminated else "")
            html = re.match(r"^ {0,3}<(?ai:(script|pre|style|textarea))[\s>]", html_line)
            if html:
                paragraph = False
                tag = html.group(1).lower()
                if not re.search(rf"</{tag}>", relative, re.IGNORECASE | re.ASCII):
                    raw_html = tag
                continue
        # Marked's HTML start grammar differs from its paragraph/table
        # interrupters: only column-zero type-6 tags interrupt existing prose.
        # List contents use block text (top=False), not top-level paragraphs.
        html_line = line + ("\n" if terminated else "")
        block_html = re.match(
            rf"^ {{0,3}}</?(?:{_HTML_BLOCK_TAGS})(?: +|\n|/?>)",
            html_line,
            re.IGNORECASE | re.ASCII,
        )
        standalone_html = re.fullmatch(
            r" {0,3}(?:<(?!script|pre|style|textarea)[a-z][\w-]*"
            r"""(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'"""
            r"""| *= *[^\s"'=<>`]+)?)*? */?>"""
            r"|</(?!script|pre|style|textarea)[a-z][\w-]*\s*>)[ \t]*",
            line,
            re.IGNORECASE | re.ASCII,
        )
        html_interrupt = bool(block_html and line.startswith("<"))
        if table and (indent >= 4 or html_interrupt):
            table = False
        if not in_comment and (
            (block_html and (not top or not paragraph or html_interrupt) and not table)
            or (standalone_html and not table and (not top or not paragraph))
        ):
            blank_html = True
            paragraph = False
            paragraph_barrier = False
            continue
        # Definitions and non-generic HTML forms retain their conservative
        # projection. They must not newly admit indented code as paragraph text.
        html_boundary = re.match(r"^ {0,3}<[!?]", relative)
        definition = re.match(r"^ {0,3}\[[^\]]+\]:", relative)
        table_rule = (
            paragraph
            and "|" in previous_prose
            and re.fullmatch(r" {0,3}\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *", relative)
        )
        if html_boundary or definition or table_rule:
            paragraph_barrier = True
            paragraph = False
        if table_rule:
            table = True
            lines.append(line)
            continue

        # Parse list contents before quote/fence contents on the next pass.
        # Keeping a projection-only prefix prevents a nested H1 becoming the
        # page identity while allowing ordinary list prose into excerpts.
        list_item = _LIST_START.match(line) if not in_comment else None
        if (
            list_item
            and top
            and (
                (paragraph and not list_item.group(3).strip())
                or (
                    (paragraph or table)
                    and list_item.group(2)[0].isdigit()
                    and list_item.group(2) not in ("1.", "1)")
                )
            )
        ):
            # Only nonempty items (ordered items starting at 1) interrupt a
            # top-level paragraph. Table rows also reject non-1 interruption.
            list_item = None
        if list_item:
            paragraph = False
            skip_until, inner, content_indent = _list_item_end(source_lines, line_number, list_item)
            table = False
            lines.append(_ProseContainer(inner, " " * content_indent, False, True))
            continue

        if in_comment or indent < 4:
            # A fence marker inside a comment cannot open/close a code block.
            # Indented code cannot start a prose comment either.
            line, in_comment = _without_comments(line, in_comment)
            expanded = line if html_consumed else line.expandtabs(4)
            indent = len(expanded) - len(expanded.lstrip(" "))
            relative = expanded

        if not expanded.strip():
            paragraph = False
            paragraph_barrier = False
            table = False
            previous_prose = ""
            lines.append(line)
            continue
        if indent < 4:
            lines.append(line)
            setext = paragraph and re.fullmatch(r" {0,3}(?:=+|-+) *", expanded)
            paragraph = not bool(
                paragraph_barrier
                or table
                or setext
                or re.match(r"^ {0,3}#{1,6}(?:[ \t]|$)", expanded)
                or re.fullmatch(r" {0,3}(?:(?:- *){3,}|(?:_ *){3,}|(?:\* *){3,})", expanded)
            )
            previous_prose = line
        elif paragraph:
            # Marked merges indented code candidates into existing paragraph
            # text. Preserve indentation so literal headings stay non-titles.
            lines.append(line)
    return lines


def prose_links(markdown: str) -> str:
    """Ignore code examples and comments when deriving explicit prose links."""
    return re.sub(r"(`+).*?\1", "", prose_blocks(markdown), flags=re.DOTALL)


def _markdown_escaped(text: str, position: int) -> bool:
    """Markdown consumes backslashes in pairs before an opening delimiter."""
    start = position
    while start and text[start - 1] == "\\":
        start -= 1
    return (position - start) % 2 == 1


def plain_text_excerpt(markdown: str) -> str:
    """Collapse article prose into a short, presentation-safe summary.

    Excerpts are part of the page API and appear outside the Markdown renderer,
    so formatting tokens must not leak into cards, search results, or chat tool
    context. This intentionally keeps human-readable labels while dropping
    structural Markdown and non-prose blocks.
    """
    lines = []
    for raw_line in prose_links(markdown).splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", ">")):
            continue
        if "|" in line and re.fullmatch(r"[|:\-\s]+", line):
            continue
        line = re.sub(r"^\s*(?:[-+*]|\d+[.)])\s+", "", line)
        line = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"\[\[([^|\]]+)\|([^\]]+)\]\]", r"\2", line)
        line = re.sub(r"\[\[([^\]]+)\]\]", r"\1", line)
        line = re.sub(r"<(https?://[^>]+)>", r"\1", line)
        line = re.sub(r"<[^>]+>", " ", line)
        line = line.strip("|").replace("|", " · ")
        line = line.replace("*", "").replace("~~", "")
        line = re.sub(r"(?<!\w)_{1,2}|_{1,2}(?!\w)", "", line)
        line = line.replace("`", "")
        if line:
            lines.append(line)
    excerpt = " ".join(" ".join(lines).split())
    if len(excerpt) <= 220:
        return excerpt
    boundary = excerpt[:219].rsplit(" ", 1)[0].rstrip(" ,.;:-")
    return f"{boundary or excerpt[:219]}…"


class WikiError(Exception):
    def __init__(self, code: str, message: str, **details: Any) -> None:
        self.code = code
        self.message = message
        self.details = details
        super().__init__(message)


class WikiStore:
    """A single-ref content store; separate processes use Git's compare-and-swap."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).resolve()
        self.path.mkdir(parents=True, exist_ok=True)
        self.repo = self.path / ".wiki.git"
        if self.repo.is_symlink():
            raise WikiError("invalid_vault", "The managed repository must not be a symlink.")
        if not self.repo.exists():
            # Existing Markdown must be explicitly imported, never silently ignored.
            if any(self.path.rglob("*.md")):
                raise WikiError(
                    "import_required", "Existing Markdown requires a controlled import."
                )
            result = subprocess.run(
                ["git", "init", "--bare", "--initial-branch=wiki", str(self.repo)],
                capture_output=True,
                check=False,
            )
            if result.returncode:
                raise WikiError("storage_unavailable", "Unable to initialize local history.")

    def _git(
        self,
        *args: str,
        data: bytes | None = None,
        env: dict[str, str] | None = None,
        check: bool = True,
    ) -> bytes:
        process_env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Managed Wiki",
            "GIT_AUTHOR_EMAIL": "wiki@localhost",
            "GIT_COMMITTER_NAME": "Managed Wiki",
            "GIT_COMMITTER_EMAIL": "wiki@localhost",
            "GIT_LITERAL_PATHSPECS": "1",
            **(env or {}),
        }
        result = subprocess.run(
            ["git", "--git-dir", str(self.repo), *args],
            input=data,
            capture_output=True,
            env=process_env,
            check=False,
        )
        if check and result.returncode:
            raise WikiError("storage_unavailable", "Local Git operation failed.")
        return result.stdout

    def _head(self) -> str:
        return self._git("rev-parse", "--verify", REF, check=False).decode().strip()

    def check_health(self) -> None:
        """Fail when the local content authority is no longer readable.

        An empty, unborn vault is healthy. Once a revision exists, Git must be
        able to resolve it as a commit. This is deliberately a cheap read-only
        readiness probe rather than a full page listing or a synthetic write.
        """
        if self.repo.is_symlink() or not self.repo.is_dir():
            raise WikiError("storage_unavailable", "Local history is unavailable.")
        if self._git("rev-parse", "--is-bare-repository").decode().strip() != "true":
            raise WikiError("storage_unavailable", "Local history is unavailable.")
        head = self._head()
        if head:
            self._git("cat-file", "-e", f"{head}^{{commit}}")

    @staticmethod
    def _validate_id(page_id: str) -> None:
        if not ID_RE.fullmatch(page_id) or page_id in {".", ".."}:
            raise WikiError("invalid_id", "Use a stable page ID without slashes or whitespace.")

    def _blob(self, head: str, path: str) -> bytes | None:
        if not head:
            return None
        if not self._git("ls-tree", head, "--", path):
            return None
        return self._git("show", f"{head}:{path}")

    @staticmethod
    def _page(page_id: str, data: bytes, revision: str) -> dict[str, Any]:
        markdown = data.decode("utf-8")
        content, galaxy = split_frontmatter(markdown)
        heading = re.search(r"^#\s+(.+)$", prose_blocks(content), re.MULTILINE)
        title = heading.group(1).strip() if heading else page_id
        page = {
            "id": page_id,
            "title": title,
            "markdown": markdown,
            "revision": revision,
            "excerpt": plain_text_excerpt(content),
        }
        if galaxy:
            page["galaxy"] = galaxy
        return page

    def get_page(self, page_id: str) -> dict[str, Any] | None:
        self._validate_id(page_id)
        head = self._head()
        data = self._blob(head, f"pages/{page_id}.md")
        revision = self._blob(head, f"revisions/{page_id}")
        return (
            self._page(page_id, data, revision.decode() if revision else "")
            if data is not None
            else None
        )

    def _pages(self, head: str) -> list[dict[str, Any]]:
        blobs = self._snapshot_blobs(head, "pages/", "revisions/")
        pages = []
        for name, data in blobs.items():
            if name.startswith("pages/") and name.endswith(".md"):
                page_id = name.removeprefix("pages/").removesuffix(".md")
                revision = blobs.get(f"revisions/{page_id}", b"").decode()
                pages.append(self._page(page_id, data, revision))
        return sorted(pages, key=lambda page: (page["title"].casefold(), page["id"]))

    def _snapshot_blobs(self, head: str, *prefixes: str) -> dict[str, bytes]:
        """Read one tree with two Git processes, rather than four per page."""
        if not head:
            return {}
        rows = self._git("ls-tree", "-r", "-z", head, "--", *prefixes)
        entries: list[tuple[str, bytes]] = []
        for row in rows.split(b"\0"):
            if row:
                metadata, raw_path = row.split(b"\t", 1)
                _, kind, sha = metadata.split()
                if kind == b"blob":
                    entries.append((raw_path.decode(), sha))
        batch = self._git("cat-file", "--batch", data=b"".join(sha + b"\n" for _, sha in entries))
        blobs: dict[str, bytes] = {}
        offset = 0
        for path, _ in entries:
            end = batch.index(b"\n", offset)
            size = int(batch[offset:end].split()[2])
            offset = end + 1
            blobs[path] = batch[offset : offset + size]
            offset += size + 1
        return blobs

    def list_pages(self) -> list[dict[str, Any]]:
        return self._pages(self._head())

    def search(self, query: str) -> list[dict[str, Any]]:
        terms = query.casefold().strip().split()
        if not terms:
            return []
        pages = self.list_pages()
        hits = [
            p for p in pages if all(t in (p["id"] + " " + p["markdown"]).casefold() for t in terms)
        ]
        return sorted(
            hits,
            key=lambda p: (
                0 if query.casefold() in {p["id"].casefold(), p["title"].casefold()} else 1,
                p["title"].casefold(),
            ),
        )[:50]

    def graph(self) -> dict[str, Any]:
        result: dict[str, Any] = self.snapshot()["graph"]
        return result

    def backlinks(self, page_id: str, limit: int = 20) -> dict[str, Any]:
        """Read bounded incoming explicit links from one immutable content snapshot."""
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise WikiError("invalid_payload", "limit must be an integer between 1 and 100.")
        snapshot = self.snapshot()
        pages = {page["id"]: page for page in snapshot["pages"]}
        if page_id not in pages:
            raise WikiError("not_found", "The page does not exist.")
        sources: dict[str, set[str]] = {}
        for edge in snapshot["graph"]["edges"]:
            if edge["target"] != page_id or edge["source"] == page_id:
                continue
            relations = sources.setdefault(edge["source"], set())
            if edge.get("rel"):
                relations.add(edge["rel"])
        ordered = sorted(sources, key=lambda key: (pages[key]["title"].casefold(), key))
        return {
            "revision": snapshot["revision"],
            "target_revision": pages[page_id]["revision"],
            "backlinks": [
                {
                    key: value
                    for key, value in pages[source].items()
                    if key in {"id", "title", "revision", "excerpt"}
                }
                | {"relations": sorted(sources[source])}
                for source in ordered[:limit]
            ],
            "total": len(ordered),
            "truncated": len(ordered) > limit,
        }

    @staticmethod
    def _resolve_target(
        raw_target: str, source: str, ids: set[str], titles: dict[str, set[str]]
    ) -> tuple[str, list[str]]:
        target = raw_target.split("#", 1)[0].strip()
        if not target and raw_target.strip().startswith("#"):
            target = source
        if target in ids:
            return target, [target]
        return target, sorted(titles.get(target.casefold(), set()))

    def resolve_links(self, targets: list[str], source: str = "") -> dict[str, Any]:
        """Resolve a bounded article batch against one immutable content snapshot."""
        head = self._head()
        pages = {p["id"]: p for p in self._pages(head)}
        titles: dict[str, set[str]] = {}
        for page in pages.values():
            titles.setdefault(page["title"].casefold(), set()).add(page["id"])
        ids = set(pages)
        resolutions = []
        for raw in targets:
            _, candidates = self._resolve_target(raw, source, ids, titles)
            resolutions.append(
                {
                    "target": raw,
                    "status": "resolved"
                    if len(candidates) == 1
                    else ("ambiguous" if candidates else "missing"),
                    "fragment": raw.partition("#")[2],
                    "candidates": [{"id": key, "title": pages[key]["title"]} for key in candidates],
                }
            )
        return {"revision": head or None, "resolutions": resolutions}

    def snapshot(self) -> dict[str, Any]:
        """Capture content and its derived graph at one immutable Git commit."""
        head = self._head()
        pages = self._pages(head)
        return {"revision": head or None, "pages": pages, "graph": self._graph(pages, head)}

    @staticmethod
    def _graph(pages: list[dict[str, Any]], head: str) -> dict[str, Any]:
        ids = {p["id"] for p in pages}
        titles: dict[str, set[str]] = {}
        for page in pages:
            titles.setdefault(page["title"].casefold(), set()).add(page["id"])
        edges: set[tuple[str, str, str | None]] = set()
        missing: set[tuple[str, str]] = set()
        ambiguous: set[tuple[str, str, tuple[str, ...]]] = set()
        for page in pages:
            content, _ = split_frontmatter(page["markdown"])
            prose = prose_links(content)
            links: list[tuple[str, str | None]] = [
                (match.group(2), re.sub(r"[^\w]+", "_", match.group(1).strip().lower()).strip("_"))
                for match in TYPED_LINK_RE.finditer(prose)
                if not _markdown_escaped(prose, match.start(2) - 2)
            ]
            links.extend(
                (match.group(1), None)
                for match in LINK_RE.finditer(prose)
                if not _markdown_escaped(prose, match.start())
            )
            outgoing: set[tuple[str, str | None]] = set()
            for raw_target, rel in links:
                target, candidates = WikiStore._resolve_target(raw_target, page["id"], ids, titles)
                if not target:
                    continue
                if len(candidates) > 1:
                    ambiguous.add((page["id"], target, tuple(candidates)))
                    continue
                if not candidates:
                    missing.add((page["id"], target))
                    continue
                resolved = candidates[0]
                outgoing.add((resolved, rel))
            typed_targets = {target for target, rel in outgoing if rel is not None}
            edges.update(
                (page["id"], target, rel)
                for target, rel in outgoing
                if rel is not None or target not in typed_targets
            )
        return {
            "nodes": [
                {
                    "id": p["id"],
                    "title": p["title"],
                    **({"galaxy": p["galaxy"]} if "galaxy" in p else {}),
                }
                for p in pages
            ],
            "edges": [
                {"source": a, "target": b, "type": "wikilink", **({"rel": rel} if rel else {})}
                for a, b, rel in sorted(edges, key=lambda edge: (edge[0], edge[1], edge[2] or ""))
            ],
            "missing_targets": [{"source": a, "target": b} for a, b in sorted(missing)],
            "ambiguous_targets": [
                {"source": a, "target": b, "candidates": list(candidates)}
                for a, b, candidates in sorted(ambiguous)
            ],
            "status": "current",
            "source": "markdown",
            "revision": head or None,
        }

    def save_page(
        self,
        page_id: str,
        markdown: str,
        base_revision: str | None,
        request_id: str,
    ) -> dict[str, Any]:
        return self._mutate(page_id, markdown, base_revision, request_id)

    def delete_page(
        self,
        page_id: str,
        base_revision: str,
        request_id: str,
    ) -> dict[str, Any]:
        return self._mutate(page_id, None, base_revision, request_id)

    def _mutate(
        self,
        page_id: str,
        markdown: str | None,
        base_revision: str | None,
        request_id: str,
    ) -> dict[str, Any]:
        self._validate_id(page_id)
        if not request_id.strip() or len(request_id) > 200:
            raise WikiError(
                "invalid_request_id", "Provide a stable request ID up to 200 characters."
            )
        try:
            data = markdown.encode() if markdown is not None else None
            if data is not None and len(data) > MAX_BYTES:
                raise WikiError("content_too_large", "Pages are limited to one megabyte.")
            payload = json.dumps([page_id, markdown, base_revision], ensure_ascii=False).encode()
            request_bytes = request_id.encode()
        except UnicodeEncodeError:
            # JSON can contain escaped unpaired surrogates. Reject them before
            # reading publication state or reserving an idempotency receipt.
            raise WikiError("invalid_payload", "Provide valid Unicode text.") from None
        fingerprint = hashlib.sha256(payload).hexdigest()
        request_path = f"requests/{hashlib.sha256(request_bytes).hexdigest()}.json"
        page_path = f"pages/{page_id}.md"
        # Retry unrelated concurrent writes. The page's base stays fixed on every retry.
        for _ in range(8):
            head = self._head()
            recorded = self._blob(head, request_path)
            if recorded:
                receipt = json.loads(recorded)
                if receipt["fingerprint"] != fingerprint:
                    raise WikiError("request_id_reused", "This request ID has a different payload.")
                return dict(receipt["result"])
            old = self._blob(head, page_path)
            revision_blob = self._blob(head, f"revisions/{page_id}")
            current = revision_blob.decode() if old is not None and revision_blob else None
            if current != base_revision:
                raise WikiError(
                    "revision_conflict",
                    "The page changed. Read it again before saving.",
                    current_revision=current,
                )
            if data is None and old is None:
                raise WikiError("not_found", "The page no longer exists.")
            new_revision = hashlib.sha256((head + fingerprint + request_id).encode()).hexdigest()
            result: dict[str, Any] = (
                self._page(page_id, data, new_revision) if data is not None else {"id": page_id}
            )
            result.update(
                {
                    "publication": "saved" if data is not None else "deleted",
                    "index": {"graph": "pending", "vector": "pending"},
                    "remote_sync": "not_configured",
                    "request_id": request_id,
                }
            )
            receipt_data = json.dumps(
                {"fingerprint": fingerprint, "result": result}, ensure_ascii=False
            ).encode()
            with tempfile.TemporaryDirectory(prefix="wiki-index-") as tmp:
                env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
                self._git("read-tree", head if head else "--empty", env=env)
                if data is None:
                    deletion = f"0 {'0' * 40}\t{page_path}\n0 {'0' * 40}\trevisions/{page_id}\n"
                    self._git("update-index", "--index-info", data=deletion.encode(), env=env)
                else:
                    blob = self._git("hash-object", "-w", "--stdin", data=data).decode().strip()
                    self._git(
                        "update-index", "--add", "--cacheinfo", "100644", blob, page_path, env=env
                    )
                    revision_sha = (
                        self._git("hash-object", "-w", "--stdin", data=new_revision.encode())
                        .decode()
                        .strip()
                    )
                    self._git(
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        "100644",
                        revision_sha,
                        f"revisions/{page_id}",
                        env=env,
                    )
                blob = self._git("hash-object", "-w", "--stdin", data=receipt_data).decode().strip()
                self._git(
                    "update-index", "--add", "--cacheinfo", "100644", blob, request_path, env=env
                )
                tree = self._git("write-tree", env=env).decode().strip()
                parents = ["-p", head] if head else []
                commit = self._git(
                    "commit-tree",
                    tree,
                    *parents,
                    data=f"wiki: {result['publication']} {page_id}\n".encode(),
                )
                new_head = commit.decode().strip()
                # A single atomic ref transition publishes content and its retry receipt.
                self._git("update-ref", REF, new_head, head or "0" * 40, check=False)
                if self._head() == new_head:
                    return result
                # A later successful writer can already have advanced our commit.
                recorded = self._blob(self._head(), request_path)
                if recorded and json.loads(recorded)["fingerprint"] == fingerprint:
                    return dict(json.loads(recorded)["result"])
        raise WikiError("busy", "Concurrent writes prevented publication. Retry the same request.")

    def history(self, page_id: str) -> list[dict[str, str]]:
        self._validate_id(page_id)
        head = self._head()
        if not head:
            return []
        format_arg = "--format=%H%x09%aI%x09%at%x09%s"
        rows = (
            self._git("log", "-20", "--first-parent", format_arg, head, "--", f"pages/{page_id}.md")
            .decode()
            .splitlines()
        )
        # Imports retain original objects and their path map. Include source
        # history even though managed page paths can differ from source paths.
        for data in self._snapshot_blobs(head, "imports/").values():
            provenance = json.loads(data)
            path = provenance["paths"].get(page_id)
            source = provenance["source_revision"]
            if path and source:
                rows.extend(
                    self._git("log", "-20", "--follow", format_arg, source, "--", path)
                    .decode()
                    .splitlines()
                )
        seen: set[str] = set()
        changes = []
        for row in rows:
            commit, date, timestamp, message = row.split("\t", 3)
            if commit not in seen:
                seen.add(commit)
                changes.append(
                    (int(timestamp), {"commit": commit, "date": date, "message": message})
                )
        return [
            change for _, change in sorted(changes, key=lambda item: item[0], reverse=True)[:20]
        ]
