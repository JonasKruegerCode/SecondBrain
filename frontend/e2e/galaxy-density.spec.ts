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
      const stars = page.locator(ids.map(id => `.galaxy-star[data-node="${id}"]`).join(", "));
      await expect(stars).toHaveCount(2);
      const positions = await stars.evaluateAll(elements => elements.map(el => [(el as HTMLElement).style.left, (el as HTMLElement).style.top]));
      for (const [index, id] of ids.entries()) {
        const star = page.locator(`.galaxy-star[data-node="${id}"]`);
        await star.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(titles[index]);
        await expect(star).toHaveAttribute("aria-label", new RegExp(titles[index]));
        await expect(star).toHaveAttribute("title", titles[index]);
        const painted = [...titles[index]].slice(0, 25).join("") + "…";
        await expect(star).toHaveAttribute("data-label", painted);
        expect(painted).not.toMatch(/[\uD800-\uDFFF]/u);
        const inside = await star.evaluate(element => {
          const box = element.getBoundingClientRect();
          const bounds = element.closest(".galaxy-stage")!.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
        expect(inside).toBe(true);
      }
      expect(await stars.evaluateAll(elements => elements.map(el => [(el as HTMLElement).style.left, (el as HTMLElement).style.top]))).toEqual(positions);
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
      const stars = page.locator(ids.map(id => `.galaxy-star[data-node="${id}"]`).join(", "));
      await expect(stars).toHaveCount(3);
      const positions = () => stars.evaluateAll(elements => elements.map(element => [(element as HTMLElement).style.left, (element as HTMLElement).style.top]));
      const originalPositions = await positions();
      await expect(page.locator(".galaxy-breadcrumb")).toContainText(haloTitle);
      for (const [index, id] of ids.entries()) {
        const star = page.locator(`.galaxy-star[data-node="${id}"]`);
        await star.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(titles[index]);
        await expect(star).toHaveAttribute("aria-label", new RegExp(titles[index]));
        await expect(star).toHaveAttribute("title", titles[index]);
        const expected = prefix + clusters[index] + "…";
        await expect(star).toHaveAttribute("data-label", expected);
        expect(expected).not.toMatch(/[\uD800-\uDFFF]/u);
        const inside = await star.evaluate(element => {
          const box = element.getBoundingClientRect();
          const bounds = element.closest(".galaxy-stage")!.getBoundingClientRect();
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
    await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Find a page in this snapshot" })).toBeVisible();
    await page.locator(".galaxy-cluster").filter({ hasText: label }).click();
    await expect(page.locator(".galaxy-sidebar-content .galaxy-page")).toHaveCount(51);
    await page.screenshot({ path: info.outputPath(`dense-before-selection-${width}.png`), fullPage: true });

    const notice = page.locator(".galaxy-density-note");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/direct links/i);
    await expect(notice).toContainText("within this constellation");
    await expect(notice).toContainText(/core|selected/i);
    expect(Number(await page.locator(".galaxy-stage").getAttribute("data-internal-links"))).toBeGreaterThan(2000);
    await expect(page.locator(`.galaxy-star[data-node^="${prefix}-"]`)).toHaveCount(51);

    const other = page.locator(`.galaxy-star[data-node="${ids[17]}"]`);
    await other.focus();
    await expect(other).toBeFocused();
    const zoomOf = () => page.locator(".galaxy-stage").getAttribute("data-zoom").then(value => Number(value));
    const focusedVisible = () => other.evaluate(element => {
      const box = element.getBoundingClientRect();
      const bounds = element.closest(".galaxy-stage")!.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      return x >= bounds.left + 8 && x <= bounds.right - 8 && y >= bounds.top + 8 && y <= bounds.bottom - 8;
    });
    const fitZoom = await zoomOf();
    expect(fitZoom).toBeCloseTo(1, 2);
    await page.keyboard.press("+");
    expect(await zoomOf()).toBeGreaterThan(fitZoom);
    await expect(other).toBeFocused();
    expect(await focusedVisible(), "zoom must retain a visible focused star").toBe(true);
    for (let step = 0; step < 20; step++) await page.keyboard.press("+");
    expect(await zoomOf()).toBeCloseTo(4, 2);
    expect(await focusedVisible(), "maximum zoom must not hide focus or silently reset").toBe(true);
    await page.keyboard.press("=");
    expect(await zoomOf()).toBeCloseTo(4, 2);
    for (let step = 0; step < 20; step++) await page.keyboard.press("-");
    expect(await zoomOf()).toBeCloseTo(0.75, 2);
    expect(await focusedVisible()).toBe(true);
    await page.keyboard.press("=");
    await expect.poll(zoomOf).toBeCloseTo(1, 2);
    // Literal search text must not invoke map zoom.
    const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
    await search.fill("Synthetic");
    await search.press("End");
    await page.keyboard.press("+");
    await page.keyboard.press("-");
    await expect(search).toHaveValue("Synthetic+-");
    expect(await zoomOf()).toBeCloseTo(fitZoom, 2);
    await search.fill("");
    await other.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(17));
    await expect(page.locator(".galaxy-evidence > li")).toHaveCount(102);
    await expect(page.locator(".galaxy-evidence")).toContainText(outsideTitle);
    const crossing = page.locator(".galaxy-evidence li").filter({ hasText: outsideTitle });
    await expect(crossing).toHaveCount(2);
    expect((await crossing.allInnerTexts()).every(text => text.includes("across neighborhoods"))).toBe(true);
    const edgeId = await page.locator(`.galaxy-star[data-node^="${prefix}-"]`).evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect();
        return { id: element.getAttribute("data-node")!, x: box.left + box.width / 2 };
      }).sort((a, b) => b.x - a.x)[0].id);
    await page.locator(`.galaxy-star[data-node="${edgeId}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(ids.indexOf(edgeId)));
    const selectedInside = () => page.locator(".galaxy-star.is-selected").evaluate(element => {
      const box = element.getBoundingClientRect();
      const bounds = element.closest(".galaxy-stage")!.getBoundingClientRect();
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
    });
    for (const labelWidth of [width, 320, 1440, width]) {
      await page.setViewportSize({ width: labelWidth, height: 844 });
      await expect.poll(selectedInside).toBe(true);
      await expect(page.locator(".galaxy-star.is-selected")).toHaveAttribute("data-label", /.+/);
    }
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(selectedInside).toBe(true);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(selectedInside).toBe(true);
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
    await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(17));
    await expect(notice).toBeVisible();
    await page.getByRole("button", { name: "All constellations" }).click();
    await page.locator(".galaxy-cluster").filter({ hasText: outsideTitle }).click();
    await expect(notice).toBeHidden();
    await expect(page.locator(".galaxy-sidebar-content .galaxy-page")).toHaveCount(1);
    await expect(page.locator(`.galaxy-star[data-node="${outside}"]`)).toBeVisible();
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
      const stars = page.locator(ids.map(id => `.galaxy-star[data-node="${id}"]`).join(", "));
      await expect(stars).toHaveCount(33);
      const positions = () => stars.evaluateAll(elements => Object.fromEntries(elements.map(element =>
        [element.getAttribute("data-node"), `${element.getAttribute("data-x")},${element.getAttribute("data-y")}`])));
      const originalPositions = await positions();
      // Select a real star on the core's horizontal diameter. Containment alone
      // misses two screen-sized labels painting over one another in this case.
      const neighbor = await stars.evaluateAll(elements => {
        const point = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        };
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
      const separate = () => page.locator(".galaxy-painted-label").evaluateAll(elements => {
        const boxes = elements.map(element => element.getBoundingClientRect());
        return boxes.every((box, i) => boxes.slice(i + 1).every(other =>
          box.right + 3 <= other.left || box.left >= other.right + 3 ||
          box.bottom + 3 <= other.top || box.top >= other.bottom + 3));
      });
      const selectedLabel = page.locator(`.galaxy-painted-label[data-node="${neighbor}"]`);
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
      await expect(page.locator(`.galaxy-painted-label[data-node="${ids[0]}"]`)).toBeVisible();
      await expect.poll(separate).toBe(true);
      await expect(selected).toHaveAttribute("aria-label", new RegExp(title(ids.indexOf(neighbor))));
      await expect(selected).toHaveAttribute("title", title(ids.indexOf(neighbor)));
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(selectedLabel).toBeVisible();
      await expect.poll(separate).toBe(true);
      await page.screenshot({ path: info.outputPath(`neighbor-labels-reset-${width}.png`), fullPage: true });
      // A vertically separated selection must restore the core's label; hiding
      // it once is not permission to keep it absent after the next layout.
      const top = await stars.evaluateAll(elements => elements.filter(element => !element.classList.contains("is-core"))
        .map(element => ({ id: element.getAttribute("data-node")!, y: element.getBoundingClientRect().top }))
        .sort((a, b) => a.y - b.y)[0].id);
      await page.locator(`.galaxy-star[data-node="${top}"]`).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(`.galaxy-painted-label[data-node="${ids[0]}"]`)).toBeVisible();
      await expect(page.locator(`.galaxy-painted-label[data-node="${top}"]`)).toBeVisible();
      await expect.poll(separate).toBe(true);
      await page.locator(".galaxy-selected-heading .galaxy-article").click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${top}$`));
      await expect(page.locator("article > h1")).toHaveText(title(ids.indexOf(top)));
      await page.goBack();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title(ids.indexOf(top)));
      await expect.poll(separate).toBe(true);
      await page.locator(`.galaxy-star[data-node="${ids[0]}"]`).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(`.galaxy-painted-label[data-node="${ids[0]}"]`)).toBeVisible();
      await expect(page.locator(".galaxy-star.is-core.is-selected")).toBeVisible();
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

