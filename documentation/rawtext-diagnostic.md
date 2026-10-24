# Full-document rawtext diagnosis

This opt-in developer check records observations from the real article path.
A completed collection is **not** Markdown/graph parity acceptance. SCRIPT
article bodies are excluded; backend rawtext link/excerpt projection and
STYLE/TEXTAREA behavior still have known differences.

Use a disposable local managed demo, never a personal or production vault.
From the repository root start `make demo` in one terminal. In another:

```sh
cd frontend
WIKI_RAWTEXT_ORACLE=1 npx playwright test e2e/rawtext-oracle.spec.ts
```

The normal locked install and Playwright browser prerequisites from
[demo-start.md](demo-start.md) apply. The test is not selected by the broad
acceptance runner and is skipped without the explicit environment opt-in.
To inspect another engine, set `PLAYWRIGHT_BROWSER_ENGINE=webkit` using the
same browser configuration. This does not call a model or enable remote indexes.

The test creates only UUID-named synthetic pages, then deletes its owned pages
with current revisions. Their Git history remains in that disposable vault.
It emits `rawtext-oracle.json` attachments and structured console rows, plus
selected screenshots, under Playwright's output directory.

The 36 versioned inputs cover SCRIPT closing-tag variants, quoted attributes,
comments/double escapes, transformed closers, unclosed bodies, paragraph,
heading/list/quote/table boundaries, a typed relation and missing target.
KBD/PRE/CODE, escaped and fenced examples and separate STYLE/TEXTAREA cases
remain explicit controls. Each whole document is rendered by the application;
there is no second Markdown implementation in the diagnostic.

An init script observes the application's native DOMParser call without changing
the returned Document or the renderer's input. It captures Marked's emitted
HTML and original parsed DOM, retains the same Document reference for a later
snapshot after application SCRIPT removal, then records the final sanitized
article HTML, visible text and actual anchors. A nonempty canonical control link
before every tested body prevents an empty article from masquerading as success.

Each row also records graph edges/typed relations, missing/ambiguous diagnostics,
the target's source backlink, the backend excerpt and lexical search by both the
exact synthetic page ID and a unique term in its rawtext content. Only the owned
source's search rows may be serialized. The saved Markdown and revision must
read back unchanged. Lexical results describe current raw-source search, not
semantic/hosted retrieval. Attachment failure or one failed deletion does not
stop attempts to remove the remaining owned pages; cleanup errors fail collection.
The `targetsAgree` field compares target sets only; it is not a label, relation,
excerpt or retrieval-quality assertion. Missing/ambiguous diagnostics are separate.

Use the exact emitted HTML and DOM evidence to design a backend correction.
Do not infer SCRIPT ownership from a source regex or Marked's general raw-block
flag, and do not silently suppress KBD controls. A backend projection change
must separately invalidate derived index configuration and prove old receipts
become pending and rebuild at the same content HEAD. This tool changes no
application renderer, backend projection, index identity or source Markdown.

## Initial measured scope, 24 October 2026

On application parent9ed78731, native Linux Chromium collected all72 rows
(36 whole documents at390/1440).48 rows differ in backend/rendered target sets;
this is24 repeated forms, not48 unique defects or a passing parity test.
All72 unique sentinel queries match the synthetic source through the existing
raw-Markdown lexical search, including literal code examples. Every observation
contains exactly one native parser capture and no remaining SCRIPT nodes after
application removal; no execution marker or page error was observed. Exact
source/revision readbacks, fixture deletion and owned service shutdown pass.
Selected narrow/wide screenshots were personally inspected. Both TypeScript
projects pass. Cached minimal dependencies and local Chromium are separate
from clean locked CI, WebKit and physical-device acceptance for this new tool.
