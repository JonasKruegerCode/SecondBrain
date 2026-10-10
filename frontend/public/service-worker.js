/* Online-first by design. This worker never intercepts fetches or opens CacheStorage. */
const RELEASE = "secondbrain-pwa-2026-10-10-1";

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
