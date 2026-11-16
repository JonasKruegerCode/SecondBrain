/* Online-first by design. This worker never intercepts fetches or opens CacheStorage. */
const RELEASE = "secondbrain-pwa-2.0.0-search-2026-11-16";

self.addEventListener("install", () => {
  // Keep a new worker waiting so the open app can offer a controlled update.
  void RELEASE;
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
