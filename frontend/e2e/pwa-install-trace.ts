import { Page } from "@playwright/test";

// Scoped to the synthetic first-install test. Observe real browser workers;
// never replace their lifecycle, wait for an event, or alter the app's promise.
export async function traceFirstInstall(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = "pwa-first-install-events";
    const ids = new WeakMap<ServiceWorker, number>();
    const watched = new WeakSet<ServiceWorker>();
    let nextId = 0;
    let registration: ServiceWorkerRegistration | undefined;
    const slot = (worker: ServiceWorker | null | undefined) => {
      if (!worker) return null;
      if (!ids.has(worker)) ids.set(worker, ++nextId);
      return { id: ids.get(worker), state: worker.state };
    };
    const record = (event: string, candidate?: ServiceWorker) => {
      try {
        const events = JSON.parse(sessionStorage.getItem(key) || "[]") as unknown[];
        const notice = document.querySelector<HTMLElement>(".pwa-notice");
        events.push({
          event,
          document: performance.timeOrigin,
          elapsed: Math.round(performance.now()),
          documents: sessionStorage.getItem("pwa-first-install-documents"),
          online: navigator.onLine,
          candidate: slot(candidate),
          controller: slot(navigator.serviceWorker.controller),
          installing: slot(registration?.installing),
          waiting: slot(registration?.waiting),
          active: slot(registration?.active),
          candidateIsController: candidate ? candidate === navigator.serviceWorker.controller : null,
          candidateIsActive: candidate ? candidate === registration?.active : null,
          notice: notice ? { kind: notice.dataset.kind, hidden: notice.hidden } : null,
        });
        sessionStorage.setItem(key, JSON.stringify(events.slice(-100)));
      } catch {
        // Diagnostic storage must never block the real registration or events.
      }
    };
    (window as Window & { __recordPwaFirstInstall?: (event: string) => void })
      .__recordPwaFirstInstall = event => record(event);
    const watch = (worker: ServiceWorker | null) => {
      if (!worker || watched.has(worker)) return;
      watched.add(worker);
      slot(worker);
      worker.addEventListener("statechange", () => record("statechange", worker));
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      watch(navigator.serviceWorker.controller);
      record("controllerchange");
    });
    window.addEventListener("offline", () => record("offline"));
    window.addEventListener("online", () => record("online"));
    const originalRegister = navigator.serviceWorker.register;
    navigator.serviceWorker.register = function (scriptURL, options) {
      record("register-call");
      const promise = originalRegister.call(this, scriptURL, options);
      void promise.then(reg => {
        registration = reg;
        watch(reg.installing);
        watch(reg.waiting);
        watch(reg.active);
        reg.addEventListener("updatefound", () => {
          watch(reg.installing);
          record("updatefound", reg.installing || undefined);
        });
        record("register-resolved");
      }, () => record("register-rejected")).catch(() => {
        // An observer failure must not change the application's real promise.
      });
      return promise;
    };
  });
}

export async function readFirstInstallTrace(page: Page, event = "after-test"): Promise<unknown> {
  return page.evaluate(label => {
    (window as Window & { __recordPwaFirstInstall?: (event: string) => void })
      .__recordPwaFirstInstall?.(label);
    const notice = document.querySelector<HTMLElement>(".pwa-notice");
    return {
      events: JSON.parse(sessionStorage.getItem("pwa-first-install-events") || "[]"),
      documents: sessionStorage.getItem("pwa-first-install-documents"),
      online: navigator.onLine,
      controller: navigator.serviceWorker.controller?.state || null,
      notice: notice ? { kind: notice.dataset.kind, hidden: notice.hidden } : null,
    };
  }, event).catch(() => ({ diagnostic: "unavailable" }));
}
