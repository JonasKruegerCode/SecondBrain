import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  test(`reference definitions stay out of graph evidence at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const source = `reference-source-${randomUUID()}`;
    const shown = `reference-shown-${randomUUID()}`;
    const hidden = `reference-hidden-${randomUUID()}`;
    const markdown = ["# Reference boundary source", "",
      `[ref]: https://example.test/[[${hidden}]]`,
      `[next]:`, `    https://example.test/[[${hidden}]]`,
      `    "Metadata [[${hidden}]]`, `# Still metadata [[${hidden}]]`, '"', "",
      `[outer]: <https://example.test/[[${hidden}]]>`, "",
      `[external source][ref]`, "",
      `[[${shown}|Visible companion]]`,
      `[inline]: [[${shown}|Paragraph companion]]`, "",
      `> [quoted]: [[${hidden}]]`, ">", `> [[${shown}|Quoted companion]]`, "",
      `- [listed]: [[${hidden}]]`, "", `  [[${shown}|Listed companion]]`, "",
    ].join("\r\n");
    const endpoint = (id: string) => `/api/wiki/pages/${id}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, body] of [[shown, "# Reference companion"], [hidden, "# Metadata companion"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: { markdown: body, base_revision: null, request_id: randomUUID() } });
        expect(response.ok()).toBe(true); created.push(id);
      }
      const original = await (await request.get(endpoint(source))).json();
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Reference boundary source");
      await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(4);
      await expect(page.locator(`.prose a[data-wiki-target='${shown}']`)).toHaveCount(4);
      await expect(page.locator(`.prose a[href*='example.test']`)).toHaveCount(1);
      await expect(page.locator(".prose")).not.toContainText("Still metadata");
      const graph = await (await request.get("/api/wiki/graph")).json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === source)
        .map((edge: { target: string }) => edge.target)).toEqual([shown]);
      expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(0);
      expect(original.excerpt).not.toContain(hidden);
      expect(original.excerpt).not.toContain("Still metadata");
      await page.screenshot({ path: info.outputPath(`reference-definitions-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown.replace(/\r\n/g, "\n"));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      const current = await (await request.get(endpoint(source))).json();
      expect(current.markdown).toBe(markdown); expect(current.revision).toBe(original.revision);
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${shown}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${hidden}']`)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`reference-definitions-galaxy-${width}.png`), fullPage: true });
      const saved = await request.post(endpoint(source), { data: {
        markdown: markdown + `\r\n[[${hidden}]]`, base_revision: original.revision, request_id: randomUUID(),
      } });
      expect(saved.ok()).toBe(true);
      expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(1);
      expect((await (await request.get(`${endpoint(source)}/history`)).json()).history).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id)); expect(current.ok()).toBe(true);
        const response = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`inline destinations stay out of graph evidence at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const source = `inline-source-${randomUUID()}`;
    const shown = `inline-shown-${randomUUID()}`;
    const hidden = `inline-hidden-${randomUUID()}`;
    const markdown = ["# Inline destination source", "",
      `[external source](https://example.test/[[${hidden}]] "Metadata [[${hidden}]]")`, "",
      `[balanced source](https://example.test/path(a)/[[${hidden}]])`, "",
      `[angle source](<https://example.test/[[${hidden}]]>)`, "",
      `![Map illustration](/app-icon-192.png?target=[[${hidden}]] "Metadata [[${hidden}]]")`, "",
      `![[${hidden}]](/app-icon-192.png "Metadata [[${hidden}]]")`, "",
      `[[${shown}|Visible companion]]`, "",
      `> [quoted source](relative/[[${hidden}]] "Metadata [[${hidden}]]")`, ">", `> [[${shown}|Quoted companion]]`, "",
      `- [listed source](relative/[[${hidden}]]) [[${shown}|Listed companion]]`, "",
      `Source | Companion`, `--- | ---`,
      `[table source](relative/[[${hidden}]]) | [[${shown}]]`, "",
    ].join("\r\n");
    const endpoint = (id: string) => `/api/wiki/pages/${id}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, body] of [[shown, "# Reference companion"], [hidden, "# Metadata companion"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: { markdown: body, base_revision: null, request_id: randomUUID() } });
        expect(response.ok()).toBe(true); created.push(id);
      }
      const original = await (await request.get(endpoint(source))).json();
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Inline destination source");
      await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(4);
      await expect(page.locator(`.prose a[data-wiki-target='${shown}']`)).toHaveCount(4);
      await expect(page.locator(`.prose a[href*='example.test']`)).toHaveCount(3);
      await expect(page.locator(".prose")).not.toContainText("Metadata");
      const graph = await (await request.get("/api/wiki/graph")).json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === source)
        .map((edge: { target: string }) => edge.target)).toEqual([shown]);
      expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(0);
      expect(original.excerpt).toContain(`[${hidden}]`);
      expect(original.excerpt).not.toContain("https://");
      expect(original.excerpt).not.toContain("Metadata");
      await page.screenshot({ path: info.outputPath(`inline-destinations-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown.replace(/\r\n/g, "\n"));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      const current = await (await request.get(endpoint(source))).json();
      expect(current.markdown).toBe(markdown); expect(current.revision).toBe(original.revision);
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${shown}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${hidden}']`)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`inline-destinations-galaxy-${width}.png`), fullPage: true });
      const saved = await request.post(endpoint(source), { data: {
        markdown: markdown + `\r\n[[${hidden}]]`, base_revision: original.revision, request_id: randomUUID(),
      } });
      expect(saved.ok()).toBe(true);
      expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(1);
      expect((await (await request.get(`${endpoint(source)}/history`)).json()).history).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id)); expect(current.ok()).toBe(true);
        const response = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`URL autolinks stay out of graph evidence at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const source = `url-source-${randomUUID()}`;
    const shown = `url-shown-${randomUUID()}`;
    const hidden = `url-hidden-${randomUUID()}`;
    const markdown = ["# URL boundary source", "",
      `https://example.test/[[${hidden}]]`, "",
      `<https://example.test/[[${hidden}]]>`, "",
      `www.example.test/[[${hidden}]]`, "",
      `**HTTPS://example.test/[[${hidden}]]**`, "",
      `__HTTPS://example.test/[[${hidden}]]__`, "",
      `prefix **HTTPS://example.test/[[${hidden}]]**`, "",
      `prefix __HTTPS://example.test/[[${hidden}]]__ suffix`, "",
      `**HTTPS://example.test/[[${hidden}]]** suffix`, "",
      `mehr Wörter\t**HTTPS://example.test/[[${hidden}]]** nächste Wörter`, "",
      ...["*", "_", "***", "___"].flatMap(delimiter => [
        `${delimiter}HTTPS://example.test/[[${hidden}]]${delimiter}`, "",
        `prefix ${delimiter}HTTPS://example.test/[[${hidden}]]${delimiter} suffix`, "",
      ]),
      `prefix HTTPS://example.test/[[${shown}]]`, "",
      `[[${shown}|Visible companion]]`, "",
      `> https://example.test/[[${hidden}]]`, ">", `> [[${shown}|Quoted companion]]`, "",
      `- https://example.test/[[${hidden}]] [[${shown}|Listed companion]]`, "",
      `Source | Companion`, `--- | ---`,
      `https://example.test/[[${hidden}]] | [[${shown}]]`, "",
    ].join("\r\n");
    const endpoint = (id: string) => `/api/wiki/pages/${id}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, body] of [[shown, "# Reference companion"], [hidden, "# Metadata companion"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: { markdown: body, base_revision: null, request_id: randomUUID() } });
        expect(response.ok()).toBe(true); created.push(id);
      }
      const original = await (await request.get(endpoint(source))).json();
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("URL boundary source");
      await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(5);
      await expect(page.locator(`.prose a[data-wiki-target='${shown}']`)).toHaveCount(5);
      await expect(page.locator(`.prose a[href*='example.test']`)).toHaveCount(20);
      const graph = await (await request.get("/api/wiki/graph")).json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === source)
        .map((edge: { target: string }) => edge.target)).toEqual([shown]);
      expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(0);
      expect(original.excerpt).toContain("https://example.test/");
      await page.screenshot({ path: info.outputPath(`url-autolinks-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown.replace(/\r\n/g, "\n"));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      const current = await (await request.get(endpoint(source))).json();
      expect(current.markdown).toBe(markdown); expect(current.revision).toBe(original.revision);
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${shown}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${hidden}']`)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`url-autolinks-galaxy-${width}.png`), fullPage: true });
      const saved = await request.post(endpoint(source), { data: {
        markdown: markdown + `\r\n[[${hidden}]]`, base_revision: original.revision, request_id: randomUUID(),
      } });
      expect(saved.ok()).toBe(true);
      expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(1);
      expect((await (await request.get(`${endpoint(source)}/history`)).json()).history).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id)); expect(current.ok()).toBe(true);
        const response = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const method of ["keyboard", "wheel", "touch-emulation"] as const) {
  test(`narrow demo table reveals its linked third column with ${method}`, async ({ browser, browserName }, info) => {
    test.skip(method === "touch-emulation" && browserName !== "chromium", "CDP touch input is Chromium emulation, not a physical device");
    const context = await browser.newContext({
      viewport: { width: 390, height: 1000 },
      hasTouch: method === "touch-emulation", isMobile: method === "touch-emulation",
      serviceWorkers: browserName === "webkit" ? "block" : "allow",
      baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const response = await context.request.get("/api/wiki/pages/lantern-festival");
      expect(response.ok()).toBe(true);
      const original = await response.json();
      await page.goto("/wiki/lantern-festival");
      await expect(page.locator("article > h1")).toHaveText(original.title);
      const region = page.getByRole("region", { name: "Table; scroll horizontally to read all columns" });
      await expect(region.locator("a[data-wiki-target]")).toHaveCount(6);
      await expect(region.locator("a[href^='/resolve']")).toHaveCount(0);
      await page.getByRole("link", { name: "Program sketch", exact: true }).click();
      const before = await region.evaluate(el => ({ left: el.scrollLeft, width: el.clientWidth, total: el.scrollWidth }));
      expect(before.left).toBe(0);
      expect(before.total).toBeGreaterThan(before.width);
      if (method === "keyboard") {
        await page.keyboard.press("Tab");
        await expect(region).toBeFocused();
        for (let step = 0; step < 10; step++) await page.keyboard.press("ArrowRight");
      } else if (method === "wheel") {
        await region.hover();
        await page.mouse.wheel(1000, 0);
      } else {
        const box = await region.boundingBox();
        expect(box).not.toBeNull();
        const session = await context.newCDPSession(page);
        try {
          const y = box!.y + 60, start = box!.x + box!.width - 20, end = box!.x + 20;
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start, y }] });
          for (let step = 1; step <= 8; step++) {
            await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start + (end - start) * step / 8, y }] });
          }
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally { await session.detach(); }
      }
      await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      const link = region.getByRole("link", { name: "navigation stories", exact: true });
      // Visibility alone does not establish that a clipped table link is readable.
      await expect.poll(async () => {
        const [outer, inner] = await Promise.all([region.boundingBox(), link.boundingBox()]);
        return !!outer && !!inner && inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1
          && inner.y >= 0 && inner.y + inner.height <= 1000;
      }).toBe(true);
      const after = await region.evaluate(el => ({ left: el.scrollLeft, width: el.clientWidth, total: el.scrollWidth }));
      expect(await page.evaluate(() => scrollX)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`table-scroll-${method}.png`) });
      await link.click();
      await expect(page).toHaveURL(/\/wiki\/navigation-history$/);
      await expect(page.locator("article > h1")).toHaveText("Navigation stories of Lantern Bay");
      await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(6);
      await expect(page.locator(".prose a[data-wiki-target='lantern-festival']")).toHaveAttribute("href", "/wiki/lantern-festival");
      const savedResponse = await context.request.get("/api/wiki/pages/lantern-festival");
      expect(savedResponse.ok()).toBe(true);
      const saved = await savedResponse.json();
      expect(saved.markdown).toBe(original.markdown);
      expect(saved.revision).toBe(original.revision);
      expect(errors).toEqual([]);
      console.info("[table-scroll] " + JSON.stringify({ engine: browserName, service_workers: browserName === "webkit" ? "block" : "allow", method, before, after, physical_device: false, source_unchanged: true }));
    } finally { await context.close(); }
  });
}

for (const width of [390, 1440]) {
  test(`GFM table columns agree with graph and article links at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const source = `table-source-${randomUUID()}`;
    const shown = `table-shown-${randomUUID()}`;
    const hidden = `table-hidden-${randomUUID()}`;
    const markdown = ["# Synthetic table columns", "",
      "## Two visible columns", "", "a \\| b | c", "--- | ---",
      `x | [[${shown}\\|Visible companion]] | [[${hidden}]]`, "",
      "## Separate cell text", "", "a | b", "--- | ---",
      `[[${hidden} | Broken label]]`, "",
      "## Rejected delimiter width", "", "a | b", "--- | --- | ---",
      "`x | [[" + hidden + "]]`", "",
      "## Setext is not a table", "", "a | b", "-",
      "`x | [[" + hidden + "]]`", "",
    ].join("\n").replace(/\n/g, "\r\n");
    const endpoint = (id: string) => `/api/wiki/pages/${id}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    try {
      for (const [id, body] of [[shown, "# Visible table companion"], [hidden, "# Hidden table companion"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true);
        created.push(id);
      }
      const original = await (await request.get(endpoint(source))).json();
      const check = async (promoted = false) => {
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((e: { source: string }) => e.source === source)
          .map((e: { target: string }) => e.target).sort()).toEqual((promoted ? [shown, hidden] : [shown]).sort());
        expect(graph.missing_targets.filter((e: { source: string }) => e.source === source)).toEqual([]);
        expect((await (await request.get(`${endpoint(hidden)}/backlinks`)).json()).total).toBe(Number(promoted));
      };
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic table columns");
      await expect(page.locator(".prose table")).toHaveCount(2);
      await expect(page.locator(".prose tbody td")).toHaveCount(4);
      await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(1);
      await expect(page.locator(".prose a[data-wiki-target]")).toHaveText("Visible companion");
      await expect(page.locator(`.prose a[data-wiki-target='${shown}']`)).toHaveAttribute("href", `/wiki/${shown}`);
      await check();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown.replace(/\r\n/g, "\n"));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await expect(page.locator(`.prose a[data-wiki-target='${shown}']`)).toHaveAttribute("href", `/wiki/${shown}`);
      const after = await (await request.get(endpoint(source))).json();
      expect(after.markdown).toBe(markdown);
      expect(after.revision).toBe(original.revision);
      await page.screenshot({ path: info.outputPath(`table-columns-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${shown}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${hidden}']`)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`table-columns-galaxy-${width}.png`), fullPage: true });
      const saved = await request.post(endpoint(source), { data: {
        markdown: markdown + `\r\n[[${hidden}]]\r\n`, base_revision: original.revision, request_id: randomUUID(),
      } });
      expect(saved.ok()).toBe(true);
      await check(true);
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id));
        expect(current.ok()).toBe(true);
        const deleted = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBe(true);
      }
    }
  });
}

for (const width of [1440, 390]) {
  test(`Markdown task state and ordered numbering survive reading at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `markdown-lists-${randomUUID()}`;
    const endpoint = `/api/wiki/pages/${encodeURIComponent(id)}`;
    const title = `Synthetic Markdown lists ${"UnbrokenIdentifier".repeat(10)}`;
    const markdown = [
      `# ${title}`, "",
      "- [x] Synthetic completed task", "- [ ] Synthetic pending task", "",
      "## Continued steps", "", "4. Synthetic fourth step", "5. Synthetic fifth step", "",
      "## Zero-based steps", "", "0. Synthetic zero step", "1. Synthetic next step", "",
      "## Unsafe raw controls", "",
      '<form action="/synthetic-unsafe"><input type="text" value="unsafe"><button>Unsafe submit</button></form>',
      '<input type="checkbox" checked onclick="window.__syntheticUnsafe = true" aria-label="Unsafe active checkbox">',
      '<input type="checkbox" disabled checked onclick="window.__syntheticUnsafe = true" data-unsafe="retained">', "",
    ].join("\n");
    let created = false;
    try {
      const response = await request.post(endpoint, { data: {
        markdown, base_revision: null, request_id: randomUUID(),
      } });
      expect(response.ok()).toBeTruthy();
      created = true;
      await page.goto(`/wiki/${id}`);
      const assertReading = async () => {
        const prose = page.locator(".prose");
        await expect(prose).toBeVisible();
        await expect(page.locator("article > h1")).toHaveText(title);
        const completed = prose.locator("li").filter({ hasText: "Synthetic completed task" }).getByRole("checkbox");
        const pending = prose.locator("li").filter({ hasText: "Synthetic pending task" }).getByRole("checkbox");
        await expect(completed).toBeChecked();
        await expect(completed).toBeDisabled();
        await expect(pending).not.toBeChecked();
        await expect(pending).toBeDisabled();
        for (const [label, start] of [["Synthetic fourth step", 4], ["Synthetic zero step", 0]] as const) {
          const list = prose.locator("ol").filter({ hasText: label });
          await expect(list).toHaveCount(1);
          await expect(list).toHaveJSProperty("start", start);
          await expect(list.locator("li")).toHaveCount(2);
          // Native markers use OL.start; check that CSS still displays them.
          expect(await list.evaluate(el => getComputedStyle(el).listStyleType)).toBe("decimal");
          expect(await list.locator("li").first().evaluate(el => getComputedStyle(el).display)).toBe("list-item");
        }
        await expect(prose.locator("form, button, input:not([type=checkbox]), input:not([disabled])")).toHaveCount(0);
        // Task inputs and the explicitly disabled raw checkbox alone survive.
        await expect(prose.getByRole("checkbox")).toHaveCount(3);
        expect(await prose.getByRole("checkbox").evaluateAll(inputs => inputs.filter(input => (input as HTMLInputElement).checked).length)).toBe(2);
        await expect(prose.locator("[onclick], [data-unsafe], [action], [aria-label='Unsafe active checkbox']")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      };
      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await assertReading();
      await page.reload();
      await assertReading();
      await page.screenshot({ path: testInfo.outputPath(`markdown-lists-${width}.png`), fullPage: true });
      const saved = await request.get(endpoint);
      expect(saved.ok()).toBeTruthy();
      expect((await saved.json()).markdown).toBe(markdown);
    } finally {
      if (created) {
        const current = await request.get(endpoint);
        expect(current.ok()).toBeTruthy();
        const saved = await current.json();
        const deleted = await request.delete(endpoint, { data: {
          base_revision: saved.revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBeTruthy();
      }
    }
  });
}
