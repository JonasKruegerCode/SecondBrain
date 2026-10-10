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
const listeners = new Set<(state: PwaState) => void>();

function state(): PwaState {
  return {
    offline: !navigator.onLine,
    installable: Boolean(installPrompt),
    updateAvailable: Boolean(waitingWorker),
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
  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        waitingWorker = reg.waiting || installing;
        publish();
      }
    });
  });
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
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
}

export function checkForUpdate() {
  void registration?.update();
}

export function startPwa() {
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
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
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
