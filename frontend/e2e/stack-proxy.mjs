// Synthetic built-image rehearsal only: no real vault, bearer key or model calls.
import { chromium, expect } from "@playwright/test";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, certificate, output] = process.argv.slice(2);
if (!base?.startsWith("https://127.0.0.1:") || !certificate || !output) {
  throw new Error("Use the disposable loopback TLS fixture.");
}
mkdirSync(output, { recursive: true });
const cert = new X509Certificate(readFileSync(certificate));
const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
const evidence = { schema: 1, status: "failed", physical_device: false,
  production_https: false, browser_trust: "disposable_certificate_spki_allowlist", gates: [] };
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--ignore-certificate-errors-spki-list=${spki}`],
});
try {
  const context = await browser.newContext({
    httpCredentials: { username: "fixture", password: "fixture-password", origin: base },
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  await page.goto(base + "/wiki/home");
  await expect(page.getByRole("heading", { name: "Lantern Bay field atlas", exact: true })).toBeVisible();
  evidence.gates.push("authenticated-built-home");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const worker = await page.evaluate(async () => ({ secure: isSecureContext,
    scope: (await navigator.serviceWorker.ready).scope, caches: await caches.keys() }));
  expect(worker).toEqual({ secure: true, scope: base + "/", caches: [] });
  evidence.gates.push("authenticated-secure-worker-no-private-cache");
  const session = await context.newCDPSession(page);
  expect((await session.send("Page.getAppManifest")).errors).toEqual([]);
  evidence.gates.push("authenticated-browser-manifest");
  await page.screenshot({ path: join(output, "https-home-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, "https-home-mobile.png"), fullPage: true });
  evidence.gates.push("authenticated-narrow-home-no-overflow");
  await page.goto(base + "/wiki/https-fixture");
  await expect(page.getByRole("heading", { name: "HTTPS fixture", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit page" }).click();
  const editor = page.getByRole("textbox", { name: /Markdown/ });
  await editor.fill((await editor.inputValue()) + "\n\nSaved by the authenticated browser.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Saved by the authenticated browser.", { exact: true })).toBeVisible();
  evidence.gates.push("authenticated-browser-save-reload");
  expect(errors).toEqual([]);
  evidence.gates.push("no-browser-runtime-errors");
  evidence.status = "passed";
} finally {
  await browser.close();
  writeFileSync(join(output, "browser-proxy.json"), JSON.stringify(evidence, null, 2) + "\n");
}
console.log(JSON.stringify(evidence));
