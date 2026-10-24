import { test, expect } from "@playwright/test";
import type { Graph } from "../src/galaxy";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";

// Follow the document's actual tab sequence instead of focusing controls from
// script: focus ownership alone does not establish a visible keyboard marker.
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

for (const width of [320, 390, 1440]) {
  test(`keyboard wiki journey keeps Galaxy search focus visible (${width})`, async ({ page, request }, info) => {
    test.setTimeout(60_000);
    const id = `keyboard-journey-${randomUUID()}`;
    const title = "Keyboard field observation";
    const initial = `# ${title}\nAn invented observation with a [[home|route home]].`;
    const created = await request.post(`/api/wiki/pages/${id}`, { data: {
      markdown: initial, base_revision: null, request_id: randomUUID(),
    } });
    expect(created.ok()).toBe(true);
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/?overview=1");
      await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
      await tabTo(page, page.getByRole("link", { name: /Open Lantern Bay field atlas/ }));
      await page.keyboard.press("Enter");
      await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
      await expect(page.locator("article h1")).toBeFocused();
      await tabTo(page, page.locator('.prose a[href="/wiki/mira-quill"]').first());
      await page.keyboard.press("Enter");
      await expect(page.locator("article h1")).toHaveText("Mira Quill — fictional archivist");
      await expect(page.locator("article h1")).toBeFocused();
      const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
      await tabTo(page, navigation.getByRole("link", { name: "Search", exact: true }));
      await page.keyboard.press("Enter");
      await tabTo(page, page.getByRole("textbox", { name: "Search pages" }));
      await page.keyboard.insertText(id);
      await page.keyboard.press("Enter");
      const result = page.locator(`#results a[href="/wiki/${id}"]`);
      await expect(result).toBeVisible();
      await tabTo(page, result);
      await page.keyboard.press("Enter");
      await expect(page.locator("article h1")).toHaveText(title);
      await expect(page.locator("article h1")).toBeFocused();
      await tabTo(page, page.getByRole("button", { name: "Edit page", exact: false }));
      await page.keyboard.press("Enter");
      const editor = page.locator("#editor");
      await expect(editor).toBeFocused();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(initial + "\nA keyboard-only synthetic correction.");
      await tabTo(page, page.getByRole("button", { name: "Save changes", exact: false }));
      await page.keyboard.press("Enter");
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await expect(page.locator(".prose")).toContainText("keyboard-only synthetic correction");
      await tabTo(page, page.locator(".page-history summary"));
      await page.keyboard.press("Enter");
      await expect(page.locator(".history-list li")).toHaveCount(2);
      await tabTo(page, navigation.getByRole("link", { name: "Galaxy", exact: true }));
      await page.keyboard.press("Enter");
      const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
      await expect(search).toBeVisible();
      await tabTo(page, search);
      await expect(search).toBeFocused();
      const marker = await search.evaluate(element => {
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor,
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      console.log(`[keyboard-galaxy-focus] ${JSON.stringify({ width, marker })}`);
      await page.screenshot({ path: info.outputPath(`keyboard-galaxy-focus-${width}.png`) });
      expect(marker.style).toBe("solid");
      expect(parseFloat(marker.width)).toBeGreaterThanOrEqual(2);
      expect(marker.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(marker.left).toBeGreaterThanOrEqual(0);
      expect(marker.right).toBeLessThanOrEqual(width);
      await page.keyboard.insertText(id);
      const star = page.locator(`.galaxy-page[data-node="${id}"]`);
      await expect(star).toBeVisible();
      await tabTo(page, star);
      await page.keyboard.press("Enter");
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
      await tabTo(page, page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article" }));
      await page.keyboard.press("Enter");
      await expect(page.locator("article h1")).toHaveText(title);
      await expect(page.locator("article h1")).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      const current = await request.get(`/api/wiki/pages/${id}`);
      expect(current.ok()).toBe(true);
      expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
        base_revision: (await current.json()).revision, request_id: randomUUID(),
      } })).ok()).toBe(true);
    }
  });
}

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
