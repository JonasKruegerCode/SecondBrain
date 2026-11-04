import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [320, 390, 1440]) {
  test(`light shell keeps real reading views usable with reduced motion (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const [route, ready, name] of [
      ["/?overview=1", ".card", "overview"],
      ["/wiki/home", ".prose", "article"],
      ["/galaxy", ".galaxy-stage", "galaxy"],
      ["/search", "#results", "search"],
      ["/chat", ".chat-composer", "chat"],
    ]) {
      await page.goto(route);
      await expect(page.locator(ready).first()).toBeVisible();
      const layout = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        ambientAnimations: ["::before", "::after"].map(pseudo =>
          getComputedStyle(document.querySelector(".ambient")!, pseudo).animationName),
      }));
      expect(layout.width).toBeLessThanOrEqual(width);
      for (const link of await page.locator("header nav a").all()) {
        expect(await link.evaluate(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return range.getClientRects().length;
        }), "navigation names should not break mid-word at default text size").toBe(1);
      }
      expect(layout.ambientAnimations).toEqual(["none", "none"]);
      if (width === 1440 && name === "article") {
        const article = await page.locator("main > article").boundingBox();
        expect(article!.width).toBeGreaterThanOrEqual(1100);
        const prose = await page.locator(".prose").boundingBox();
        expect(prose!.width).toBeGreaterThan(800);
        expect(prose!.width).toBeLessThanOrEqual(article!.width - 80);
      }
      // Real API-backed views; screenshots contain only the synthetic demo.
      await page.screenshot({ path: info.outputPath(`light-shell-${name}-${width}.png`), fullPage: true });
      await page.locator('header nav a[href="/search"]').focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
    }
  });
}
