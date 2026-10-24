# Bounded inline SCRIPT projection

The article removes native SCRIPT subtrees before sanitizing other elements.
Previously a simple `Note <script>[[hidden]]</script>` still supplied a graph
edge and excerpt text. The backend now masks that island in a conservative
whole-document subset before its existing link/excerpt projection.

Eligibility is deliberately narrow: flat ASCII prose, simple ATX headings and
restricted wikilinks; exact ASCII-case `<script>...</script>` pairs inline in
prose; one optional double-quoted ASCII attribute is admitted in a restricted
alphabet, including `data-note="x>y"` and bracketed attribute text. The quoted
angle does not terminate the tag and attribute wikilinks remain metadata.
Bodies exclude `<`, `&`, backticks, backslashes and line breaks. Any
unsupported construct anywhere returns the whole original string unchanged.
Headings with links, containers, code, multiple/unquoted/single-quoted
attributes, multiline SCRIPT, nested
HTML and escape-state cases are not generalized. A Unicode lookalike such as
`<ſcript>` is not SCRIPT. Ordered-list code cannot become a removable island.

Masking preserves character positions and line breaks. Original Markdown,
page revision, history, title derivation and lexical raw-source search are
unchanged. This is not an HTML sanitizer, source rewrite or general parity
solution. Existing complex SCRIPT and separate STYLE/TEXTAREA gaps remain.
`managed-snapshots-v37` invalidates graph and vector receipts even with the
same content HEAD; rebuilding derived data does not require a page save.

## Current quoted-attribute verification, 24 October 2026

The quoted-angle case comes from the retained 36-form oracle. The v37
extension admits one ASCII-name/double-quoted attribute with a restricted ASCII
value; entities, escapes, angle openers, multiline values and extra attributes
fall back atomically. Independent review found no additional soundness or
complexity issue. Existing source/title/history/search contracts are unchanged.

184 selected backend tests plus28 subtests, Ruff, local strict mypy for the
three changed helper/test files and both TypeScript projects pass. Six actual
Chromium browser tests pass: four SCRIPT-suite tests and two full-oracle tests.
The full oracle completes72 observations with40 target-set differences, down
from42 on40d066c8; the quoted-angle form matches at both widths. This is20
repeated forms, not40 unique defects or a parity success.

An additional22-observation native collection covers11 inputs at390/1440,
including quoted angle, attribute wikilinks and `type="text/javascript"`.
Actual emitted HTML/native DOM/article anchors match real API graph targets;
source/revision, no execution/page errors and owned-page/service cleanup pass.
[Synthetic native originals](evidence/quoted-script-local.json) are retained;
narrow/wide quoted-case screenshots were inspected. This uses restored minimal
Python dependencies and Chromium153, separate from locked CI/WebKit/devices.
The v36→v37 same-content receipt regression covers both adapters with local
doubles, failed build/refusal and successful retry; no hosted-provider claim.

## Reproduce

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
marker, visible suffix, two islands, three quoted-attribute cases, ordered-list code, a Unicode tag and
literal code. These tests are included wherever the existing SCRIPT suite is
selected. The original full-document diagnostic remains separate and opt-in.

## Historical v36 verification

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

The full 36-form opt-in diagnostic was subsequently rerun on the v36 application:
72 complete observations, 42 target-set differences (21 repeated forms) versus
the parent's 48. This is target-set diagnosis, not full parity acceptance.
All observations retain one native capture, source/revision equality and no
execution/page errors; owned fixtures/services were removed. Complex closing,
escape/container states and STYLE/TEXTAREA remain among the differences.
The first CI backend run stopped at strict test typing before pytest; explicit
return types, Optional checks and typed read dispatch were then corrected.
The three changed source/test files pass local strict mypy, and the five new
tests plus 24 subtests pass again. The subsequent40d066c8 full CI passes all six
domains, including1481 backend tests plus24 subtests and959 browser execution
instances; those results belong to v36 and are not v37 CI acceptance.
