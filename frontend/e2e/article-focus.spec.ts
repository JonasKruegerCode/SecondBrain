import { test, expect, Page, TestInfo } from "@playwright/test";

// The temporary CI baseline records the existing failure before changing the
// router. The normal contract requires an announced article destination.
const baseline = process.env.PLAYWRIGHT_FOCUS_BASELINE === "1";

async function arrival(page: Page, title: string, info: TestInfo, width: number, step: string) {
  const heading = page.locator("article > h1");
  await expect(heading).toHaveText(title);
  const observed = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.tagName === "BODY" ? null : document.activeElement?.textContent,
    scrollY,
  }));
  console.log(`[article-focus] ${JSON.stringify({ baseline, width, step, observed })}`);
  if (baseline) await expect(page.locator("body")).toBeFocused();
  else {
    await expect(heading).toBeFocused();
    expect(observed.scrollY).toBe(0);
    await page.keyboard.press("Tab");
    await expect(page.locator(".article-toc a").first()).toBeFocused();
  }
  await page.screenshot({ path: info.outputPath(`article-focus-${step}-${width}.png`) });
}

for (const width of [390, 1440]) {
  test(`keyboard article arrivals retain a useful reading destination (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?overview=1");
    const open = page.getByRole("link", { name: /Open Lantern Bay field atlas/ });
    await expect(open).toBeVisible();
    await open.focus();
    await page.keyboard.press("Enter");
    await arrival(page, "Lantern Bay field atlas", info, width, "home");
    const survey = page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true });
    await survey.focus();
    await page.keyboard.press("Enter");
    await arrival(page, "Night sky survey", info, width, "wikilink");
    const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
    await search.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Search pages" });
    await input.fill("sheltered garden");
    await page.keyboard.press("Enter");
    const result = page.locator('#results a[href="/wiki/night-sky-survey"]');
    await expect(result).toBeVisible();
    await result.focus();
    await page.keyboard.press("Enter");
    await arrival(page, "Night sky survey", info, width, "search");
  });
}
