# Install and update the managed wiki PWA

The managed wiki is an **online-first installable web app**. Installation gives
it a Home Screen/app-launcher icon and standalone window; it does not copy the
private wiki for offline use. The browser still needs a connection for pages,
search, graph and chat.

## Requirements and installation

Serve the frontend over HTTPS in production. `http://localhost` and
`http://127.0.0.1` are secure-context exceptions intended for local development.
Keep the existing reverse-proxy authentication in front of both the frontend
and `/api/wiki`; the OpenRouter key stays in the backend environment.

- **Android/desktop Chromium:** open the site and use the browser's install
  action. When Chromium exposes `beforeinstallprompt`, Secondbrain also shows a
  small **Install app** notice. Browser policy decides whether that event exists.
- **iPhone/iPad Safari:** use **Share → Add to Home Screen → Add**. WebKit does
  not expose Chromium's install prompt, so absence of the in-app button is not a
  failure.

The manifest launches `/?source=pwa`, which retains the normal saved-start-page
behavior. It includes 192 px, 512 px, vector and Apple touch icons. All artwork
is deliberately synthetic and contains no personal wiki data.

## Privacy and offline behavior

`service-worker.js` has no `fetch` handler and never opens CacheStorage. It
therefore cannot cache page responses, chat requests, authorization headers or
an offline copy of the app. Managed API responses also retain
`Cache-Control: no-store`. Chat history remains only in browser `localStorage`
and can be deleted in the Chat view; it is not a service-worker cache.

If an already open app loses connectivity, a visible notice explains that wiki
and chat need a connection. A cold offline launch shows the browser's ordinary
network failure because even the static app shell is intentionally not cached.
Offline reading, offline writes and offline LLM calls are outside the 2.0 scope.

## Controlled updates

The runtime registers the worker with `updateViaCache: "none"` and asks it to
check again when the app becomes visible. Nginx serves the worker with
`no-cache, no-store, must-revalidate`. A changed worker installs into the normal
waiting state; the current app shows **Update now**. The button stays disabled
while the editor has unsaved changes or a save response is pending, including an
unchanged save. The notice explains whether to save/discard or wait for saving.
Once safe, that action sends `SKIP_WAITING` and reloads the app once.

Unsent chat messages and pending replies also block the update. Send or clear
the composer, then wait for the answer to finish. If browser storage fails,
nonempty unsaved conversations remain protected in the current document even
after navigating to an article. Recover storage and persist the conversation,
or deliberately delete its unsaved messages, before updating. The notice
explains which state is blocking reload; it does not add a backend chat archive.

If another tab activates the worker, a tab with unsaved changes or a pending
save keeps its current document and editor. Its update notice remains available;
after saving or deliberately discarding, **Update now** reloads into the active
version. First installation claims the current online document without reloading.
There is no silent asset-cache migration because there is no app cache.

Changing deployed frontend assets without changing `service-worker.js` will not
create a waiting worker. Bump its `RELEASE` value for each deployment that needs
the in-app update notice. Normal browser navigation still receives the current
uncached HTML independently.

The [Compose install/update procedure](install-update.md) connects this manual
release step with version selection, content backup and service recovery. Its
image/source choice does not by itself prove that an open browser took the update.

## Reproducible checks and limits

Run the isolated demo and browser suite:

```sh
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
# in another terminal
cd frontend
npm run test:browser
```

`SECOND_BRAIN_WIKI_API_KEY= make acceptance PYTHON="$WIKI_PYTHON"` supervises both services and
runs the same browser suite in one command. The **Managed wiki browser acceptance**
CI workflow runs it on pull requests with a fresh synthetic vault and retains
only the structural result, browser report and synthetic update screenshots for
seven days.

The PWA browser regression asks Chromium's `Page.getAppManifest` for parse
errors and `Page.getInstallabilityErrors` for unmet criteria, validates the install
metadata/icons, waits for the root-scope worker, confirms empty CacheStorage,
checks the worker has no fetch handler, and toggles the browser offline to verify
the visible connection notice at 390 px. A local same-origin proxy serves two
worker revisions so the suite also observes a real waiting worker, applies
**Update now**, and verifies the controlled reload without creating a private
cache. Additional browser cases verify that a second tab's update preserves the
exact unsaved draft without a native unload dialog, then allows save or discard
before reloading. A held response from the real save API also verifies the guard
when the markdown is unchanged; the response is delayed, not replaced with a stub.
Chat cases cover both typing before/after an update offer, foreign-tab activation
with an unsent message or pending reply, and storage recovery/deletion after
article navigation. The worker transitions and reloads are real browser actions;
chat replies and full-storage errors in these cases are explicitly scripted.

The synthetic first-install case also records a bounded lifecycle trace in its
browser log, including on assertion failure. Worker identities distinguish
generations with the same script URL; each event records controller, installing,
waiting and active slots, candidate identity comparisons, the document counter
and notice state. Read-only snapshots immediately before the online-notice
assertion and after the test help distinguish a real waiting update from a stale
first-install notice or a later reload. No page/chat text or arbitrary storage is
recorded. The observer returns the original registration promise, adds no
lifecycle waits and treats diagnostic storage failures as best-effort. It still
adds observation overhead, so a passing traced run does not rule out an
intermittent timing failure. Keep the original hidden-notice assertion; a retry
pass alone is not a diagnosed or corrected lifecycle defect.

For a specific intermittent first-install failure, use the isolated diagnostic
profile, after installing the same backend/browser dependencies as acceptance:

```sh
SECOND_BRAIN_WIKI_API_KEY= "$WIKI_PYTHON" scripts/run-wiki-acceptance.py --browser-engine webkit \
  --webkit-first-install-diagnostic --repeat-each 20
```

It starts real disposable services and runs only the exact first-install case
with fresh browser contexts, retaining the original assertion and event trace.
Repeats are limited to 1–20; the record explicitly identifies
`first-install-diagnostic`, the exact filter and repeat count. This is not the
four-case worker/update gate or complete browser acceptance. It refuses mixed
profiles and arbitrary filters; ordinary acceptance remains unchanged.

In the browser workflow, enable the manual `pwa_first_install_diagnostic` input
or temporarily label the PR `diagnose-pwa-first-install` before its next run.
Remove that label after collecting the bounded evidence. The diagnostic is
opt-in so unrelated commits do not repeatedly run it. Keep failed evidence and
investigate worker identities/order before proposing a lifecycle correction.

These checks are browser emulation, not a physical Android/iOS installation.
Homescreen creation, standalone launch, OS icon rendering and a production HTTPS
upgrade still require real-device/deployed verification before release signoff.

`make acceptance-stack` separately checks delivery of protected wiki, API,
manifest, icons and worker resources through a disposable HTTPS/password proxy,
with certificate verification enabled. This is an HTTP/TLS gate, not a browser
installation or an inspection of your production authentication configuration.
See the [stack scope and limits](managed-stack-acceptance.md).
