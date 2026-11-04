import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";

// Actual Chromium manifest fetching behind synthetic session authentication.
// This validates credential delivery, not installation on a physical phone.
test("password-protected app manifest retains authenticated browser access", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium manifest diagnostic uses CDP");
  const html = (await readFile("index.html", "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const manifest = await readFile("public/manifest.webmanifest");
  const assets = new Map(await Promise.all([
    ["/app-icon.svg", "image/svg+xml"],
    ["/app-icon-192.png", "image/png"],
    ["/app-icon-512.png", "image/png"],
    ["/apple-touch-icon.png", "image/png"],
    ["/service-worker.js", "text/javascript"],
  ].map(async ([path, type]) => [path, { type, body: await readFile(`public${path}`) }] as const)));
  const authenticatedAssets = new Set<string>();
  let authenticatedManifest = false;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.cookie !== "session=synthetic-manifest") {
      response.writeHead(401);
      response.end(); return;
    }
    if (request.url === "/manifest.webmanifest") {
      authenticatedManifest = true;
      response.setHeader("Content-Type", "application/manifest+json");
      response.end(manifest); return;
    }
    const asset = assets.get(request.url ?? "");
    if (asset) {
      authenticatedAssets.add(request.url!);
      response.setHeader("Content-Type", asset.type);
      response.end(asset.body); return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  await context.addCookies([{ name: "session", value: "synthetic-manifest", url: origin }]);
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("crossorigin", "use-credentials");
    const session = await context.newCDPSession(page);
    const result = await session.send("Page.getAppManifest");
    expect(result.errors).toEqual([]);
    expect(JSON.parse(result.data!)).toMatchObject({ display: "standalone", start_url: "/?source=pwa" });
    expect(authenticatedManifest).toBe(true);
    // Use actual product artwork, not an HTML response at an icon URL. A valid
    // manifest alone cannot establish that Chromium can decode its chosen icon.
    const icons = await page.evaluate(async () => Promise.all(
      ["/app-icon-192.png", "/app-icon-512.png"].map(async src => {
        const image = new Image(); image.src = src; await image.decode();
        return { src, width: image.naturalWidth, height: image.naturalHeight };
      }),
    ));
    expect(icons).toEqual([
      { src: "/app-icon-192.png", width: 192, height: 192 },
      { src: "/app-icon-512.png", width: 512, height: 512 },
    ]);
    // Registration here belongs to this isolated auth fixture; the normal app's
    // startup/worker registration is covered by the separate real-app PWA case.
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js");
      await navigator.serviceWorker.ready;
    });
    const installability = await session.send("Page.getInstallabilityErrors");
    expect(installability.installabilityErrors).toEqual([]);
    for (const src of ["/app-icon-192.png", "/app-icon-512.png", "/service-worker.js"]) {
      expect(authenticatedAssets.has(src)).toBe(true);
    }
    for (const path of ["/manifest.webmanifest", "/app-icon-192.png", "/service-worker.js"]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401);
    }
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
