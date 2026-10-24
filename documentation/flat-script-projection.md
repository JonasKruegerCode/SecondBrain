# Bounded inline SCRIPT projection

The article removes native SCRIPT subtrees before sanitizing other elements.
Previously a simple `Note <script>[[hidden]]</script>` still supplied a graph
edge and excerpt text. The backend now masks that island in a conservative
whole-document subset before its existing link/excerpt projection.

Eligibility is deliberately narrow: flat ASCII prose, simple ATX headings and
restricted wikilinks; exact ASCII-case `<script>...</script>` pairs inline in
prose; bodies exclude `<`, `&`, backticks, backslashes and line breaks. Any
unsupported construct anywhere returns the whole original string unchanged.
Headings with links, containers, code, attributed or multiline SCRIPT, nested
HTML and escape-state cases are not generalized. A Unicode lookalike such as
`<ſcript>` is not SCRIPT. Ordered-list code cannot become a removable island.

Masking preserves character positions and line breaks. Original Markdown,
page revision, history, title derivation and lexical raw-source search are
unchanged. This is not an HTML sanitizer, source rewrite or general parity
solution. Existing complex SCRIPT and separate STYLE/TEXTAREA gaps remain.
`managed-snapshots-v36` invalidates graph and vector receipts even with the
same content HEAD; rebuilding derived data does not require a page save.

## Checks

From the normal backend development environment:

```sh
cd backend
poetry run pytest tests/test_wiki_bounded_script.py tests/test_wiki_bounded_script_indexes.py
```

The store test checks real Git publication, source/revision, graph, diagnostics,
backlinks, excerpt, history, retry and reopen. Index tests use deliberately local
adapter doubles: old receipts become pending, a failed vector build is refused,
and a later successful build changes generations at the same content HEAD.
They do not prove hosted provider delivery or embedding quality.

With the separately running disposable `make demo`:

```sh
cd frontend
npx playwright test e2e/script-exclusion.spec.ts
```

The added browser cases compare actual article anchors and real API graph
edges at 390 and 1440 pixels. They cover exact/mixed SCRIPT, an execution
marker, visible suffix, two islands, ordered-list code, a Unicode tag and
literal code. These tests are included wherever the existing SCRIPT suite is
selected. The original full-document diagnostic remains separate and opt-in.

Local verification on 24 October 2026: 183 selected backend tests plus 24
unittest subtests pass, Ruff passes, and 16 native Linux Chromium observations
across eight inputs at both widths match actual graph/anchor targets. Source
and revision readbacks, fixture deletion, no execution/page errors and owned
service shutdown were checked; narrow/wide screenshots were inspected.
All four tests in the expanded SCRIPT browser suite pass; both TypeScript
projects pass. The retained [synthetic native observations](evidence/flat-script-local.json)
include emitted HTML and native DOM for the 16 bounded/control observations.
These are restored minimal Python dependencies and native Chromium 153 through
Playwright 1.64, separate from full locked CI, WebKit and physical devices.
