import { expect, Page } from "@playwright/test";
import { test } from "./reading-test";

// Use the actual public demo and rendered browser geometry. Playwright's
// toBeVisible alone does not distinguish offscreen links from viewport content.
async function geometry(page: Page) {
  return page.locator(".skip-link").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      focused: document.activeElement === element,
      top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      width: innerWidth, height: innerHeight, scrollY,
      transform: getComputedStyle(element).transform,
    };
  });
}

for (const width of [390, 1440]) {
  test(`skip link stays outside the viewport until keyboard focus (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?overview=1");
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    const skip = page.getByRole("link", { name: "Skip to content", exact: true });
    expect((await geometry(page)).bottom).toBeLessThanOrEqual(0);
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    const focused = await geometry(page);
    expect(focused.top).toBe(12);
    expect(focused.left).toBe(12);
    expect(focused.right).toBeLessThanOrEqual(width);
    expect(focused.bottom).toBeLessThanOrEqual(focused.height);
    await page.screenshot({ path: info.outputPath(`skip-link-focused-${width}.png`) });
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
    expect((await geometry(page)).bottom).toBeLessThanOrEqual(0);

    await page.getByRole("link", { name: /Open Lantern Bay field atlas/ }).click();
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
    await page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true }).click();
    await expect(page.locator("article h1")).toHaveText("Night sky survey");
    const history = page.locator(".page-history summary");
    await history.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".history-list li")).toHaveCount(1);
    await history.scrollIntoViewIfNeeded();
    await expect(history).toBeFocused();
    const before = await geometry(page);
    expect(before.focused).toBe(false);
    expect(before.scrollY).toBeGreaterThan(0);
    expect(before.bottom).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`skip-link-hidden-viewport-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`skip-link-hidden-fullpage-${width}.png`), fullPage: true });
    const after = await geometry(page);
    expect(after).toEqual(before);
    await page.screenshot({ path: info.outputPath(`skip-link-after-capture-${width}.png`) });
    console.log(`[skip-link] ${JSON.stringify({ width, focused, before, after })}`);

    // Focus the first navigation bypass from the scrolled article, then exercise
    // real Enter/Tab events. Repeat the already-current fragment as well.
    for (let attempt = 0; attempt < 2; attempt++) {
      await skip.focus();
      expect((await geometry(page)).top).toBe(12);
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
      await expect(page).toHaveURL(/#main-content$/);
      expect((await geometry(page)).bottom).toBeLessThanOrEqual(0);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "← All pages", exact: true })).toBeFocused();
    }
  });
}
