import { expect } from "@playwright/test";
import { test } from "./reading-test";

// Real demo content and native preferences. Faults below deliberately abort a
// request or deny an API; they do not emulate a physical device/storage failure.
for (const width of [390, 1440]) {
  test(`global Home and brand respect the curated and personal start (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    for (const saved of [false, true]) {
      if (saved) {
        await page.goto("/wiki/field-notebook");
        await page.getByRole("button", { name: "Set as start page" }).click();
        await expect(page.locator(".notice")).toHaveText("This is now your start page.");
      }
      for (const control of ["Home", "brand"]) {
        await page.goto("/search");
        if (control === "Home") {
          const link = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home", exact: true });
          await link.focus();
          await page.keyboard.press("Enter");
        } else await page.locator("a.brand").click();
        await expect(page).toHaveURL(saved ? /\/wiki\/field-notebook$/ : /\/wiki\/home$/);
        await expect(page.locator("article h1")).toHaveText(saved ? "Field notebook" : "Lantern Bay field atlas");
        expect(await page.evaluate(async () => {
          const path = "/src/start-preference.ts";
          return (await import(/* @vite-ignore */ path)).readStartPage();
        })).toBe(saved ? "field-notebook" : "");
      }
      await page.getByRole("link", { name: "← All pages", exact: true }).click();
      await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
      await expect(page.locator(".library .card")).toHaveCount(12);
    }
    await page.screenshot({ path: info.outputPath(`global-home-overview-${width}.png`), fullPage: true });
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
    await expect(page.locator("article h1")).toHaveText("Field notebook");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`global-home-personal-${width}.png`), fullPage: true });
  });

  test(`unavailable saved start and Home fall back once (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/wiki/field-notebook");
    await page.getByRole("button", { name: "Set as start page" }).click();
    await expect(page.locator(".notice")).toHaveText("This is now your start page.");
    let savedReads = 0, homeReads = 0;
    await page.route("**/api/wiki/pages/field-notebook", async route => {
      savedReads++;
      await route.abort("failed");
    });
    await page.route("**/api/wiki/pages/home", async route => {
      homeReads++;
      await route.abort("failed");
    });
    await page.goto("/");
    await expect(page).toHaveURL(/\/?\?overview=1$/);
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".start-page-notice")).toContainText("Home could not be opened");
    expect([savedReads, homeReads]).toEqual([1, 1]);
    await page.screenshot({ path: info.outputPath(`saved-start-overview-${width}.png`), fullPage: true });
    expect(await page.evaluate(async () => {
      const path = "/src/start-preference.ts";
      return (await import(/* @vite-ignore */ path)).readStartPage();
    })).toBe("field-notebook");
    await page.unroute("**/api/wiki/pages/field-notebook");
    await page.unroute("**/api/wiki/pages/home");
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
    await expect(page.locator("article h1")).toBeVisible();
  });

  test(`fresh arrival opens curated Home without choosing a personal start (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
    expect(await page.evaluate(async () => {
      const path = "/src/start-preference.ts";
      return (await import(/* @vite-ignore */ path)).readStartPage();
    })).toBe("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`curated-arrival-${width}.png`), fullPage: true });
    await page.locator(".prose a[href='/wiki/mira-quill']").click();
    await expect(page.locator("article h1")).toHaveText("Mira Quill — fictional archivist");
    await page.goBack();
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
    await page.reload();
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
    await page.goto("/?source=pwa");
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
    await page.getByRole("link", { name: "All pages" }).click();
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
  });

  test(`explicit overview presence bypasses the default and saved choice (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/wiki/mira-quill");
    await page.getByRole("button", { name: "Set as start page" }).click();
    await expect(page.locator(".notice")).toHaveText("This is now your start page.");
    for (const query of ["?overview", "?overview=0", "?overview=1"]) {
      await page.goto("/" + query);
      await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
      await expect(page.locator("article")).toHaveCount(0);
    }
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/mira-quill$/);
    await expect(page.locator("article h1")).toHaveText("Mira Quill — fictional archivist");
  });

  test(`failed automatic Home read returns to an honest overview without a loop (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/wiki/pages/home", route => route.abort("failed"), { times: 1 });
    await page.goto("/");
    await expect(page).toHaveURL(/\/?\?overview=1$/);
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".start-page-notice")).toHaveText("Home could not be opened. The page overview is shown instead. Your start-page choice is unchanged.");
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
  });

  test(`unreadable preference remains visible instead of silently choosing Home (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      indexedDB.open = () => { throw new DOMException("Synthetic denied preference", "SecurityError"); };
    });
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".start-page-notice")).toContainText("could not read your start-page preference");
    await page.locator(".grid a[href='/wiki/home']").click();
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
  });
}


for (const savedUnavailable of [false, true]) {
  test(`delayed ${savedUnavailable ? "fallback" : "default"} Home read cannot replace a newer search visit`, async ({ page }) => {
    if (savedUnavailable) {
      await page.goto("/wiki/field-notebook");
      await page.getByRole("button", { name: "Set as start page" }).click();
      await expect(page.locator(".notice")).toHaveText("This is now your start page.");
      await page.route("**/api/wiki/pages/field-notebook", route => route.abort("failed"));
    }
    let release!: () => void, arrived!: () => void, delivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetched = new Promise<void>(resolve => { arrived = resolve; });
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    await page.route("**/api/wiki/pages/home", async route => {
      try {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        arrived();
        await gate;
        await route.fulfill({ response });
      } finally { delivered(); }
    }, { times: 1 });
    try {
      await page.goto("/");
      await fetched;
      await expect(page.locator("main")).toHaveText("Opening your workspace…");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
      release();
      await completed;
      await expect(page).toHaveURL(/\/search$/);
      await expect(page.locator("article")).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
    } finally { release(); }
  });
}
