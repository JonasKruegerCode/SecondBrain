import { test, expect } from "@playwright/test";
import type { Graph } from "../src/galaxy";

for (const width of [390, 1440]) {
  test(`galaxy typing preserves the map and updates search highlights (${width})`, async ({ page, request }, info) => {
    const response = await request.get("/api/wiki/graph");
    expect(response.ok()).toBe(true);
    const graph: Graph = await response.json();
    const id = graph.nodes[0].id;
    const title = graph.nodes[0].title || id;
    const neighbors = new Set([id, ...graph.edges.flatMap(edge =>
      edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : [])]);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/galaxy?page=${encodeURIComponent(id)}`);
    const mode = page.locator('[data-action="list"]');
    if (await mode.getAttribute("aria-pressed") === "true") await mode.click();
    const stage = page.locator(".galaxy-stage");
    const svg = await stage.locator("svg").elementHandle();
    expect(svg).not.toBeNull();
    await page.locator('[data-action="zoom-in"]').click();
    const viewBox = await stage.locator("svg").getAttribute("viewBox");
    const positions = await stage.locator(".galaxy-star").evaluateAll(stars =>
      stars.map(star => [star.getAttribute("data-node"), star.getAttribute("transform")]));
    const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
    await search.focus();
    await search.pressSequentially(id, { delay: 15 });
    await expect(search).toBeFocused();
    for (const query of [id, "no-matching-synthetic-page-9b42", ""]) {
      if (query !== id) await search.fill(query);
      // A search changes visibility/highlights, never the geometry or the SVG
      // identity. This also protects pan/zoom and the selected link evidence.
      expect(await svg!.evaluate(element => element.isConnected)).toBe(true);
      await expect(stage.locator("svg")).toHaveAttribute("viewBox", viewBox!);
      expect(await stage.locator(".galaxy-star").evaluateAll(stars =>
        stars.map(star => [star.getAttribute("data-node"), star.getAttribute("transform")]))).toEqual(positions);
      const stars = await stage.locator(".galaxy-star").evaluateAll(elements =>
        elements.map(element => ({ id: element.getAttribute("data-node")!, dimmed: element.classList.contains("is-dimmed") })));
      for (const star of stars) {
        const node = graph.nodes.find(node => node.id === star.id)!;
        const matches = !query || `${node.title || node.id} ${node.id}`.toLowerCase().includes(query.toLowerCase());
        expect(star.dimmed, star.id).toBe(!matches || !neighbors.has(star.id));
      }
      const hits = graph.nodes.filter(node => `${node.title || node.id} ${node.id}`.toLowerCase().includes(query.toLowerCase()));
      if (query) await expect(page.locator(".galaxy-page")).toHaveCount(hits.length);
      else await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
    }
    const other = graph.nodes.find(node => node.id !== id)!;
    await search.fill(other.id);
    const resultSelector = await page.evaluate(id => `.galaxy-page[data-node="${CSS.escape(id)}"]`, other.id);
    await page.locator(resultSelector).click();
    await expect(search).toHaveValue("");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(other.title || other.id);
    await expect(stage.locator(".galaxy-star.is-selected")).toHaveAttribute("data-node", other.id);
    await page.locator('[data-action="overview"]').click();
    await search.fill(id);
    const overviewStars = await stage.locator(".galaxy-star").evaluateAll(elements =>
      elements.map(element => ({ id: element.getAttribute("data-node")!, dimmed: element.classList.contains("is-dimmed") })));
    expect(overviewStars.length).toBeGreaterThan(0);
    for (const star of overviewStars) {
      const node = graph.nodes.find(node => node.id === star.id)!;
      expect(star.dimmed).toBe(!`${node.title || node.id} ${node.id}`.toLowerCase().includes(id.toLowerCase()));
    }
    // Trailing whitespace leaves the normalized results unchanged. Existing
    // result controls should survive, rather than remount on every input.
    const result = await page.locator(".galaxy-page").first().elementHandle();
    await search.press("End");
    await search.press("Space");
    expect(await result!.evaluate(element => element.isConnected)).toBe(true);
    await page.screenshot({ path: info.outputPath(`galaxy-search-${width}.png`) });
    expect((await (await request.get("/api/wiki/graph")).json()).revision).toBe(graph.revision);
  });
}
