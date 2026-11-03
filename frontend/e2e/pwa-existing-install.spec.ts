import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { AddressInfo, Socket } from "node:net";

test.use({ serviceWorkers: "allow" });

async function installingWorkerProxy() {
  let release = 1;
  let resumeInstall!: () => void;
  let installReached!: () => void;
  const installBlocked = new Promise<void>(resolve => { resumeInstall = resolve; });
  const installArrived = new Promise<void>(resolve => { installReached = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    try {
      const path = request.url || "/";
      if (path === "/__pwa-install-barrier") {
        installReached();
        await installBlocked;
        response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("installation released");
        return;
      }
      const upstream = await fetch(`http://127.0.0.1:5173${path}`, {
        headers: { accept: request.headers.accept || "*/*" },
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      upstream.headers.forEach((value, key) => {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(key)) {
          response.setHeader(key, value);
        }
      });
      if (path.startsWith("/service-worker.js")) {
        // A real install event waits for a network response. No lifecycle events
        // or application update state are fabricated.
        body = Buffer.from(body.toString() + `\n/* Installing-worker regression release ${release}. */\n`
          + (release === 2
            ? 'self.addEventListener("install", event => event.waitUntil(fetch("/__pwa-install-barrier")));\n'
            : ""));
        response.setHeader("Content-Type", "application/javascript");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Service-Worker-Allowed", "/");
      }
      response.writeHead(upstream.status);
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end("PWA installation proxy failed");
    }
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bump: () => { release = 2; },
    installArrived,
    releaseInstall: resumeInstall,
    close: async () => {
      resumeInstall();
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      sockets.forEach(socket => socket.destroy());
      await closed;
    },
  };
}

for (const width of [1440, 390]) {
  test(`PWA discovers an update already installing when a new tab opens (${width})`, async ({ page, context }, info) => {
    const proxy = await installingWorkerProxy();
    try {
      await page.goto(`${proxy.origin}/?overview=1`);
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
      await expect(page.locator(".pwa-notice")).toBeHidden();
      proxy.bump();
      // update() can settle only after the held installation, so initiate it
      // without waiting for its promise before opening the second tab.
      await page.evaluate(() => {
        void navigator.serviceWorker.getRegistration().then(reg => reg?.update());
      });
      await proxy.installArrived;
      await page.waitForFunction(async () =>
        (await navigator.serviceWorker.getRegistration())?.installing?.state === "installing");
      const arriving = await context.newPage();
      await arriving.setViewportSize({ width, height: 900 });
      // Observe registration settlement without changing the returned promise.
      // The browser may queue register() behind the ongoing update job. Do not
      // require that promise to settle before releasing the native install.
      await arriving.addInitScript(() => {
        const original = navigator.serviceWorker.register;
        const observed = window as Window & { __pwaRegistrationObserved?: Promise<void> };
        navigator.serviceWorker.register = function (scriptURL, options) {
          const pending = original.call(this, scriptURL, options);
          observed.__pwaRegistrationObserved = pending.then(() => undefined);
          return pending;
        };
      });
      await arriving.goto(`${proxy.origin}/?overview=1`);
      await expect(arriving.getByRole("heading", { name: "A growing collection" })).toBeVisible();
      await arriving.waitForFunction(() => Boolean(
        (window as Window & { __pwaRegistrationObserved?: Promise<void> }).__pwaRegistrationObserved));
      const before = await arriving.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return {
          installing: reg?.installing?.state,
          waiting: Boolean(reg?.waiting),
          controlled: Boolean(navigator.serviceWorker.controller),
        };
      });
      expect(before).toEqual({ installing: "installing", waiting: false, controlled: true });
      console.info("[pwa-existing-install] " + JSON.stringify({ width,
        engine: arriving.context().browser()?.browserType().name(), before,
        native_install_barrier: true }));
      await expect(arriving.locator(".pwa-notice")).toBeHidden();
      proxy.releaseInstall();
      await arriving.evaluate(async () => {
        await (window as Window & { __pwaRegistrationObserved?: Promise<void> }).__pwaRegistrationObserved;
      });
      await arriving.waitForFunction(async () => Boolean(
        (await navigator.serviceWorker.getRegistration())?.waiting));
      const notice = arriving.locator('.pwa-notice[data-kind="update"]');
      await expect(notice).toContainText("new version");
      await arriving.screenshot({ path: info.outputPath(`existing-install-${width}.png`) });
      await Promise.all([
        arriving.waitForEvent("load"),
        notice.getByRole("button", { name: "Update now" }).click(),
      ]);
      await expect(arriving.getByRole("heading", { name: "A growing collection" })).toBeVisible();
      await expect(arriving.locator(".pwa-notice")).toBeHidden();
      expect(await arriving.evaluate(() => caches.keys())).toEqual([]);
    } finally {
      proxy.releaseInstall();
      try {
        await context.close();
      } finally {
        await proxy.close();
      }
    }
  });
}
