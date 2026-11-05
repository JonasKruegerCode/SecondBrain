import { expect } from "@playwright/test";
import { test } from "./reading-test";

test("galaxy exposes one tab stop and arrows move to the nearest star in that direction", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/galaxy?page=archive-method");
  const stars = page.locator(".galaxy-star");
  await expect(stars).toHaveCount(4);

  const tabStop = page.locator('.galaxy-star[tabindex="0"]');
  await expect(tabStop).toHaveCount(1);
  await expect(page.locator('.galaxy-star[tabindex="-1"]')).toHaveCount(3);

  const destination = await tabStop.evaluate(element => {
    const star = element as SVGGElement;
    const origin = star.transform.baseVal.consolidate()?.matrix;
    if (!origin) return null;
    const directions = [
      { key: "ArrowLeft", x: -1, y: 0 },
      { key: "ArrowRight", x: 1, y: 0 },
      { key: "ArrowUp", x: 0, y: -1 },
      { key: "ArrowDown", x: 0, y: 1 },
    ];
    let best: { id: string; key: string; score: number } | null = null;
    for (const direction of directions) {
      for (const candidate of star.ownerSVGElement!.querySelectorAll<SVGGElement>(".galaxy-star")) {
        if (candidate === star) continue;
        const point = candidate.transform.baseVal.consolidate()?.matrix;
        if (!point) continue;
        const dx = point.e - origin.e, dy = point.f - origin.f;
        const forward = dx * direction.x + dy * direction.y;
        if (forward <= .5) continue;
        const lateral = Math.abs(dx * direction.y - dy * direction.x);
        const score = forward + lateral * 1.75;
        if (!best || score < best.score) best = { id: candidate.dataset.node!, key: direction.key, score };
      }
    }
    return best && { id: best.id, key: best.key };
  });
  if (!destination) throw new Error("The fixture must contain a directional neighboring star.");

  await tabStop.focus();
  await page.keyboard.press(destination.key);
  const next = page.locator(`.galaxy-star[data-node="${destination.id}"]`);
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("tabindex", "0");
  await expect(page.locator('.galaxy-star[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.galaxy-star[tabindex="-1"]')).toHaveCount(3);

  const title = await next.locator("title").textContent();
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title!);
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeFocused();
  await expect(page.locator('.galaxy-star[tabindex="0"]')).toHaveCount(1);

  const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.galaxy-star[tabindex="0"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
