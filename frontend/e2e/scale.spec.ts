import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.PLAYWRIGHT_SCALE !== "1",
  "Run against a generated scale vault with PLAYWRIGHT_SCALE=1.",
);

test("large real vault has a compact stable map and usable mutation path", async ({
  page,
  request,
}) => {
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
  await expect(page.locator(".galaxy-scale-note")).toContainText("Large snapshot");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Choose a constellation" })).toBeVisible();
  await expect(page.locator(".galaxy-cluster")).toHaveCount(8);

  const mapStarted = Date.now();
  await page.getByRole("button", { name: "Map view" }).click();
  await expect(page.locator(".galaxy-stage")).toBeVisible();
  await expect(page.locator(".galaxy-neighborhood")).toHaveCount(8);
  await expect(page.locator(".galaxy-star")).toHaveCount(8);
  await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(8);
  expect(Date.now() - mapStarted).toBeLessThan(5_000);
  const corePositions = await page.locator(".galaxy-star").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [
      element.getAttribute("data-node"),
      element.getAttribute("transform"),
    ])),
  );
  await page.screenshot({ path: "../.demo/scale-map-overview.png", fullPage: true });

  await page.locator(".galaxy-cluster").last().click();
  await expect(page.locator(".galaxy-breadcrumb")).toContainText(
    "Synthetic constellation 8",
  );
  await expect(page.locator(".galaxy-star")).toHaveCount(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "../.demo/scale-map-cluster.png", fullPage: true });
  await page.getByRole("button", { name: "All constellations" }).click();
  await page.getByRole("button", { name: "List view" }).click();

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
  await page.getByRole("button", { name: "Map view" }).click();
  await expect(page.locator(".galaxy-star")).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await page.locator(".galaxy-star").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [
      element.getAttribute("data-node"),
      element.getAttribute("transform"),
    ])),
  )).toEqual(corePositions);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "../.demo/scale-map-mobile.png", fullPage: true });
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
