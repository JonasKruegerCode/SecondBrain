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
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
