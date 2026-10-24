"""Conservative projection of flat inline SCRIPT islands, never source rewriting.

Whole-document eligibility is intentional: no inference about code, containers,
HTML ancestors, escaped delimiters or complex rawtext tokenizer states.
"""

import re

# One exact double-quoted ASCII attribute is admitted. Its quoted '>' is not
# the tag boundary; entities, escapes, angle openers and multiline values are
# deliberately outside this grammar, as are multiple/unquoted attributes.
_SCRIPT = re.compile(
    r'<script(?: [A-Za-z][A-Za-z0-9-]*="[A-Za-z0-9 ./_:;!?()=+>\[\]-]*")?>'
    r"[^<&`\\\r\n]*</script>",
    re.ASCII | re.IGNORECASE,
)
_WIKI = re.compile(r"\[\[[A-Za-z0-9][A-Za-z0-9.-]*(?:\|[A-Za-z0-9 ,.;:!?()'/-]+)?\]\]")
_PLAIN = re.compile(r"[A-Za-z0-9 ,.;:!?()'\"/=+_-]+")
_HEADING = re.compile(r"#{1,6} [A-Za-z0-9 ,.;:!?()'\"/=+_-]+")
_START = re.compile(r"[A-Za-z0-9]|\[\[")
_ORDERED = re.compile(r"[0-9]{1,9}[.)][ \t]")


def project_flat_scripts(markdown: str) -> str:
    """Mask exact simple SCRIPT pairs only if the entire document is eligible.

    Return unsupported documents byte-for-byte unchanged, including when an
    unsupported construct occurs after an otherwise eligible SCRIPT island.
    Equal-length spaces preserve line and character positions.
    """
    if not _SCRIPT.search(markdown):
        return markdown
    spans: list[tuple[int, int]] = []
    offset = 0
    for line in markdown.split("\n"):
        if not line or _HEADING.fullmatch(line):
            offset += len(line) + 1
            continue
        if not _START.match(line) or _ORDERED.match(line):
            return markdown
        position = 0
        while position < len(line):
            script = _SCRIPT.match(line, position)
            if script:
                spans.append((offset + position, offset + script.end()))
                position = script.end()
                continue
            token = _WIKI.match(line, position) or _PLAIN.match(line, position)
            if not token:
                return markdown
            position = token.end()
        offset += len(line) + 1
    result = list(markdown)
    for start, end in spans:
        result[start:end] = " " * (end - start)
    return "".join(result)
