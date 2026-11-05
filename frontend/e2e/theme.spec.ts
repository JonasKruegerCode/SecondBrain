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

test("material atmosphere covers the full article and reactive light respects motion preferences", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/wiki/home");
  await expect(page.locator(".prose")).toBeVisible();
  const coverage = await page.locator(".ambient").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top + scrollY, bottom: rect.bottom + scrollY, height: document.documentElement.scrollHeight };
  });
  expect(coverage.top).toBe(0);
  expect(coverage.bottom).toBeGreaterThanOrEqual(coverage.height);
  const button = page.locator(".toolbar .primary");
  await button.hover();
  await expect.poll(() => button.evaluate(node => node.style.getPropertyValue("--light-x"))).not.toBe("");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => button.evaluate(node => node.style.getPropertyValue("--light-x"))).toBe("");
  expect(await button.evaluate(node => getComputedStyle(node, "::before").display)).toBe("none");
  await page.screenshot({ path: info.outputPath("material-long-article.png"), fullPage: true });
});
