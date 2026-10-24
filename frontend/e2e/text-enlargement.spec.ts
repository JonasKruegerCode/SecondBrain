import { expect, Page } from "@playwright/test";
import { test } from "./reading-test";

// Double all computed HTML font sizes simultaneously, including explicit px
// declarations. This is a text-only layout stress test, not native browser zoom.
async function enlargeText(page: Page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter(node => node.getClientRects().length && !node.closest("svg"));
    const sizes = nodes.map(node => parseFloat(getComputedStyle(node).fontSize));
    nodes.forEach((node, index) => node.style.setProperty("font-size", `${2 * sizes[index]}px`, "important"));
    return nodes.every((node, index) => Math.abs(parseFloat(getComputedStyle(node).fontSize) - 2 * sizes[index]) < 0.1);
  });
}

for (const width of [320, 1440]) {
  test(`HTML text at 200 percent keeps navigation and map controls inside the viewport (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/wiki/home", "/galaxy", "/search"]) {
      await page.goto(route);
      await expect(page.locator(route === "/galaxy" ? ".galaxy-stage" : route === "/search" ? "#results" : ".prose")).toBeVisible();
      expect(await enlargeText(page)).toBe(true);
      await page.screenshot({ path: info.outputPath(`text-enlargement-${width}-${route.slice(1).replace("/", "-")}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const tagline = page.locator(".brand small");
      if (await tagline.isVisible()) {
        const separated = await page.locator(".brand").evaluate(brand => {
          const text = Array.from(brand.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
          if (!text) return false;
          const range = document.createRange(); range.selectNodeContents(text);
          return brand.querySelector("small")!.getBoundingClientRect().top >= range.getBoundingClientRect().bottom - 1;
        });
        expect(separated, "brand tagline must not overlap the enlarged name").toBe(true);
      }
      if (route === "/galaxy") {
        const workspace = await page.locator(".galaxy-workspace").boundingBox();
        for (const button of await page.locator(".galaxy-controls button").all()) {
          await button.scrollIntoViewIfNeeded();
          const box = await button.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(workspace!.x);
          expect(box!.x + box!.width).toBeLessThanOrEqual(workspace!.x + workspace!.width);
        }
        await page.getByRole("button", { name: "List view", exact: true }).click();
        await expect(page.locator(".galaxy")).toHaveClass(/is-list-view/);
        const input = page.locator(".galaxy-search input");
        const sizes = await input.evaluate(node => ({ height: node.clientHeight, font: parseFloat(getComputedStyle(node).fontSize), padding: parseFloat(getComputedStyle(node).paddingTop) + parseFloat(getComputedStyle(node).paddingBottom) }));
        expect(sizes.height).toBeGreaterThanOrEqual(sizes.font + sizes.padding - 1);
      } else if (route === "/search") {
        const input = page.getByRole("textbox", { name: "Search pages" });
        expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(100);
        await input.fill("tide");
        await page.locator("main form button").click();
        await expect(page.locator("#results a").first()).toBeVisible();
      } else {
        await page.locator('header a[href="/search"]').focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
      }
    }
  });
}
