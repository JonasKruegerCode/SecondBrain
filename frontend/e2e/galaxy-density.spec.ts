import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  test(`galaxy display caps keep astral title characters intact (${width})`, async ({ page, request }, info) => {
    const token = randomUUID(), group = `unicode-label-${token}`;
    const ids = [`unicode-core-${token}`, `unicode-neighbor-${token}`];
    const titles = ["Synthetic orbital guide 𝛼 beyond the horizon", "Synthetic orbital guide 🚀 through the night"];
    const owned: string[] = [];
    try {
      for (const [index, id] of ids.entries()) {
        const response = await request.post(`/api/wiki/pages/${id}`, { data: {
          markdown: `---\ngalaxy_group: ${group}\ngalaxy_label: Synthetic Unicode constellation\n${index === 0 ? "galaxy_anchor: true\n" : ""}---\n# ${titles[index]}\n\n[[${ids[1 - index]}]]\n`,
          base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true); owned.push(id);
      }
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/galaxy?page=${ids[0]}`);
      const stars = page.locator(".galaxy-star");
      await expect(stars).toHaveCount(2);
      const positions = await stars.evaluateAll(elements => elements.map(el => el.getAttribute("transform")));
      for (const [index, id] of ids.entries()) {
        const star = page.locator(`.galaxy-star[data-node="${id}"]`);
        await star.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(titles[index]);
        await expect(star).toHaveAttribute("aria-label", new RegExp(titles[index]));
        await expect(star.locator("title")).toHaveText(titles[index]);
        const label = star.locator("text");
        await expect(label).toHaveAttribute("data-label", [...titles[index]].slice(0, 25).join("") + "…");
        await expect(label).toBeVisible();
        const geometry = await label.evaluate(element => {
          const label = element as SVGGraphicsElement;
          const box = label.getBoundingClientRect(), bounds = label.ownerSVGElement!.getBoundingClientRect();
          return { text: label.textContent || "", inside: box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom };
        });
        expect(geometry.text).not.toMatch(/[\uD800-\uDFFF]/u);
        expect(geometry.inside).toBe(true);
      }
      expect(await stars.evaluateAll(elements => elements.map(el => el.getAttribute("transform")))).toEqual(positions);
      const graph = await (await request.get("/api/wiki/graph")).json();
      expect(graph.edges.filter((edge: any) => ids.includes(edge.source))).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`unicode-star-label-${width}.png`), fullPage: true });
      await page.locator(".galaxy-selected-heading .galaxy-article").click();
      await expect(page.locator("article > h1")).toHaveText(titles[1]);
      await page.goBack();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(titles[1]);
    } finally {
      for (const id of owned.reverse()) {
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        expect((await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } })).ok()).toBe(true);
      }
    }
  });
}


for (const width of [390, 1440]) {
  test(`galaxy display caps preserve grapheme boundaries (${width})`, async ({ page, request }, info) => {
    const group = `grapheme-label-${randomUUID()}`;
    const ids = [0, 1, 2].map(index => `${group}-${index}`);
    // Exactly 24 ASCII graphemes before each multi-code-point 25th grapheme.
    // A code-point slice drops the accent, modifier/ZWJ tail, or second flag half.
    const prefix = "Synthetic " + "i".repeat(14);
    const clusters = ["e\u0301", "👩🏽‍🚀", "🇺🇳"];
    const titles = clusters.map(cluster => `${prefix}${cluster} beyond the synthetic horizon`);
    // Stay within the API's 80-code-point galaxy_label limit, with wide ASCII
    // between mixed graphemes so compact emoji fonts still overflow on mobile.
    const haloTitle = "Synthetic " + clusters.join("").repeat(2) + "W".repeat(38) + clusters.join("").repeat(2);
    expect([...haloTitle]).toHaveLength(80);
    const owned: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [index, id] of ids.entries()) {
        const response = await request.post(`/api/wiki/pages/${id}`, { data: {
          markdown: `---\ngalaxy_group: ${group}\ngalaxy_label: ${haloTitle}\n${index === 0 ? "galaxy_anchor: true\n" : ""}---\n# ${titles[index]}\n\n[[${ids[(index + 1) % ids.length]}]]\n`,
          base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true); owned.push(id);
      }
      const fixtureGraph = async () => {
        const response = await request.get("/api/wiki/graph");
        expect(response.ok()).toBe(true);
        const graph = await response.json();
        return {
          nodes: graph.nodes.filter((node: { id: string }) => ids.includes(node.id)),
          edges: graph.edges.filter((edge: { source: string; target: string }) => ids.includes(edge.source) || ids.includes(edge.target)),
        };
      };
      const originalGraph = await fixtureGraph();
      expect(originalGraph.nodes).toHaveLength(3);
      expect(originalGraph.edges).toHaveLength(3);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/galaxy?page=${ids[0]}`);
      const stars = page.locator(".galaxy-star");
      await expect(stars).toHaveCount(3);
      const positions = () => stars.evaluateAll(elements => elements.map(element => element.getAttribute("transform")));
      const originalPositions = await positions();
      const halo = page.locator(".galaxy-neighborhood text:not(.galaxy-count)");
      await expect(halo).toHaveAttribute("data-label", haloTitle);
      await expect(halo).toBeVisible();
      if (width === 390) await expect(halo).not.toHaveText(haloTitle);
      // Pixel fitting retains both ends of the label. Check the actual painted
      // text against independent browser grapheme boundaries, including its suffix.
      const haloFit = await halo.evaluate(element => {
        const label = element as SVGTextElement;
        const source = label.dataset.label!;
        const Segmenter = (Intl as any).Segmenter;
        const clusters = Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(source), (part: any) => part.segment as string);
        const text = element.textContent || "";
        const [left, right, extra] = text.split("…");
        // Measure a hidden full-text clone with the same SVG/font/transform.
        // Do not mutate the fitted label or depend on a specific emoji font.
        const full = label.cloneNode(true) as SVGTextElement;
        full.textContent = source;
        full.style.visibility = "hidden";
        label.parentElement!.append(full);
        const scale = Math.hypot(label.getScreenCTM()!.a, label.getScreenCTM()!.b);
        const available = label.ownerSVGElement!.parentElement!.clientWidth - 24;
        let sourceWidth: number;
        try { sourceWidth = full.getComputedTextLength() * scale; }
        finally { full.remove(); }
        return { sourceWidth, available, paintedWidth: label.getComputedTextLength() * scale,
          shortened: text !== source, valid: text === source || (extra === undefined && right !== undefined && left.length > 0 && right.length > 0 &&
          clusters.some((_, count) => clusters.slice(0, count).join("") === left) &&
          clusters.some((_, count) => clusters.slice(clusters.length - count).join("") === right)) };
      });
      if (width === 390) {
        expect(haloFit.sourceWidth, "fixture must exceed the actual halo pixel budget").toBeGreaterThan(haloFit.available);
        expect(haloFit.shortened).toBe(true);
      }
      expect(haloFit.paintedWidth).toBeLessThanOrEqual(haloFit.available + .5);
      expect(haloFit.valid, "painted halo prefix and suffix must end at complete graphemes").toBe(true);
      for (const [index, id] of ids.entries()) {
        const star = page.locator(`.galaxy-star[data-node="${id}"]`);
        await star.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(titles[index]);
        await expect(star).toHaveAttribute("aria-label", new RegExp(titles[index]));
        await expect(star.locator("title")).toHaveText(titles[index]);
        const label = star.locator("text");
        const expected = prefix + clusters[index] + "…";
        await expect(label).toHaveAttribute("data-label", expected);
        await expect(label).toBeVisible();
        // This deliberately compact prefix fits at both widths, so checking
        // painted text catches broken graphemes independently of data-label.
        await expect(label).toHaveText(expected);
        const inside = await label.evaluate(element => {
          const label = element as SVGGraphicsElement;
          const box = label.getBoundingClientRect(), bounds = label.ownerSVGElement!.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
        expect(inside).toBe(true);
      }
      expect(await positions()).toEqual(originalPositions);
      expect(await fixtureGraph()).toEqual(originalGraph);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`grapheme-star-label-${width}.png`), fullPage: true });
      await page.locator(".galaxy-selected-heading .galaxy-article").click();
      await expect(page.locator("article > h1")).toHaveText(titles[2]);
      await page.goBack();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(titles[2]);
      expect(errors).toEqual([]);
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`);
        expect(current.ok()).toBe(true);
        expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } })).ok()).toBe(true);
      }
    }
  });
}

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

for (const width of [390, 1440]) {
  test(`selected constellation labels stay separate from the core (${width})`, async ({ page, request }, info) => {
    const group = `labels-${randomUUID()}`;
    const ids = Array.from({ length: 33 }, (_, index) => `${group}-${String(index).padStart(2, "0")}`);
    const title = (index: number) => index === 0 ? "Synthetic constellation core" : `Synthetic neighboring star ${index}`;
    const owned: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [index, id] of ids.entries()) {
        const created = await request.post(`/api/wiki/pages/${id}`, {
          data: {
            markdown: `---\ngalaxy_group: ${group}\ngalaxy_label: Synthetic label constellation\n${index === 0 ? "galaxy_anchor: true\n" : ""}---\n# ${title(index)}\n\n[[${ids[0]}]] [[${ids[(index + 1) % ids.length]}]]\n`,
            base_revision: null, request_id: randomUUID(),
          },
        });
        expect(created.ok()).toBeTruthy();
        owned.push(id);
      }
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/galaxy?page=${ids[0]}`);
      const stars = page.locator(".galaxy-star");
      await expect(stars).toHaveCount(33);
      const positions = () => stars.evaluateAll(elements => Object.fromEntries(elements.map(element =>
        [element.getAttribute("data-node"), element.getAttribute("transform")])));
      const originalPositions = await positions();
      // Select a real star on the core's horizontal diameter. Containment alone
      // misses two screen-sized labels painting over one another in this case.
      const neighbor = await stars.evaluateAll(elements => {
        const point = (element: Element) => new DOMPoint(0, 0).matrixTransform((element as SVGGraphicsElement).getScreenCTM()!);
        const core = point(elements.find(element => element.classList.contains("is-core"))!);
        return elements.filter(element => !element.classList.contains("is-core")).map(element => {
          const p = point(element);
          return { id: element.getAttribute("data-node")!, vertical: Math.abs(p.y - core.y), horizontal: Math.abs(p.x - core.x) };
        }).sort((a, b) => a.vertical - b.vertical || a.horizontal - b.horizontal)[0].id;
      });
      const selected = page.locator(`.galaxy-star[data-node="${neighbor}"]`);
      await selected.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(ids.indexOf(neighbor)));
      await page.locator(".galaxy-map").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`neighbor-labels-${width}.png`), fullPage: true });
      const separate = () => page.locator(".galaxy-star text").evaluateAll(elements => {
        const boxes = elements.filter(element => getComputedStyle(element).visibility !== "hidden")
          .map(element => element.getBoundingClientRect());
        return boxes.every((box, i) => boxes.slice(i + 1).every(other =>
          box.right + 3 <= other.left || box.left >= other.right + 3 ||
          box.bottom + 3 <= other.top || box.top >= other.bottom + 3));
      });
      const selectedLabel = page.locator(".galaxy-star.is-selected text");
      for (const nextWidth of [width, 320, 800, 1440, width]) {
        await page.setViewportSize({ width: nextWidth, height: 844 });
        await expect(selectedLabel).toBeVisible();
        await expect.poll(separate, { message: "visible core and selected labels must not overlap" }).toBe(true);
        expect(await positions(), "label fitting must not move real stars").toEqual(originalPositions);
      }
      // Keyboard zoom can pan the focused star back into view. Its own label
      // keeps priority without changing the star's full accessible identity.
      await selected.focus();
      for (let step = 0; step < 6; step++) await page.keyboard.press("+");
      await expect(selectedLabel).toBeVisible();
      await expect.poll(separate).toBe(true);
      // At a wide viewport the zoomed names have room without edge clamping.
      // Restore the existing core label without changing selection or SVG.
      await page.setViewportSize({ width: 1440, height: 844 });
      await expect(page.locator(".galaxy-star.is-core text")).toBeVisible();
      await expect.poll(separate).toBe(true);
      await expect(selected).toHaveAttribute("aria-label", new RegExp(title(ids.indexOf(neighbor))));
      await expect(selected.locator("title")).toHaveText(title(ids.indexOf(neighbor)));
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(selectedLabel).toBeVisible();
      await expect.poll(separate).toBe(true);
      await page.screenshot({ path: info.outputPath(`neighbor-labels-reset-${width}.png`), fullPage: true });
      // A vertically separated selection must restore the core's label; hiding
      // it once is not permission to keep it absent after the next layout.
      const top = await stars.evaluateAll(elements => elements.filter(element => !element.classList.contains("is-core"))
        .map(element => ({ id: element.getAttribute("data-node")!, y: new DOMPoint(0, 0).matrixTransform((element as SVGGraphicsElement).getScreenCTM()!).y }))
        .sort((a, b) => a.y - b.y)[0].id);
      await page.locator(`.galaxy-star[data-node="${top}"]`).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".galaxy-star.is-core text")).toBeVisible();
      await expect(page.locator(".galaxy-star.is-selected text")).toBeVisible();
      await expect.poll(separate).toBe(true);
      await page.locator(".galaxy-selected-heading .galaxy-article").click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${top}$`));
      await expect(page.locator("article > h1")).toHaveText(title(ids.indexOf(top)));
      await page.goBack();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(ids.indexOf(top)));
      await expect.poll(separate).toBe(true);
      await page.locator(`.galaxy-star[data-node="${ids[0]}"]`).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".galaxy-star text")).toHaveCount(1);
      await expect(page.locator(".galaxy-star.is-core.is-selected text")).toBeVisible();
      expect(await positions()).toEqual(originalPositions);
      expect(errors).toEqual([]);
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`);
        expect(current.ok()).toBeTruthy();
        const removed = await request.delete(`/api/wiki/pages/${id}`, {
          data: { base_revision: (await current.json()).revision, request_id: randomUUID() },
        });
        expect(removed.ok()).toBeTruthy();
      }
    }
  });
}

