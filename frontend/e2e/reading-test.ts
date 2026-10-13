import { test as base } from "@playwright/test";

// Arm WebKit interception before the first document. Later specific held-read
// routes take precedence; this baseline always forwards the actual request.
export const test = base.extend({
  page: async ({ page, browser }, use) => {
    const engine = browser.browserType().name();
    if (engine === "webkit") await page.route("**/*", route => route.continue());
    console.info("[reading-browser] " + JSON.stringify({ engine, initial_interception: engine === "webkit" }));
    await use(page);
  },
});
