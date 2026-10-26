import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.PLAYWRIGHT_SCALE !== "1",
  "Run against a generated scale vault with PLAYWRIGHT_SCALE=1.",
);

test("broad lexical search explains its bounded result set", async ({ page }) => {
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
});

test("contextual large-vault entry selects its real cluster without enabling the map", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/wiki/scale-0319");
  const explore = page.getByRole("link", { name: "Explore connections", exact: true });
  await expect(explore).toHaveAttribute("href", "/galaxy?page=scale-0319");
  await explore.click();
  await expect(page).toHaveURL(/\/galaxy\?page=scale-0319$/);
  await expect(page.locator(".galaxy-scale-note")).toContainText("Large snapshot");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "scale-0319");
  await expect(page.locator(".galaxy-breadcrumb")).toContainText("Synthetic constellation 8");
  await expect(page.locator(".galaxy-evidence")).toContainText("Declared relation");
  await page.getByRole("button", { name: "Map view", exact: true }).click();
  await expect(page.locator(".galaxy-star")).toHaveCount(40);
  await page.getByRole("link", { name: "Open article ↗", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/scale-0319$/);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-star")).toHaveCount(40);
  await page.reload();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
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
  await page.screenshot({ path: testInfo.outputPath("scale-map-overview.png"), fullPage: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.locator(".galaxy-neighborhood text:not(.galaxy-count)").evaluateAll(elements => {
      const svg = (elements[0] as SVGTextElement).ownerSVGElement!;
      const bounds = svg.getBoundingClientRect();
      return elements.every(element => {
        const label = element as SVGTextElement, box = label.getBoundingClientRect();
        return parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM()!.a >= 13.99 && box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
      });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`scale-map-overview-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator(".galaxy-cluster").last().click();
  await expect(page.locator(".galaxy-breadcrumb")).toContainText(
    "Synthetic constellation 8",
  );
  await expect(page.locator(".galaxy-star")).toHaveCount(40);
  expect(await page.locator(".galaxy-sidebar-content").evaluate(element => element.scrollTop), "new constellation heading must not retain the scrolled overview offset").toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("scale-map-cluster.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const targets = () => page.locator(".galaxy-star").evaluateAll(elements => elements.map(element => {
    const star = element as SVGGraphicsElement;
    const matrix = star.getScreenCTM()!;
    const center = new DOMPoint(0, 0).matrixTransform(matrix);
    return { id: star.getAttribute("data-node")!, x: center.x, y: center.y, radius: Number(star.querySelector(".galaxy-hit")!.getAttribute("r")) * matrix.a };
  }));
  await expect.poll(async () => (await targets()).length).toBe(40);
  // Dense stars keep distinct hit circles rather than relying on paint order.
  const checkTargets = async () => {
    const points = await targets();
    let clearance = Infinity;
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      clearance = Math.min(clearance, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) - points[i].radius - points[j].radius);
    }
    expect(clearance, "real rendered hit circles must stay disjoint").toBeGreaterThan(0);
  };
  await checkTargets();
  for (let step = 0; step < 3; step++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await checkTargets();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("scale-map-focused-mobile.png"), fullPage: true });
  for (const point of (await targets()).slice(0, 2)) {
    await page.locator(`.galaxy-star[data-node="${point.id}"]`).click();
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", point.id);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  await page.getByRole("link", { name: "Open article" }).click();
  await expect(page).toHaveURL(/\/wiki\/scale-0319$/);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("scale-history-list-390.png"), fullPage: true });
  await page.getByRole("button", { name: "Map view", exact: true }).click();
  await expect(page.locator(".galaxy-star")).toHaveCount(40);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const selectedView = await page.locator(".galaxy-stage svg").getAttribute("viewBox");
  await page.getByRole("link", { name: "Open article" }).click();
  await expect(page).toHaveURL(/\/wiki\/scale-0319$/);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage")).toBeVisible();
  await expect(page.locator(".galaxy-stage svg")).toHaveAttribute("viewBox", selectedView!);
  await page.screenshot({ path: testInfo.outputPath("scale-history-map-390.png"), fullPage: true });
  await page.getByRole("link", { name: "Refresh snapshot" }).click();
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic observation 320");
  await expect(page.locator(".galaxy-stage svg")).toHaveAttribute("viewBox", selectedView!);

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
  // Responsive columns intentionally differ; mutation stability is compared
  // at the same viewport as the initial snapshot.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => page.locator(".galaxy-star").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [element.getAttribute("data-node"), element.getAttribute("transform")])),
  )).toEqual(corePositions);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await page.locator(".galaxy-star").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [
      element.getAttribute("data-node"),
      element.getAttribute("transform"),
    ])),
  )).toEqual(corePositions);
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
