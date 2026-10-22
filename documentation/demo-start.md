# Start the fictional wiki demo

The Lantern Bay field atlas is a standalone sample profile with twelve invented pages. It connects astronomy, coastal ecology, food traditions, and archival history through fictional projects and people. Every page identifies its content as fictional. It contains no user records, and does not require a remote Git repository, an LLM, or the legacy Neo4j/Qdrant services.

Use this profile to try the core editable wiki before attempting a migration of an existing vault. The legacy memory service remains separate; this procedure does not migrate or import its data.

## Run locally

Use the Linux/WSL prerequisites in the [main setup instructions](../README.md).
From the repository root, install the locked dependencies, select Poetry's actual
Python executable and start both services with the isolated launcher:

```bash
(cd backend && poetry sync --no-interaction)
(cd frontend && npm ci)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
```

Open <http://127.0.0.1:5173>. The launcher uses the separate `.demo/vault`,
requires no remote or model key, clears inherited OpenRouter access and retains
your later demo edits. It never seeds an existing nonempty wiki implicitly.
For a new empty destination, explicit template choice or Git import, use the
[first-start profiles](first-start.md). Stop the launcher before starting another
profile on the same ports.

`PYTHON` is one executable path, including paths containing spaces. It is not a
shell command prefix: use the selected environment's Python executable rather
than a value such as `poetry run python` or `python3 -u`.

The empty API-key assignment is an explicit choice for this loopback-only
preview: a Bearer key inherited from another installation would make the browser
receive 401 responses, because this frontend uses same-origin proxy authentication
rather than sending an API Bearer key. It does not change another deployment's
proxy password or settings. Use a normal shell without Git directory/object/index
overrides when creating this local vault; the launcher does not sanitize Git's
own environment or global configuration.

Restart with the same launcher command to reopen your edited `.demo/vault`.
Do not rerun template setup as a restart command: it verifies the original
template and refuses later edits. For an interrupted seed, stop the services and
explicitly resume with the same template using the [first-start procedure](first-start.md).
An existing `.wiki.git` alone does not prove that an interrupted template finished.
The launcher refuses an unfinished or invalid demo marker before starting either
service, including with `--empty`; that flag skips seeding, not recovery. Resume
an interrupted seed explicitly with the same template, then restart normally.
Completed demos may still contain later edits, and markerless empty/imported
managed vaults remain usable without reseeding.

The combined launcher treats both services as long-running peers. If either API
or frontend exits unexpectedly, it stops the other service and returns a nonzero
status instead of reporting a successful demo. Ctrl+C/SIGTERM remains a clean
operator stop. This makes the command suitable for a supervised rehearsal while
still keeping it separate from a production deployment.

The API and npm/Vite each run in a launcher-owned process group. Shutdown signals
both groups even when a wrapper has already exited, escalates remaining groups
and reaps the direct children. Disposable browser/import runners also keep an
owned process receipt so emergency cleanup can reach both groups after a
supervisor exits. Unconfirmed cleanup fails the run, preserves its inputs and
still writes evidence with `service_cleanup_ok=false`. A complete receipt must
identify the expected supervisor and exactly two valid groups. Process receipts
are removed after success and are never included in CI artifact uploads.

During each child launch, Ctrl+C/SIGINT and SIGTERM are deferred until the child
is in the cleanup list and its process receipt is published. The stop is then
honored before another service can start; repeated stop signals do not interrupt
cleanup. This does not block signals in the child. A failed receipt write still
stops the children already tracked in memory and reports an error.

SIGKILL or equivalent uncatchable death between creating a child and recording
its group remains an
unconfirmed shutdown: an incomplete/missing receipt cannot guarantee that every
child stopped. Keep the failed evidence and resolve the owned processes before
starting another run on the same ports. This is process supervision, not a
power-loss or operating-system crash guarantee.

Native loss fixtures exercise this boundary with real SIGKILL and socket
children: a complete receipt lets cleanup stop both recorded groups; an
unfinished receipt cannot identify the newest child. Both runs remain failed
and retain their inputs. A separate test-owner ledger cleans the otherwise
unrecorded fixture child; it is not a recovery mechanism in the demo launcher.

## Run the disposable acceptance rehearsal

The normal automated demo path can be exercised without coordinating two
terminals:

```sh
(cd frontend && npx playwright install --with-deps chromium)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make acceptance PYTHON="$WIKI_PYTHON"
```

The acceptance runner creates a new vault below `.demo/acceptance/`, starts the
real API and Vite frontend, waits for both over loopback without inheriting HTTP
proxy settings, and runs the normal Playwright suite. It always stops the two
services. A successful run removes the mutated disposable vault and keeps
`services.log`, `browser.log`, and `result.json`; `--keep-vault` retains the
vault for inspection. A failed run keeps it automatically for diagnosis.

The JSON record identifies the Git revision, timestamps, browser exit status and
whether the vault was retained. It contains no page content or credentials. This
is deterministic regression evidence only: the runner clears inherited
OpenRouter access and does not replace real model/provider, Compose/HTTPS,
reverse-proxy/authentication or physical-device acceptance.

The API uses an explicit factory and requires `SECOND_BRAIN_WIKI_VAULT`. Importing the module does not create a vault. The managed vault's authoritative Markdown lives in local Git commit snapshots in `.wiki.git`, a bare repository inside the selected directory. It is not a folder of loose Markdown files to edit manually. Use the wiki editor or the normal save API so revisions, links, and search reflect the same saved content.

## Take a short tour

1. Open **Lantern Bay field atlas** and follow the night-sky route.
2. Search for `tide` and inspect how it connects astronomy, ecology, and history.
3. Follow the tide clock, archive method, harvest calendar, and festival links to see the bridges between subjects. Open `/galaxy` to compare the four curated constellations and inspect the actual Markdown links that cross between them.
4. Edit a page, save, and reload it. The saved Markdown remains available from the same local vault.
5. Keep two tabs open on the same page to try revision conflict handling.
6. On a compatible browser, inspect the install action and launch metadata. The
   local host is a secure-context exception; production installation requires HTTPS.

The Chat tab is present but the default demo deliberately clears an inherited
provider key, so opening the fictional wiki never creates external model cost.
To run the same demo with real server-side OpenRouter calls, stop the current
launcher with Ctrl+C first, then explicitly provide the key and opt in when
restarting on the same ports:

```bash
SECOND_BRAIN_WIKI_API_KEY= OPENROUTER_API_KEY=... PYTHONPATH=backend/src \
  "$WIKI_PYTHON" scripts/run-wiki-demo.py --with-openrouter
```

Then ask a question about the atlas and a follow-up. The model can only call the
bounded search, page-read, and graph-neighbor tools. The browser keeps and can
delete conversation history locally; the backend stores no chat transcript.
While a reply is pending, **Stop reply** cancels the browser request and keeps
the saved question available for Retry. Leaving Chat also aborts its unfinished
request. The server cancels that invocation when it observes the disconnect;
this cannot interrupt an already running synchronous read or guarantee that a
remote provider stops generation or billing immediately.
This is a paid external call, distinct from the deterministic demo and browser
regression suite.

## WebKit compatibility and worker checks

The browser CI also runs the reading/navigation compatibility slice in WebKit
against a separately started disposable API/Vite instance. With installed
Playwright WebKit dependencies, run it explicitly from the repository root:

```sh
SECOND_BRAIN_WIKI_API_KEY= "$WIKI_PYTHON" scripts/run-wiki-acceptance.py --browser-engine webkit
```

It selects article/view focus, skip links and the fictional demo route, preserving
Chromium screenshots in a separate output directory. Structural evidence names
the engine and selected suites. This Linux Playwright WebKit build is not branded
Safari, macOS or a physical iPhone/PWA installation; full Chromium, first-start,
import and container acceptance remain separate gates. See
[Playwright's browser scope](https://playwright.dev/docs/browsers#webkit).
The WebKit reading profile blocks service-worker registration so delayed API
requests remain observable by Playwright routing. Held handlers still fetch and
deliver actual API payloads; no responses or user interactions are replaced.
Structural logs identify the launched engine, worker setting and held-read
stages. Routing disables HTTP cache, so this controlled profile does not prove
worker updates, native cache/BFCache behavior or PWA installation. The full
Chromium profile keeps service workers enabled. See Playwright's guidance on
[missing network events](https://playwright.dev/docs/network#missing-network-events-and-service-workers).

The separate worker lifecycle slice keeps service workers enabled:

```sh
SECOND_BRAIN_WIKI_API_KEY= "$WIKI_PYTHON" scripts/run-wiki-acceptance.py --browser-engine webkit --webkit-workers
```

It selects eight existing cases: online-first registration and no private caches,
an offered waiting-worker update, discovering an update already installing when
another tab opens at 390/1440px, recoverable background-update failures at those
widths, and editor-draft protection while another tab updates, followed by save
or discard and deliberate reload. The update probe
serves the actual app/API through an owned loopback proxy and changes only a
synthetic comment in the worker bytes to trigger a new version. Browser contexts
close before the proxy, including its worker connections. Its worker-enabled
logs, effective selection, structural profile and images are separate from the
reading profile. Chromium retains CDP manifest/installability diagnostics;
WebKit has no CDP path and instead checks browser metadata, actual worker
registration/control, CacheStorage and online/offline behavior. These controlled
Linux browser updates do not establish native Safari/Home Screen installation,
physical iOS lifecycle or production HTTPS/auth operation.

## Manual presentation rehearsal

Start with [Run locally](#run-locally), then follow the steps below in an actual
browser. Choose explicitly whether the [paid provider](#take-a-short-tour) is
enabled before beginning; the normal demo has no model access.

Use the fictional atlas for shared screenshots or review. The automated browser
rehearsal checks the unavailable-provider path; it does not stand in for this
human tour or real answer-quality inspection. Record the tested Git head,
viewport/browser, provider enabled or unavailable, and any failed step:

1. Start the documented demo, open Home, follow **Mira Quill** to the archive
   method, and use its field-notebook link. The route should read naturally,
   with clear introductions and a useful path back to Home.
   On Mira Quill, choose **Set as start page**, wait for **This is now your start
   page**, then open
   <http://127.0.0.1:5173/> in the same browser profile and confirm that it opens
   that article. The **Home** navigation link and **All pages** intentionally
   open the overview; use it to return to the atlas when needed.
   On a longer article, follow an in-text link and use browser Back/Forward:
   the reading point should return for that visit, including after reloading the
   destination and then using Back/Forward. Fragment links still take precedence;
   choosing another focus or scrolling during a pending read must not be
   overridden.
2. Search for `tide`, open the tide clock, then use History. Edit only the
   synthetic page, save, reload, and verify that both content and history reflect
   the save. A local save is distinct from optional index/remote delivery.
3. Open the galaxy, choose a constellation and a star, inspect the named link
   evidence and open its article. Return to the overview and find the page with
   graph search. Repeat navigation at a narrow viewport and with the keyboard.
4. With the explicit provider opt-in above, ask: “What warning does the tide
   clock page give about real navigation or shore access?” Then: “Compare that
   with the salt marsh pilot result. What remains uncertain?” Inspect the actual
   answers and open their read sources. The atlas explicitly rejects real-world
   navigation use; the pilot's limitations must remain visible. Without a key,
   record the unavailable state and leave real-model acceptance open.
5. Reload the conversation, confirm its locally retained turns, then delete it
   and verify its removal. Stop and restart the demo; reopen the edited article
   and confirm that opening <http://127.0.0.1:5173/> in the same browser profile
   still opens Mira Quill. Demo edits persist in the vault; the saved start-page
   choice and conversation deletion remain browser-local actions.

Use the separate real-provider gate below for structural tool/read-only checks.
Human answer inspection and physical Android/iOS installation still need their
own evidence; viewport emulation establishes neither. The reading-position
regressions use real API reads and disposable synthetic pages in Chromium at
390- and 1440-pixel widths; they do not establish physical-device behavior.
The reading-position cache is tab-scoped and bounded to 100 random visit IDs
with x/y coordinates; it stores no URLs or page content. Unavailable or invalid
session storage starts a fresh navigation session without restoring old positions.

For a repeatable real-provider release gate instead of a manual chat, run:

```bash
OPENROUTER_API_KEY=... make acceptance-openrouter PYTHON="$WIKI_PYTHON"
```

The gate seeds a fresh fictional vault, asks two related questions, requires
the model to read the named evidence pages, checks bounded tool use and the
unchanged read-only vault, and then removes the vault on success. Its JSON
record under `.demo/openrouter-acceptance/` contains only timings, model name,
source IDs, counts and pass/fail metadata—never answers, prompts, credentials
or page content. Schema 2 explicitly marks the scope as **structural** and
`answer_quality_reviewed=false`: reading the right pages and returning bounded
text cannot establish that an answer interprets them correctly. Mere presence
of words such as “navigation” or “tide alone” is not a factual quality check.
Use the manual two-question tour above to inspect the caution, comparison and
uncertainty; a structural pass leaves that answer-quality gate open.

Evidence records attempted/completed client invocations and chat turns separately.
These counts do not prove HTTP delivery, count the client's internal retries or
confirm provider billing. A seed failure records zero invocations/turns and
unknown (`null`) vault integrity; an observed unchanged vault remains `true`
even when the provider fails. This incurs real provider usage and cannot run
without the explicit opt-in encoded by the Make target.
Cleanup is also observed: a failed vault removal fails the run and records the
actual retained state, with a sanitized error type and no exception details.

The service worker does not cache the demo or its API responses. Turning the
browser offline while the app is open shows the connection notice; a cold offline
launch is intentionally unavailable. See the [PWA guide](pwa.md) for Android/iOS
installation differences and the controlled update path.

## Large synthetic vault check

The polished atlas stays deliberately small. For an opt-in real-service scale
check, create a fresh generated 320-page vault and start the same API/frontend:

```sh
SECOND_BRAIN_WIKI_API_KEY= make demo-scale PYTHON="$WIKI_PYTHON"
```

In a second terminal, run its separate browser contract:

```sh
cd frontend
PLAYWRIGHT_SCALE=1 npm run test:browser -- e2e/scale.spec.ts
```

This path imports one deterministic synthetic Git snapshot, then reads and
mutates it through the real REST/graph services. It never seeds the ordinary demo
or an existing destination. The generated vault is retained under ignored
`.demo/scale-vault-*` storage for inspection; it is not a personal-wiki fixture.

## Seeding rules

For the explicit empty/template/local-Git first-start choice, see
[first-start.md](first-start.md). No first-start command replaces a populated wiki.

Nothing is seeded on API startup. The CLI requires `--vault`; there is no default destination. It writes pages through the same managed `WikiStore.save_page` path as ordinary edits.

- A nonempty directory without a valid completed demo marker is refused without changing its files.
- Repeating the command for a completed, unchanged demo verifies every page's ID and exact Markdown against the template, then reports `unchanged` without writing a new revision.
- A changed page, missing page, added page, or changed template causes a refusal. Your edits are preserved. Choose another empty directory for a fresh demo.
- An interrupted seed retains a marker with state `seeding`. An ordinary retry is refused. To recover explicitly, run the same command with `--resume`. The CLI verifies the template fingerprint and every existing page, then creates only missing pages through the normal save path. Any edited or unexpected page causes refusal. A local file lock serializes concurrent seeders; operating-system lock release permits recovery after a process stops.
- The `.second-brain-demo.json` marker is seeder metadata. Do not copy a completed marker into another vault or change its state to force a retry.

An optional `--template PATH` selects a flat directory of Markdown files instead of the checked-in `examples/demo-vault` template. Each filename becomes a page ID, and each page must begin with a level-one title. Template pages and the target vault must not be symbolic links. Use only clearly synthetic material for a public demo.

The template's examples are cultural and narrative material. They are not real observing forecasts, navigation instructions, harvesting advice, or food safety guidance.

