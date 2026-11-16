import { test as base } from "@playwright/test";

// Record the actual engine and the profile's worker boundary, without logging
// page contents or URLs. Held routes still fetch the actual API response.
export const test = base.extend({
  page: async ({ page, browser, serviceWorkers }, use) => {
    const engine = browser.browserType().name();
    console.info("[reading-browser] " + JSON.stringify({ engine, service_workers: serviceWorkers }));
    await use(page);
  },
});
