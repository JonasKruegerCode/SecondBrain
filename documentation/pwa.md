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
waiting state; the current app shows **Update now**. That action sends
`SKIP_WAITING`, and `controllerchange` reloads the app once. There is no silent
asset-cache migration because there is no app cache.

Changing deployed frontend assets without changing `service-worker.js` will not
create a waiting worker. Bump its `RELEASE` value for each deployment that needs
the in-app update notice. Normal browser navigation still receives the current
uncached HTML independently.

## Reproducible checks and limits

Run the isolated demo and browser suite:

```sh
make demo PYTHON=backend/.venv/bin/python
# in another terminal
cd frontend
npm run test:browser
```

The PWA browser regression asks Chromium's `Page.getAppManifest` for parse
errors and `Page.getInstallabilityErrors` for unmet criteria, validates the install
metadata/icons, waits for the root-scope worker, confirms empty CacheStorage,
checks the worker has no fetch handler, and toggles the browser offline to verify
the visible connection notice at 390 px. A local same-origin proxy serves two
worker revisions so the suite also observes a real waiting worker, applies
**Update now**, and verifies the controlled reload without creating a private
cache.

These checks are browser emulation, not a physical Android/iOS installation.
Homescreen creation, standalone launch, OS icon rendering and a production HTTPS
upgrade still require real-device/deployed verification before release signoff.
