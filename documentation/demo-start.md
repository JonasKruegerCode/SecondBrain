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
make demo PYTHON="$WIKI_PYTHON"
```

Open <http://127.0.0.1:5173>. The launcher uses the separate `.demo/vault`,
requires no remote or model key, clears inherited OpenRouter access and retains
your later demo edits. It never seeds an existing nonempty wiki implicitly.
For a new empty destination, explicit template choice or Git import, use the
[first-start profiles](first-start.md). Stop the launcher before starting another
profile on the same ports.

The combined launcher treats both services as long-running peers. If either API
or frontend exits unexpectedly, it stops the other service and returns a nonzero
status instead of reporting a successful demo. Ctrl+C/SIGTERM remains a clean
operator stop. This makes the command suitable for a supervised rehearsal while
still keeping it separate from a production deployment.

## Run the disposable acceptance rehearsal

The normal automated demo path can be exercised without coordinating two
terminals:

```sh
(cd frontend && npx playwright install --with-deps chromium)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
make acceptance PYTHON="$WIKI_PYTHON"
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
To run the same demo with real server-side OpenRouter calls, explicitly provide
the key and opt in:

```bash
OPENROUTER_API_KEY=... PYTHONPATH=backend/src \
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

## Manual presentation rehearsal

Use the fictional atlas for shared screenshots or review. The automated browser
rehearsal checks the unavailable-provider path; it does not stand in for this
human tour or real answer-quality inspection. Record the tested Git head,
viewport/browser, provider enabled or unavailable, and any failed step:

1. Start the documented demo, open Home, follow **Mira Quill** to the archive
   method, and use its field-notebook link. The route should read naturally,
   with clear introductions and a useful path back to Home.
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
   and saved Home choice. Demo edits persist, while conversation deletion remains
   a browser-local action.

Use the separate real-provider gate below for structural tool/read-only checks.
Human answer inspection and physical Android/iOS installation still need their
own evidence; viewport emulation establishes neither.

For a repeatable real-provider release gate instead of a manual chat, run:

```bash
OPENROUTER_API_KEY=... make acceptance-openrouter PYTHON="$WIKI_PYTHON"
```

The gate seeds a fresh fictional vault, asks two related questions, requires
the model to read the named evidence pages, checks bounded tool use and the
unchanged read-only vault, and then removes the vault on success. Its JSON
record under `.demo/openrouter-acceptance/` contains only timings, model name,
source IDs, counts and pass/fail metadata—never answers, prompts, credentials
or page content. This incurs real provider usage and cannot run without the
explicit opt-in encoded by the Make target.

The service worker does not cache the demo or its API responses. Turning the
browser offline while the app is open shows the connection notice; a cold offline
launch is intentionally unavailable. See the [PWA guide](pwa.md) for Android/iOS
installation differences and the controlled update path.

## Large synthetic vault check

The polished atlas stays deliberately small. For an opt-in real-service scale
check, create a fresh generated 320-page vault and start the same API/frontend:

```sh
make demo-scale PYTHON="$WIKI_PYTHON"
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
