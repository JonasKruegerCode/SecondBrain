import { test, expect, Page, TestInfo } from "@playwright/test";

async function arrival(page: Page, title: string, info: TestInfo, width: number, step: string) {
  const heading = page.locator("article > h1");
  await expect(heading).toHaveText(title);
  const observed = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.tagName === "BODY" ? null : document.activeElement?.textContent,
    scrollY,
  }));
  console.log(`[article-focus] ${JSON.stringify({ width, step, observed })}`);
  await expect(heading).toBeFocused();
  expect(observed.scrollY).toBe(0);
  await page.keyboard.press("Tab");
  await expect(page.locator(".article-toc a").first()).toBeFocused();
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

async function holdRead(page: Page, pattern: string) {
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { received = resolve; });
  await page.route(pattern, async route => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  return { held, release };
}

test("fresh URLs, fragment arrivals and history keep their distinct focus paths", async ({ page }) => {
  await page.goto("/wiki/night-sky-survey");
  await expect(page.locator("article > h1")).toHaveText("Night sky survey");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
  await page.goto("/wiki/night-sky-survey#Sample%20log");
  const section = page.getByRole("heading", { name: "Sample log", exact: true });
  await expect(section).toBeFocused();
  const tide = page.locator(".prose").getByRole("link", { name: "tide clock", exact: true });
  await tide.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("article > h1")).toHaveText("Tide clock project");
  await expect(page.locator("article > h1")).toBeFocused();
  await page.goBack();
  await expect(page.locator("article > h1")).toHaveText("Night sky survey");
  await expect(section).toBeFocused();
  await page.goForward();
  await expect(page.locator("article > h1")).toHaveText("Tide clock project");
  await expect(page.locator("article > h1")).toBeFocused();
});

test("an arriving article respects deliberate header or main focus during its real read", async ({ page }) => {
  for (const destination of ["header", "main"]) {
    await page.goto("/wiki/home");
    await expect(page.locator("article > h1")).toHaveText("Lantern Bay field atlas");
    const hold = await holdRead(page, "**/api/wiki/pages/night-sky-survey");
    try {
      await page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true }).click();
      await hold.held;
      const target = destination === "main" ? page.locator("#main-content") :
        page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
      await target.focus();
      hold.release();
      await expect(page.locator("article > h1")).toHaveText("Night sky survey");
      await expect(target).toBeFocused();
      await expect(page.locator("article > h1")).not.toBeFocused();
    } finally {
      hold.release();
      await page.unroute("**/api/wiki/pages/night-sky-survey");
    }
  }
});

test("a late article read cannot take focus from a newer search", async ({ page }) => {
  await page.goto("/wiki/home");
  await expect(page.locator("article > h1")).toHaveText("Lantern Bay field atlas");
  const hold = await holdRead(page, "**/api/wiki/pages/night-sky-survey");
  try {
    await page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true }).click();
    await hold.held;
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Search pages" });
    await input.fill("Unsubmitted synthetic search");
    await input.focus();
    // Wait until the actual delayed response has completed before checking the
    // latest view. This is scripted timing, not an API outage claim.
    const responded = page.waitForResponse(response => response.url().endsWith("/api/wiki/pages/night-sky-survey"));
    hold.release();
    await (await responded).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Unsubmitted synthetic search");
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("article")).toHaveCount(0);
  } finally { hold.release(); }
});

test("a saved-start redirect preserves focus chosen during the page-list read", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("secondbrain.startpage", "night-sky-survey"));
  const hold = await holdRead(page, "**/api/wiki/pages");
  try {
    await page.goto("/");
    await hold.held;
    const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
    await search.focus();
    hold.release();
    await expect(page.locator("article > h1")).toHaveText("Night sky survey");
    await expect(search).toBeFocused();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home", exact: true })).not.toHaveAttribute("aria-current", "page");
  } finally { hold.release(); }
});
