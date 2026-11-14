import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.PLAYWRIGHT_SCALE !== "1",
  "Run against a generated scale vault with PLAYWRIGHT_SCALE=1.",
);

test("broad lexical search explains its bounded result set", async ({ page }, testInfo) => {
  await page.goto("/search");
  await page.getByRole("textbox", { name: "Search pages" }).fill("generated test data");
  await page.getByRole("button", { name: "Search →", exact: true }).click();

  await expect(page.locator("#results h2")).toHaveText("Showing the first 50 matches");
  await expect(page.locator("#results .search-limit")).toHaveText(
    "More pages match. Refine your search to find a specific page.",
  );
  await expect(page.locator("#results .card")).toHaveCount(50);
  await expect(page.locator("#search-status")).toHaveText(
    "Showing the first 50 matches for “generated test data”. More pages match; refine your search.",
  );
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Search →", exact: true })).toBeVisible();
    await expect(page.locator("#results .search-limit")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath(`bounded-search-${width}.png`),
      fullPage: true,
    });
  }
});

test("contextual large-vault entry selects its real cluster while every page stays a star", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/wiki/scale-0319");
  const explore = page.getByRole("link", { name: "Explore connections", exact: true });
  await expect(explore).toHaveAttribute("href", "/galaxy?page=scale-0319");
  await explore.click();
  await expect(page).toHaveURL(/\/galaxy\?page=scale-0319$/);
  await expect(page.locator(".galaxy-scale-note")).toContainText("every page is still a star");
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  await expect(page.locator(".galaxy-star")).toHaveCount(320);
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "scale-0319");
  await expect(page.locator(".galaxy-breadcrumb")).toContainText("Synthetic constellation 8");
  await expect(page.locator(".galaxy-evidence")).toContainText("Declared relation");
  await page.getByRole("link", { name: "Open article ↗", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/scale-0319$/);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-star")).toHaveCount(320);
  await page.reload();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
});

test("large real vault has a compact stable map and usable mutation path", async ({
  page,
  request,
}, testInfo) => {
  const started = Date.now();
  const response = await request.get("/api/wiki/graph");
  expect(response.ok()).toBeTruthy();
  const graph = await response.json();
  const graphMilliseconds = Date.now() - started;
  expect(graph.nodes).toHaveLength(320);
  expect(graph.edges.length).toBeGreaterThan(320);
  expect(graph.missing_targets).toEqual([]);
  expect(graph.ambiguous_targets).toEqual([]);
  expect(graphMilliseconds).toBeLessThan(5_000);

  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-scale-note")).toContainText("every page is still a star");
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a constellation" })).toBeVisible();
  await expect(page.locator(".galaxy-cluster")).toHaveCount(8);

  const mapStarted = Date.now();
  await expect(page.locator(".galaxy-star")).toHaveCount(320);
  await expect(page.locator(".galaxy-bridge-index li")).toHaveCount(8);
  expect(Date.now() - mapStarted).toBeLessThan(5_000);
  await page.screenshot({ path: testInfo.outputPath("scale-map-overview.png"), fullPage: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`scale-map-overview-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator(".galaxy-cluster").last().click();
  await expect(page.locator(".galaxy-breadcrumb")).toContainText(
    "Synthetic constellation 8",
  );
  await expect(page.locator(".galaxy-sidebar-content .galaxy-page")).toHaveCount(40);
  await expect(page.locator(".galaxy-star")).toHaveCount(320);
  expect(await page.locator(".galaxy-sidebar-content").evaluate(element => element.scrollTop), "new constellation heading must not retain the scrolled overview offset").toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("scale-map-cluster.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const memberIds = await page.locator(".galaxy-sidebar-content .galaxy-page").evaluateAll(elements =>
    elements.slice(0, 2).map(element => element.getAttribute("data-node")));
  expect(memberIds).toHaveLength(2);
  for (let step = 0; step < 3; step++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("scale-map-focused-mobile.png"), fullPage: true });
  for (const id of memberIds) {
    await page.locator(`.galaxy-page[data-node="${id}"]`).click();
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id!);
    await page.getByRole("button", { name: "Neighborhood pages" }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "All constellations" }).click();

  const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
  await search.fill("scale-0319");
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-selected-heading h2")).toContainText(
    "Synthetic observation 320",
  );
  await expect(page.locator(".galaxy-evidence")).toContainText("Declared relation");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.getByRole("link", { name: "Open article" })).toBeVisible();
  await page.getByRole("link", { name: "Open article" }).click();
  await expect(page).toHaveURL(/\/wiki\/scale-0319$/);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("scale-history-map-390.png"), fullPage: true });
  await expect(page.locator(".galaxy-star")).toHaveCount(320);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const selectedView = `${await page.locator(".galaxy-stage").getAttribute("data-zoom")}|${await page.locator(".galaxy-stage").getAttribute("data-pan")}`;
  await page.getByRole("link", { name: "Open article" }).click();
  await expect(page).toHaveURL(/\/wiki\/scale-0319$/);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage")).toBeVisible();
  await expect.poll(() => page.locator(".galaxy-stage").evaluate(element => `${element.getAttribute("data-zoom")}|${element.getAttribute("data-pan")}`)).toBe(selectedView);
  await page.screenshot({ path: testInfo.outputPath("scale-history-map-390.png"), fullPage: true });
  await page.getByRole("link", { name: "Refresh snapshot" }).click();
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect.poll(() => page.locator(".galaxy-stage").evaluate(element => `${element.getAttribute("data-zoom")}|${element.getAttribute("data-pan")}`)).toBe(selectedView);

  const id = `scale-live-${randomUUID()}`;
  const created = await request.post(`/api/wiki/pages/${id}`, {
    data: {
      markdown: `---\ngalaxy_group: synthetic-1\ngalaxy_label: Synthetic constellation 1\n---\n# Live scale mutation\n\nLinked to [[scale-0000]].`,
      base_revision: null,
      request_id: randomUUID(),
    },
  });
  expect(created.ok()).toBeTruthy();
  const saved = await created.json();
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-star")).toHaveCount(321);
  await expect(page.locator(`.galaxy-star[data-node="${id}"]`)).toBeVisible();
  // Adding a page changes the topology-aware field, so earlier core slots are
  // not a stable screenshot. The same snapshot must still agree with itself.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const placed = () => page.locator(".galaxy-star.is-core").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [element.getAttribute("data-node"), `${element.getAttribute("data-x")},${element.getAttribute("data-y")}`])));
  const once = await placed();
  expect(Object.keys(once).length).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(placed).toEqual(once);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("scale-map-mobile.png"), fullPage: true });
  await search.fill(id);
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Live scale mutation");

  const deleted = await request.delete(`/api/wiki/pages/${id}`, {
    data: { base_revision: saved.revision, request_id: randomUUID() },
  });
  expect(deleted.ok()).toBeTruthy();
  await page.goto("/galaxy");
  await search.fill(id);
  await expect(page.locator(".galaxy-sidebar-content")).toContainText(
    "No title or page ID matches.",
  );
});
