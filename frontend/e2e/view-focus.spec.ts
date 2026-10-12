import { test, expect } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`keyboard navigation reaches each view's content (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["Search", "Home", "Galaxy", "Chat"]) {
      await page.goto("/wiki/night-sky-survey");
      await expect(page.locator("article > h1")).toHaveText("Night sky survey");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const link = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true });
      await link.focus();
      await page.keyboard.press("Enter");
      const heading = page.locator("main h1");
      await expect(heading).toBeVisible();
      const observed = await page.evaluate(() => ({ tag: document.activeElement?.tagName, scrollY }));
      console.log(`[view-focus] ${JSON.stringify({ width, name, observed })}`);
      // Diagnostic baseline: removed after the real-browser reproduction.
      expect(observed.tag).toBe("BODY");
      await page.screenshot({ path: info.outputPath(`view-focus-${name.toLowerCase()}-${width}.png`) });
    }
  });
}
