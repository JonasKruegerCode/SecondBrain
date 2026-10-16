import { expect } from "@playwright/test";
import { test } from "./reading-test";

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
