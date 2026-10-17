type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type PwaState = {
  offline: boolean;
  installable: boolean;
  updateAvailable: boolean;
};

let installPrompt: InstallPrompt | undefined;
let waitingWorker: ServiceWorker | undefined;
let registration: ServiceWorkerRegistration | undefined;
let reloading = false;
let reloadPending = false;
let canReload: () => boolean = () => true;
const listeners = new Set<(state: PwaState) => void>();

function state(): PwaState {
  return {
    offline: !navigator.onLine,
    installable: Boolean(installPrompt),
    updateAvailable: Boolean(waitingWorker) || reloadPending,
  };
}

function publish() {
  const current = state();
  listeners.forEach(listener => listener(current));
}

function inspect(reg: ServiceWorkerRegistration) {
  registration = reg;
  waitingWorker = reg.waiting || undefined;
  publish();
  const watchInstalling = () => {
    const installing = reg.installing;
    if (!installing) return;
    // Capture the older worker before installation completes. A first install
    // can claim this document before its queued statechange listener runs.
    const active = reg.active || navigator.serviceWorker.controller;
    const replacesActiveWorker = Boolean(active && active !== installing);
    const changed = () => {
      if (installing.state === "installed" && replacesActiveWorker) {
        waitingWorker = reg.waiting || installing;
        publish();
      }
    };
    installing.addEventListener("statechange", changed);
    changed();
  };
  reg.addEventListener("updatefound", watchInstalling);
  // register() may resolve after updatefound, with an install still in flight.
  watchInstalling();
}

export function observePwa(listener: (state: PwaState) => void): () => void {
  listeners.add(listener);
  listener(state());
  return () => listeners.delete(listener);
}

export async function installApp(): Promise<void> {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = undefined;
  await prompt.prompt();
  await prompt.userChoice;
  publish();
}

export function applyUpdate() {
  if (!canReload()) return;
  if (reloadPending) {
    reloadApp();
    return;
  }
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
}

function reloadApp() {
  if (reloading || !canReload()) return;
  reloading = true;
  location.reload();
}

export function checkForUpdate() {
  void registration?.update().catch(() => {
    // Background checks are best effort. Keep the active worker and allow a
    // later visibility check to retry when the connection is available.
  });
}

export function startPwa(reloadAllowed: () => boolean = () => true) {
  canReload = reloadAllowed;
  window.addEventListener("online", publish);
  window.addEventListener("offline", publish);
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = undefined;
    publish();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });

  if (!("serviceWorker" in navigator)) return;
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // First installation claims the current online document; no reload is needed.
    if (!hadController) {
      hadController = true;
      return;
    }
    waitingWorker = undefined;
    reloadPending = true;
    publish();
    // Another tab can activate the worker while this tab has an editor open.
    // Keep the update notice actionable after saving or deliberately discarding.
    reloadApp();
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/service-worker.js", { scope: "/", updateViaCache: "none" })
      .then(inspect)
      .catch(() => {
        // The wiki remains a normal online web app when registration is unavailable.
      });
  });
}
