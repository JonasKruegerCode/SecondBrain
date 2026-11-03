import { expect, Locator } from "@playwright/test";
import { test } from "./reading-test";

async function expectFocusInside(star: Locator) {
  const bounds = await star.evaluate(element => {
    const star = element as SVGGraphicsElement;
    const ring = star.querySelector<SVGCircleElement>(".galaxy-hit")!;
    const box = ring.getBoundingClientRect(), map = star.ownerSVGElement!.getBoundingClientRect();
    const style = getComputedStyle(ring);
    // Measure the painted ring, including its transformed stroke, rather
    // than accepting an in-view center with a clipped focus indicator.
    const unit = Math.hypot(ring.getScreenCTM()!.a, ring.getScreenCTM()!.b);
    const padding = parseFloat(style.strokeWidth) * unit / 2;
    if (style.stroke === "none" || Number(style.strokeOpacity) === 0) throw new Error("keyboard focus ring is not painted");
    return { left: box.left - padding - map.left, right: map.right - box.right - padding,
      top: box.top - padding - map.top, bottom: map.bottom - box.bottom - padding };
  });
  for (const gap of Object.values(bounds)) expect(gap, `full focus bounds ${JSON.stringify(bounds)}`).toBeGreaterThanOrEqual(-.5);
}

for (const width of [320, 390, 1440]) {
  for (const forcedColors of ["none", "active"] as const) {
    test(`zoomed galaxy keeps the complete keyboard focus inside (${width}, ${forcedColors})`, async ({ page, browserName }, info) => {
      test.skip(forcedColors === "active" && browserName !== "chromium", "Forced-colors emulation requires Chromium.");
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ forcedColors, reducedMotion: "reduce" });
      await page.goto("/galaxy?page=archive-method");
      const stars = page.locator(".galaxy-star");
      await expect(stars).toHaveCount(4);
      const ids = await stars.evaluateAll(elements => elements.map(element => element.getAttribute("data-node")!));
      for (const id of ids) {
        const star = page.locator(`.galaxy-star[data-node="${id}"]`);
        await star.focus();
        for (let step = 0; step < 12; step++) await page.keyboard.press("+");
        await expect(star).toBeFocused();
        await expectFocusInside(star);
        await page.keyboard.press("Enter");
        await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeFocused();
      }
      const star = page.locator('.galaxy-star[data-node="archive-method"]');
      await star.focus();
      await expectFocusInside(star);
      await page.screenshot({ path: info.outputPath(`focus-bounds-${width}-${forcedColors}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
