import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
test(`dense curated constellation shows direct links and keyboard zoom (${width})`, async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const prefix = `density-${randomUUID()}`;
  const ids = Array.from({ length: 51 }, (_, index) => `${prefix}-${index}`);
  const title = (index: number) => `Synthetic star ${index} ${prefix}`;
  const label = `Dense synthetic constellation ${prefix}`;
  const outside = `outside-${randomUUID()}`;
  const outsideTitle = "Synthetic sparse outside star";
  const owned: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    // Native writes and graph reads exercise the actual Markdown snapshot.
    for (const [index, id] of ids.entries()) {
      const markdown = `---\ngalaxy_group: ${prefix}\ngalaxy_label: ${label}\n${index === 0 ? "galaxy_anchor: true\n" : ""}---\n# ${title(index)}\n\n${ids.filter(other => other !== id).map(other => `[[${other}]]`).join("\n")}${index === 17 ? `\n[[${outside}]]` : ""}\n`;
      const created = await request.post(`/api/wiki/pages/${id}`, {
        data: { markdown, base_revision: null, request_id: randomUUID() },
      });
      expect(created.ok(), `create owned fixture ${id}`).toBeTruthy();
      owned.push(id);
    }
    const external = await request.post(`/api/wiki/pages/${outside}`, {
      data: { markdown: `---\ngalaxy_group: ${outside}\ngalaxy_label: ${outsideTitle}\ngalaxy_anchor: true\n---\n# ${outsideTitle}\n\n[[${ids[17]}]]`,
        base_revision: null, request_id: randomUUID() },
    });
    expect(external.ok()).toBeTruthy();
    owned.push(outside);
    const snapshot = await request.get("/api/wiki/graph");
    expect(snapshot.ok()).toBeTruthy();
    const graph = await snapshot.json();
    expect(graph.nodes.filter((node: { id: string }) => node.id.startsWith(prefix))).toHaveLength(51);
    const fixtureEdges = graph.edges.filter((edge: { source: string; target: string }) =>
      edge.source.startsWith(prefix) && edge.target.startsWith(prefix));
    expect(fixtureEdges).toHaveLength(2550);
    expect(graph.edges.filter((edge: { source: string; target: string }) =>
      edge.source === outside || edge.target === outside)).toHaveLength(2);
    expect(new Set(fixtureEdges.map((edge: { source: string; target: string }) => `${edge.source}:${edge.target}`)).size).toBe(2550);

    await page.setViewportSize({ width, height: 844 });
    await page.goto("/galaxy");
    await expect(page.getByRole("button", { name: "Map view", exact: true })).toBeVisible();
    await page.locator(".galaxy-cluster").filter({ hasText: label }).click();
    await page.getByRole("button", { name: "Map view", exact: true }).click();
    await expect(page.locator(".galaxy-stage svg")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`dense-before-selection-${width}.png`), fullPage: true });

    const notice = page.locator(".galaxy-density-note");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/direct links/i);
    await expect(notice).toContainText("within this constellation");
    await expect(notice).toContainText(/core|selected/i);
    const lines = page.locator(".galaxy-stage .galaxy-edge");
    await expect(lines).toHaveCount(100);
    expect(await lines.locator("title").allTextContents()).toEqual(
      expect.arrayContaining([expect.stringContaining(title(0))]),
    );
    expect((await lines.locator("title").allTextContents()).every(text => text.includes(title(0)))).toBe(true);
    await expect(page.locator(".galaxy-star")).toHaveCount(51);

    const other = page.locator(`.galaxy-star[data-node="${ids[17]}"]`);
    await other.focus();
    await expect(other).toBeFocused();
    const viewWidth = () => page.locator(".galaxy-stage svg").evaluate(element =>
      (element as SVGSVGElement).viewBox.baseVal.width);
    const focusedVisible = () => other.evaluate(element => {
      const star = element as SVGGraphicsElement;
      const bounds = star.ownerSVGElement!.getBoundingClientRect();
      const point = new DOMPoint(0, 0).matrixTransform(star.getScreenCTM()!);
      return point.x >= bounds.left + 25.9 && point.x <= bounds.right - 25.9 &&
        point.y >= bounds.top + 25.9 && point.y <= bounds.bottom - 25.9;
    });
    const fitWidth = await viewWidth();
    await page.keyboard.press("+");
    await expect.poll(viewWidth).toBeLessThan(fitWidth);
    await expect(other).toBeFocused();
    expect(await focusedVisible(), "zoom must retain a visible focused star").toBe(true);
    for (let step = 0; step < 20; step++) await page.keyboard.press("+");
    expect(await viewWidth()).toBeCloseTo(fitWidth / 4, 3);
    expect(await focusedVisible(), "maximum zoom must not hide focus or silently reset").toBe(true);
    await page.keyboard.press("=");
    expect(await viewWidth()).toBeCloseTo(fitWidth / 4, 3);
    for (let step = 0; step < 20; step++) await page.keyboard.press("-");
    expect(await viewWidth()).toBeCloseTo(fitWidth / .75, 3);
    expect(await focusedVisible()).toBe(true);
    await page.keyboard.press("=");
    await expect.poll(viewWidth).toBeCloseTo(fitWidth, 3);
    // Literal search text must not invoke map zoom.
    const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
    await search.fill("Synthetic");
    await search.press("End");
    await page.keyboard.press("+");
    await page.keyboard.press("-");
    await expect(search).toHaveValue("Synthetic+-");
    expect(await viewWidth()).toBeCloseTo(fitWidth, 3);
    await search.fill("");
    await other.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(17));
    await expect(lines).toHaveCount(100);
    expect((await lines.locator("title").allTextContents()).every(text => text.includes(title(17)))).toBe(true);
    await expect(page.locator(".galaxy-evidence > li")).toHaveCount(102);
    await expect(page.locator(".galaxy-evidence")).toContainText(outsideTitle);
    expect((await lines.locator("title").allTextContents()).some(text => text.includes(outsideTitle))).toBe(false);
    // Screen-sized labels must stay inside the actual SVG, including when an
    // outer star is selected in a narrow, dense constellation.
    const edgeId = await page.locator(".galaxy-star").evaluateAll(elements =>
      elements.map(element => {
        const star = element as SVGGraphicsElement;
        return { id: star.getAttribute("data-node")!, x: new DOMPoint(0, 0).matrixTransform(star.getScreenCTM()!).x };
      }).sort((a, b) => b.x - a.x)[0].id);
    await page.locator(`.galaxy-star[data-node="${edgeId}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(ids.indexOf(edgeId)));
    const labelsContained = () => page.locator(".galaxy-star text").evaluateAll(elements => {
      const svg = (elements[0] as SVGTextElement).ownerSVGElement!;
      const bounds = svg.getBoundingClientRect();
      return elements.every(element => {
        const label = element as SVGTextElement;
        if (getComputedStyle(label).visibility === "hidden") return true;
        const box = label.getBoundingClientRect();
        return box.left >= bounds.left + 5 && box.right <= bounds.right - 5 &&
          box.top >= bounds.top + 5 && box.bottom <= bounds.bottom - 5 &&
          parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM()!.a >= 11.99;
      });
    });
    for (const labelWidth of [width, 320, 1440, width]) {
      await page.setViewportSize({ width: labelWidth, height: 844 });
      await expect.poll(labelsContained).toBe(true);
      await expect(page.locator(".galaxy-star.is-selected text")).toBeVisible();
    }
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(labelsContained).toBe(true);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(labelsContained).toBe(true);
    await page.screenshot({ path: info.outputPath(`dense-edge-label-${width}.png`), fullPage: true });
    await page.locator(`.galaxy-star[data-node="${ids[17]}"]`).focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`dense-selected-${width}.png`), fullPage: true });
    await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article" }).click();
    await expect(page).toHaveURL(new RegExp(`/wiki/${ids[17]}$`));
    await expect(page.locator("article > h1")).toHaveText(title(17));
    await page.goBack();
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(17));
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await expect(page.locator(".galaxy-stage")).toBeHidden();
    await expect(notice).toBeHidden();
    await page.getByRole("button", { name: "Map view", exact: true }).click();
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(17));
    await expect(lines).toHaveCount(100);
    await expect(notice).toBeVisible();
    await page.getByRole("button", { name: "All constellations" }).click();
    await page.locator(".galaxy-cluster").filter({ hasText: outsideTitle }).click();
    await expect(notice).toBeHidden();
    await expect(page.locator(".galaxy-star")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    // Only successfully created, UUID-owned pages can enter this cleanup list.
    for (const id of owned.reverse()) {
      const current = await request.get(`/api/wiki/pages/${id}`);
      expect(current.ok(), `read current cleanup revision for ${id}`).toBeTruthy();
      const removed = await request.delete(`/api/wiki/pages/${id}`, {
        data: { base_revision: (await current.json()).revision, request_id: randomUUID() },
      });
      expect(removed.ok(), `remove owned fixture ${id}`).toBeTruthy();
    }
  }
});

}
