import { chromium, expect } from "@playwright/test";
import { test } from "./reading-test";

// A real Blink text setting changes glyph metrics without narrowing the
// viewport. This is separate from browser zoom, Safari and physical devices.
for (const width of [390, 600, 800, 1024, 1440]) {
  test(`native minimum text keeps chat and navigation controls reachable (${width})`, async ({ browserName, baseURL }, info) => {
    test.skip(browserName !== "chromium", "Blink minimum font size is Chromium-specific");
    const browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--blink-settings=minimumFontSize=24"],
    });
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      let modelRequests = 0;
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/wiki/chat" && request.method() === "POST") modelRequests++;
      });
      await page.goto(`${baseURL}/?overview=1`);
      await expect(page.getByRole("heading", { name: "A growing collection", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: info.outputPath(`home-minimum-text-${width}.png`) });
      await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Chat", exact: true }).click();
      const heading = page.locator(".chat-history-heading");
      const label = heading.locator("span");
      const create = heading.getByRole("button", { name: "New", exact: true });
      await expect(create).toBeVisible();
      await page.screenshot({ path: info.outputPath(`chat-minimum-text-${width}.png`) });
      const parent = (await heading.boundingBox())!;
      const labelBounds = (await label.boundingBox())!;
      // Prove the native setting actually enlarged the formerly nine-pixel label.
      expect(labelBounds.height).toBeGreaterThanOrEqual(24);
      for (const target of [label, create]) {
        const box = (await target.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(parent.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(parent.y + parent.height + 1);
        expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.locator("textarea").fill("Synthetic unsent question.");
      await create.click();
      await expect(page.locator("textarea")).toHaveValue("");
      await page.locator("textarea").fill("A second synthetic unsent question.");
      await create.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("textarea")).toHaveValue("");
      const search = page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Search", exact: true });
      await search.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search$/);
      expect(modelRequests).toBe(0);
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

for (const width of [1440, 1024, 390]) {
  test(`full local chat history stays usable without stretching the workspace (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/chat");
    const seed = async (count: number) => {
      await page.evaluate(count => localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify(
        Array.from({ length: count }, (_, i) => ({ id: `synthetic-history-${i}`, title: `Synthetic conversation ${i + 1}`,
          updated: 100 - i, messages: [{ role: "user", content: `Synthetic saved question ${i + 1}.` }] })),
      )), count);
      await page.reload();
      await expect(page.locator(".chat-history-list button")).toHaveCount(count);
    };
    await seed(1);
    const singleComposer = await page.locator(".chat-composer").boundingBox();
    await seed(20);
    const fullComposer = await page.locator(".chat-composer").boundingBox();
    // Opening a full saved history must not move the input below the reader.
    expect(fullComposer!.y).toBeLessThanOrEqual(singleComposer!.y + 2);
    if (width > 760) expect(fullComposer!.y + fullComposer!.height).toBeLessThanOrEqual(1000);
    const list = page.locator(".chat-history-list");
    await page.locator(".chat-history-list button").first().focus();
    for (let i = 1; i < 20; i++) await page.keyboard.press("Tab");
    const last = page.locator(".chat-history-list button").last();
    await expect(last).toBeFocused();
    const metrics = await list.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight, x: element.scrollLeft, y: element.scrollTop }));
    if (width > 760) {
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
      expect(metrics.y).toBeGreaterThan(0);
    } else {
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.width);
      expect(metrics.x).toBeGreaterThan(0);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.height + 1);
    }
    const bounds = await list.boundingBox();
    const selected = await last.boundingBox();
    if (width > 760) {
      expect(selected!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
      expect(selected!.x + selected!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    } else {
      // Native horizontal focus scrolling may expose only part of a button.
      // Keep a touch-sized visible target; activation reveals the selected item.
      expect(Math.min(selected!.x + selected!.width, bounds!.x + bounds!.width) - Math.max(selected!.x, bounds!.x)).toBeGreaterThanOrEqual(44);
    }
    expect(selected!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
    expect(selected!.y + selected!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-message.user")).toContainText("Synthetic saved question 20.");
    await expect(page.locator(".chat-history-list button.active")).toContainText("Synthetic conversation 20");
    await page.reload();
    await expect(page.locator(".chat-message.user")).toContainText("Synthetic saved question 20.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`chat-history-${width}.png`), fullPage: true });
  });
}
