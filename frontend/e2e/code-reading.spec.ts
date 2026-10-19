import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [320, 1440]) {
  test(`inline HTML metadata stays out of graph navigation at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const source = `html-metadata-${randomUUID()}`, shown = `html-shown-${randomUUID()}`;
    const hidden = `html-hidden-${randomUUID()}`, missing = `html-missing-${randomUUID()}`;
    const endpoint = (id: string) => `/api/wiki/pages/${id}`;
    const markdown = `# Synthetic HTML metadata\n\nSee <a href="https://example.test/docs" title="[[${hidden}]] > [[${missing}]]">documentation</a> and <em title='[[${hidden}]]'>[[${shown}|Companion]]</em>.\n`;
    const owned: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      for (const [id, body] of [[shown, "# Visible companion\n"], [hidden, "# Metadata companion\n"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: { markdown: body, base_revision: null, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
        owned.push(id);
      }
      const assertReading = async () => {
        await expect(page.locator(".prose a")).toHaveText(["documentation", "Companion"]);
        await expect(page.locator(".prose a").first()).toHaveAttribute("href", "https://example.test/docs");
        await expect(page.locator(".prose [title]")).toHaveCount(0);
        await expect(page.locator(".prose a[data-wiki-target]")).toHaveAttribute("data-wiki-target", shown);
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: { source: string }) => edge.source === source))
          .toEqual([{ source, target: shown, type: "wikilink" }]);
        expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === source)).toEqual([]);
        expect((await (await request.get(endpoint(hidden) + "/backlinks")).json()).total).toBe(0);
      };
      await page.goto(`/wiki/${source}`);
      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await assertReading();
      await page.screenshot({ path: info.outputPath(`inline-html-metadata-${width}.png`) });
      const original = await (await request.get(endpoint(source))).json();
      expect(original.markdown).toBe(markdown);
      const edited = markdown + `\n[[${hidden}|Deliberate connection]]\n`;
      const update = await request.post(endpoint(source), { data: { markdown: edited, base_revision: original.revision, request_id: randomUUID() } });
      expect(update.ok()).toBe(true);
      expect((await (await request.get(endpoint(hidden) + "/backlinks")).json()).total).toBe(1);
      expect((await (await request.get(endpoint(source) + "/history")).json()).history).toHaveLength(2);
      await page.reload();
      await expect(page.getByRole("link", { name: "Deliberate connection", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(endpoint(id));
        expect(current.ok()).toBe(true);
        const response = await request.delete(endpoint(id), { data: { base_revision: (await current.json()).revision, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`generic HTML boundaries agree with graph navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `html-boundary-reading-${randomUUID()}`;
    const visible = `html-boundary-visible-${randomUUID()}`;
    const literal = `html-boundary-literal-${randomUUID()}`;
    // EM is a supported inert inline wrapper. Unknown custom elements are
    // deliberately flattened by the separate sanitizer, not this lexer test.
    const markdown = `# Synthetic HTML boundaries\n\nIntro\n<em>\n    [[${visible}|Paragraph target]]</em>\n\nNumbered paragraph\n2. <em>\n    [[${visible}|Numbered target]]</em>\n\n123. <div>\n     \u00a0\n     [[${literal}]]\n\n[[${visible}|Visible target]]\n`;
    const created: string[] = [];
    try {
      for (const [pageId, body] of [[visible, "# Visible HTML companion\n"], [literal, "# Literal HTML companion\n"], [id, markdown]]) {
        const saved = await request.post(`/api/wiki/pages/${pageId}`, { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(saved.ok()).toBe(true);
        created.push(pageId);
      }
      await page.goto(`/wiki/${id}`);
      await expect(page.locator(".prose a")).toHaveText(["Paragraph target", "Numbered target", "Visible target"]);
      await expect(page.locator(".prose")).toContainText(`[[${literal}]]`);
      const checkGraph = async (includeLiteral = false) => {
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: { source: string }) => edge.source === id)
          .map((edge: { target: string }) => edge.target).sort())
          .toEqual((includeLiteral ? [visible, literal] : [visible]).sort());
        expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
        const backlinks = await (await request.get(`/api/wiki/pages/${literal}/backlinks`)).json();
        expect(backlinks.total).toBe(Number(includeLiteral));
      };
      await checkGraph();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.locator("#editor").fill(markdown + `\n[[${literal}|Now linked]].\n`);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a")).toHaveCount(4);
      await checkGraph(true);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a")).toHaveCount(3);
      await page.reload();
      await expect(page.locator(".prose a")).toHaveText(["Paragraph target", "Numbered target", "Visible target"]);
      expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
      await checkGraph();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`html-boundary-navigation-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${visible}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${literal}']`)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`html-boundary-galaxy-${width}.png`), fullPage: true });
    } finally {
      for (const pageId of created.reverse()) {
        const saved = await request.get(`/api/wiki/pages/${pageId}`);
        expect(saved.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, { data: {
          base_revision: (await saved.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`literal fence tails agree with graph navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `fence-reading-${randomUUID()}`;
    const target = `fence-target-${randomUUID()}`;
    const literal = `fence-literal-${randomUUID()}`;
    const code = [
      `\`\`\`text\n\`\`\`not-a-close\n# Literal title\n[[${literal}]]\n\`\`\``,
      `~~~text\n~~~ <!-- literal -->\n# Another literal title\nRelated:: [[${literal}]]\n~~~`,
    ];
    const markdown = `# Synthetic fence boundary\n\n${code.join("\n\n")}\n\nVisible prose [[${target}|Visible target]].\n`;
    const created: string[] = [];
    try {
      for (const [pageId, body] of [[target, "# Visible target\nSynthetic target.\n"], [id, markdown]]) {
        const saved = await request.post(`/api/wiki/pages/${pageId}`, { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(saved.ok()).toBe(true);
        created.push(pageId);
      }
      await page.goto(`/wiki/${id}`);
      await expect(page.locator(".prose pre")).toHaveCount(2);
      await expect(page.locator(".prose pre a")).toHaveCount(0);
      await expect(page.locator(".prose pre").first()).toContainText(`[[${literal}]]`);
      await expect(page.locator(".prose h1,.prose h2")).toHaveCount(0);
      await expect(page.locator(".prose a")).toHaveCount(1);
      await expect(page.locator(".prose a")).toHaveText("Visible target");
      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBe(true);
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === id))
        .toEqual([{ source: id, target, type: "wikilink" }]);
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      const backlinks = await request.get(`/api/wiki/pages/${target}/backlinks`);
      expect(backlinks.ok()).toBe(true);
      expect((await backlinks.json()).backlinks.map((row: { id: string }) => row.id)).toEqual([id]);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await expect(page.locator(".prose pre")).toHaveCount(2);
      expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`fence-navigation-${width}.png`), fullPage: true });
    } finally {
      for (const pageId of created.reverse()) {
        const saved = await request.get(`/api/wiki/pages/${pageId}`);
        expect(saved.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, { data: {
          base_revision: (await saved.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`Long fenced code remains readable by keyboard at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `code-reading-${randomUUID()}`;
    const endpoint = `/api/wiki/pages/${encodeURIComponent(id)}`;
    const source = [
      '<script>window.__syntheticCodeExecuted = true</script>',
      'const literal = "[[synthetic-code-target|Literal wikilink]]";',
      `const longLine = "${"synthetic-code-column-".repeat(100)}";`,
      "  consecutive   spaces\tand\ttabs",
      "",
      "    final indented line",
      "",
    ].join("\n");
    const markdown = `# Synthetic code reading\n\n## Code sample\n\n\`\`\`javascript\n${source}\`\`\`\n\n[Ordinary trailing article link](https://example.com/synthetic-code-reading)\n`;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
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
        const block = prose.locator("pre");
        await expect(block).toHaveCount(1);
        // textContent, rather than normalized text assertions, checks whitespace fidelity.
        expect(await block.locator("code").textContent()).toBe(source);
        await expect(block.locator("script, a, button, input")).toHaveCount(0);
        expect(await page.evaluate(() => "__syntheticCodeExecuted" in window)).toBe(false);
        expect(await block.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        // Start at a real earlier article navigation control, then use the normal
        // sequential keyboard path; focusing PRE directly would hide a Tab trap.
        await page.getByRole("navigation", { name: "On this page" }).getByRole("link", { name: "Code sample", exact: true }).click();
        await expect(prose.getByRole("heading", { name: "Code sample", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(block).toBeFocused();
        await block.scrollIntoViewIfNeeded();
        const outline = await block.evaluate(el => {
          const style = getComputedStyle(el);
          return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
        });
        expect(outline.style).not.toBe("none");
        expect(outline.width).toBeGreaterThan(0);
        expect(outline.color).not.toBe("rgba(0, 0, 0, 0)");
        const initialScroll = await block.evaluate(el => el.scrollLeft);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => block.evaluate(el => el.scrollLeft)).toBeGreaterThan(initialScroll);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`code-reading-${width}.png`), fullPage: true });
        await page.keyboard.press("Tab");
        await expect(prose.getByRole("link", { name: "Ordinary trailing article link", exact: true })).toBeFocused();
        expect(errors).toEqual([]);
      };

      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      const saved = await request.get(endpoint);
      expect(saved.ok()).toBeTruthy();
      expect((await saved.json()).markdown).toBe(markdown);
      expect(errors).toEqual([]);
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

for (const width of [390, 1440]) {
  test(`escaped wiki examples agree with graph navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `escape-reading-${randomUUID()}`;
    const target = `escape-target-${randomUUID()}`;
    const literal = `escape-literal-${randomUUID()}`;
    const missing = `escape-missing-${randomUUID()}`;
    const markdown = [
      "# Synthetic escaped links",
      "",
      `Literal \\[[${literal}|Literal target]] and \\[[${missing}]].`,
      "",
      `Odd escape ${"\\".repeat(3)}[[${literal}]].`,
      "",
      `Even escape ${"\\".repeat(2)}[[${target}|Visible target]].`,
      "",
      `Actual [[${target}|Visible target]].`,
      "",
      `uses:: \\[[${literal}]]`,
      "",
    ].join("\n");
    const created: string[] = [];
    try {
      for (const [pageId, body] of [[target, "# Visible target\nSynthetic target.\n"], [literal, "# Literal target\nSynthetic literal example.\n"], [id, markdown]]) {
        const saved = await request.post(`/api/wiki/pages/${pageId}`, { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(saved.ok()).toBe(true);
        created.push(pageId);
      }
      await page.goto(`/wiki/${id}`);
      const prose = page.locator(".prose");
      await expect(prose.locator("a")).toHaveCount(2);
      await expect(prose.locator("a")).toHaveText(["Visible target", "Visible target"]);
      await expect(prose).toContainText(`[[${literal}|Literal target]]`);
      await expect(prose).toContainText(`[[${missing}]]`);
      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBe(true);
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === id))
        .toEqual([{ source: id, target, type: "wikilink" }]);
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      const literalBacklinks = await request.get(`/api/wiki/pages/${literal}/backlinks`);
      expect(literalBacklinks.ok()).toBe(true);
      expect((await literalBacklinks.json()).backlinks).toEqual([]);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator(".prose a")).toHaveCount(2);
      await page.reload();
      await expect(page.locator(".prose a")).toHaveCount(2);
      expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`escaped-navigation-${width}.png`), fullPage: true });
    } finally {
      for (const pageId of created.reverse()) {
        const saved = await request.get(`/api/wiki/pages/${pageId}`);
        expect(saved.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, { data: {
          base_revision: (await saved.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`empty wiki aliases survive reading at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const token = randomUUID();
    const source = `link-source-${token}`;
    const target = `link-target-${token}`;
    const missing = `link-missing-${token}`;
    const title = "Synthetic link reading";
    const markdown = [
      `# ${title}`, "",
      `Empty alias: [[${target}|]]`, "",
      `Ordinary alias: [[${target}|Custom companion label]]`, "",
      `Unaliased: [[${target}]]`, "",
      `Missing empty alias: [[${missing}|]]`, "",
    ].join("\n");
    const endpoint = (id: string) => `/api/wiki/pages/${encodeURIComponent(id)}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, body] of [[target, "# Synthetic companion\n\nFictional target.\n"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBeTruthy();
        created.push(id);
      }
      await page.goto(`/wiki/${source}`);
      const assertReading = async () => {
        const prose = page.locator(".prose");
        await expect(page.locator("article > h1")).toHaveText(title);
        const fallbackLinks = prose.getByRole("link", { name: target, exact: true });
        await expect(fallbackLinks).toHaveCount(2);
        for (const link of await fallbackLinks.all()) {
          await expect(link).toHaveAttribute("href", `/wiki/${target}`);
        }
        await expect(prose.getByRole("link", { name: "Custom companion label", exact: true }))
          .toHaveAttribute("href", `/wiki/${target}`);
        const absent = prose.locator("a.missing-link");
        await expect(absent).toHaveText(missing);
        await expect(absent).not.toHaveAttribute("href");
        await expect(absent).toHaveAttribute("aria-label", `${missing}; page missing`);
        await expect(absent).toHaveAttribute("title", "This page does not exist.");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await assertReading();
      await page.screenshot({ path: testInfo.outputPath(`link-reading-${width}.png`), fullPage: true });
      expect((await (await request.get(endpoint(source))).json()).markdown).toBe(markdown);

      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBeTruthy();
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === source))
        .toEqual([{ source, target, type: "wikilink" }]);
      expect(graph.missing_targets.filter((entry: { source: string }) => entry.source === source))
        .toEqual([{ source, target: missing }]);
      const backlinksResponse = await request.get(endpoint(target) + "/backlinks");
      expect(backlinksResponse.ok()).toBeTruthy();
      expect((await backlinksResponse.json()).backlinks.map((entry: { id: string }) => entry.id)).toEqual([source]);

      await page.locator(".prose").getByRole("link", { name: target, exact: true }).first().click();
      await expect(page.locator("article > h1")).toHaveText("Synthetic companion");
      await page.locator(".page-backlinks summary").click();
      await expect(page.getByRole("navigation", { name: "Pages linking here" }).getByRole("link", { name: title, exact: true }))
        .toHaveAttribute("href", `/wiki/${source}`);
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id));
        expect(current.ok()).toBeTruthy();
        const deleted = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBeTruthy();
      }
    }
  });

  test(`safe Markdown scheme casing survives reading at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `scheme-reading-${randomUUID()}`;
    const endpoint = `/api/wiki/pages/${id}`;
    const external = [
      ["Uppercase secure link", "HTTPS://example.invalid/uppercase?q=synthetic#section"],
      ["Mixed-case secure link", "hTtPs://example.invalid/mixed?q=synthetic#section"],
    ] as const;
    const markdown = ["# Synthetic safe scheme reading", "",
      ...external.map(([label, href]) => `[${label}](${href})\n`),
      '[Unsafe scheme](JAVASCRIPT:alert%281%29)', "",
    ].join("\n");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let created = false;
    try {
      const response = await request.post(endpoint, { data: {
        markdown, base_revision: null, request_id: randomUUID(),
      } });
      expect(response.ok()).toBeTruthy();
      created = true;
      await page.goto(`/wiki/${id}`);
      const assertReading = async () => {
        await expect(page.locator("article > h1")).toHaveText("Synthetic safe scheme reading");
        const prose = page.locator(".prose");
        for (const [label, href] of external) {
          const link = prose.getByRole("link", { name: label, exact: true });
          await expect(link).toHaveAttribute("href", href);
          await expect(link).toHaveAttribute("target", "_blank");
          await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        }
        const unsafe = prose.locator("a").filter({ hasText: "Unsafe scheme" });
        await expect(unsafe).toHaveCount(1);
        await expect(unsafe).not.toHaveAttribute("href");
        await unsafe.click();
        await expect(page).toHaveURL(new RegExp(`/wiki/${id}$`));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await assertReading();
      await page.screenshot({ path: testInfo.outputPath(`safe-scheme-reading-${width}.png`), fullPage: true });
      expect((await (await request.get(endpoint)).json()).markdown).toBe(markdown);
      expect(errors).toEqual([]);
    } finally {
      if (created) {
        const current = await request.get(endpoint);
        expect(current.ok()).toBeTruthy();
        const deleted = await request.delete(endpoint, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBeTruthy();
      }
    }
  });

}

for (const width of [390, 1440]) {
  test(`raw HTML blocks agree with article graph evidence at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const token = randomUUID();
    const source = `html-source-${token}`;
    const hidden = `html-hidden-${token}`;
    const visible = `html-visible-${token}`;
    const absent = `html-absent-${token}`;
    const title = "Synthetic raw HTML boundaries";
    const markdown = [
      ...["pre", "script", "style", "textarea"].flatMap(tag => [
        `<${tag}>`, "# Example heading inside raw HTML", `[[${hidden}]]`, "",
        `[[${absent}]]`, `</${tag}>`, "",
      ]),
      `# ${title}`, "", `Visible [[${visible}|Real companion]].`, "",
    ].join("\n");
    const endpoint = (id: string) => `/api/wiki/pages/${encodeURIComponent(id)}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, body] of [[hidden, "# Hidden synthetic target\n"], [visible, "# Real synthetic companion\n"], [source, markdown]]) {
        const response = await request.post(endpoint(id), { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBeTruthy();
        created.push(id);
      }
      await page.goto(`/wiki/${source}`);
      const assertReading = async () => {
        await expect(page.locator("article > h1")).toHaveText(title);
        // The genuine ATX title after raw HTML is promoted into the page
        // heading exactly once; example headings remain literal block text.
        await expect(page.locator("article h1")).toHaveCount(1);
        const prose = page.locator(".prose");
        await expect(prose.locator("h1")).toHaveCount(0);
        await expect(prose.locator("a")).toHaveCount(1);
        await expect(prose.getByRole("link", { name: "Real companion", exact: true }))
          .toHaveAttribute("href", `/wiki/${visible}`);
        await expect(prose.locator("h1,h2,h3,h4,h5,h6").filter({ hasText: "Example heading inside raw HTML" })).toHaveCount(0);
        await expect(prose.locator("pre")).toContainText(`[[${hidden}]]`);
        await expect(prose.locator(".missing-link")).toHaveCount(0);
        await expect(prose.locator("script,style,textarea")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await assertReading();
      await page.screenshot({ path: testInfo.outputPath(`raw-html-reading-${width}.png`), fullPage: true });
      const saved = await request.get(endpoint(source));
      expect(saved.ok()).toBeTruthy();
      const article = await saved.json();
      expect(article.markdown).toBe(markdown);
      expect(article.title).toBe(title);
      expect(article.excerpt).toBe("Visible Real companion.");
      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBeTruthy();
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === source))
        .toEqual([{ source, target: visible, type: "wikilink" }]);
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === source)).toEqual([]);
      for (const [id, expected] of [[hidden, []], [visible, [source]]] as const) {
        const response = await request.get(endpoint(id) + "/backlinks");
        expect(response.ok()).toBeTruthy();
        expect((await response.json()).backlinks.map((entry: { id: string }) => entry.id)).toEqual(expected);
      }
      await page.locator(".prose").getByRole("link", { name: "Real companion", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Real synthetic companion");
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id));
        expect(current.ok()).toBeTruthy();
        const deleted = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBeTruthy();
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`quoted fences agree with graph navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `quote-reading-${randomUUID()}`;
    const target = `quote-target-${randomUUID()}`;
    const literal = `quote-literal-${randomUUID()}`;
    const code = [
      `> ~~~md\n> [[${literal}]]\n> ~~~`,
      `> > ~~~md\n[[${literal}]]\n> > ~~~`,
    ];
    const markdown = `# Synthetic quoted code\n\n> Visible [[Visible\tcompanion|Quoted target]].\n>\n${code.join("\n\n")}\n\nVisible prose [[${target}|Visible target]].\n`;
    const created: string[] = [];
    try {
      for (const [pageId, body] of [[target, "# Visible\tcompanion\nSynthetic target.\n"], [literal, "# Literal companion\n"], [id, markdown]]) {
        const saved = await request.post(`/api/wiki/pages/${pageId}`, { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(saved.ok()).toBe(true);
        created.push(pageId);
      }
      await page.goto(`/wiki/${id}`);
      await expect(page.locator(".prose pre")).toHaveCount(2);
      await expect(page.locator(".prose pre a")).toHaveCount(0);
      await expect(page.locator(".prose pre").first()).toContainText(`[[${literal}]]`);
      await expect(page.locator(".prose h1,.prose h2")).toHaveCount(0);
      await expect(page.locator(".prose a")).toHaveCount(2);
      await expect(page.locator(".prose a")).toHaveText(["Quoted target", "Visible target"]);
      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBe(true);
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === id))
        .toEqual([{ source: id, target, type: "wikilink" }]);
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      const backlinks = await request.get(`/api/wiki/pages/${target}/backlinks`);
      expect(backlinks.ok()).toBe(true);
      expect((await backlinks.json()).backlinks.map((row: { id: string }) => row.id)).toEqual([id]);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      // Publish a real link outside the code, then restore the original source.
      // The same target must gain and lose an actual incoming edge, while its
      // appearances inside both quoted code blocks remain literal throughout.
      const literalBacklinks = async () => {
        const response = await request.get(`/api/wiki/pages/${literal}/backlinks`);
        expect(response.ok()).toBe(true);
        return (await response.json()).total;
      };
      expect(await literalBacklinks()).toBe(0);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown + `\nVisible [[${literal}|Now visible]].\n`);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a").filter({ hasText: "Now visible" })).toHaveCount(1);
      expect(await literalBacklinks()).toBe(1);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a")).toHaveCount(2);
      expect(await literalBacklinks()).toBe(0);
      const restoredGraph = await (await request.get("/api/wiki/graph")).json();
      expect(restoredGraph.edges.filter((edge: { source: string }) => edge.source === id))
        .toEqual([{ source: id, target, type: "wikilink" }]);
      expect(restoredGraph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      await page.reload();
      await expect(page.locator(".prose pre")).toHaveCount(2);
      expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`quote-navigation-${width}.png`), fullPage: true });
    } finally {
      for (const pageId of created.reverse()) {
        const saved = await request.get(`/api/wiki/pages/${pageId}`);
        expect(saved.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, { data: {
          base_revision: (await saved.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`list quote fences agree with graph navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `list-quote-reading-${randomUUID()}`;
    const target = `list-quote-target-${randomUUID()}`;
    const literal = `list-quote-literal-${randomUUID()}`;
    const code = [
      `- > ~~~md\n> [[${literal}]]\n  > ~~~`,
      `1. > ~~~md\n   > [[${literal}]]\n   > ~~~`,
    ];
    const markdown = `# Synthetic list quoted code\n\n> Visible [[Visible\tcompanion|Quoted target]].\n>\n${code.join("\n\n")}\n\nVisible prose [[${target}|Visible target]].\n`;
    const created: string[] = [];
    try {
      for (const [pageId, body] of [[target, "# Visible\tcompanion\nSynthetic target.\n"], [literal, "# Literal companion\n"], [id, markdown]]) {
        const saved = await request.post(`/api/wiki/pages/${pageId}`, { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(saved.ok()).toBe(true);
        created.push(pageId);
      }
      await page.goto(`/wiki/${id}`);
      await expect(page.locator(".prose pre")).toHaveCount(2);
      await expect(page.locator(".prose pre a")).toHaveCount(0);
      await expect(page.locator(".prose pre").first()).toContainText(`[[${literal}]]`);
      await expect(page.locator(".prose h1,.prose h2")).toHaveCount(0);
      await expect(page.locator(".prose a")).toHaveCount(2);
      await expect(page.locator(".prose a")).toHaveText(["Quoted target", "Visible target"]);
      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBe(true);
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === id))
        .toEqual([{ source: id, target, type: "wikilink" }]);
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      const backlinks = await request.get(`/api/wiki/pages/${target}/backlinks`);
      expect(backlinks.ok()).toBe(true);
      expect((await backlinks.json()).backlinks.map((row: { id: string }) => row.id)).toEqual([id]);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      // Publish a real link outside the code, then restore the original source.
      // The same target must gain and lose an actual incoming edge, while its
      // appearances inside both quoted code blocks remain literal throughout.
      const literalBacklinks = async () => {
        const response = await request.get(`/api/wiki/pages/${literal}/backlinks`);
        expect(response.ok()).toBe(true);
        return (await response.json()).total;
      };
      expect(await literalBacklinks()).toBe(0);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown + `\nVisible [[${literal}|Now visible]].\n`);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a").filter({ hasText: "Now visible" })).toHaveCount(1);
      expect(await literalBacklinks()).toBe(1);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a")).toHaveCount(2);
      expect(await literalBacklinks()).toBe(0);
      const restoredGraph = await (await request.get("/api/wiki/graph")).json();
      expect(restoredGraph.edges.filter((edge: { source: string }) => edge.source === id))
        .toEqual([{ source: id, target, type: "wikilink" }]);
      expect(restoredGraph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      await page.reload();
      await expect(page.locator(".prose pre")).toHaveCount(2);
      expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`list-quote-navigation-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${target}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${literal}']`)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`list-quote-galaxy-${width}.png`), fullPage: true });
    } finally {
      for (const pageId of created.reverse()) {
        const saved = await request.get(`/api/wiki/pages/${pageId}`);
        expect(saved.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, { data: {
          base_revision: (await saved.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`list paragraphs agree with graph navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `list-paragraph-reading-${randomUUID()}`;
    const target = `list-paragraph-target-${randomUUID()}`;
    const literal = `list-paragraph-literal-${randomUUID()}`;
    const continued = `list-paragraph-continued-${randomUUID()}`;
    const markdown = `# Synthetic list paragraphs\n\n- \n\n    [[${literal}]]\n\n123. [[Visible\tcompanion|First target]]\n    [[${continued}|Continued target]]\n\n-  \n\n    [[${target}|Spaced marker target]]\n\nVisible prose [[${target}|Visible target]].\n`;
    const created: string[] = [];
    try {
      for (const [pageId, body] of [[target, "# Visible\tcompanion\nSynthetic target.\n"], [literal, "# Literal companion\n"], [continued, "# Continued companion\n"], [id, markdown]]) {
        const saved = await request.post(`/api/wiki/pages/${pageId}`, { data: {
          markdown: body, base_revision: null, request_id: randomUUID(),
        } });
        expect(saved.ok()).toBe(true);
        created.push(pageId);
      }
      await page.goto(`/wiki/${id}`);
      await expect(page.locator(".prose pre")).toHaveCount(1);
      await expect(page.locator(".prose pre a")).toHaveCount(0);
      await expect(page.locator(".prose pre").first()).toContainText(`[[${literal}]]`);
      await expect(page.locator(".prose h1,.prose h2")).toHaveCount(0);
      await expect(page.locator(".prose a")).toHaveCount(4);
      await expect(page.locator(".prose a")).toHaveText(["First target", "Continued target", "Spaced marker target", "Visible target"]);
      const graphResponse = await request.get("/api/wiki/graph");
      expect(graphResponse.ok()).toBe(true);
      const graph = await graphResponse.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === id)
        .map((edge: { target: string }) => edge.target).sort()).toEqual([target, continued].sort());
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      const backlinks = await request.get(`/api/wiki/pages/${target}/backlinks`);
      expect(backlinks.ok()).toBe(true);
      expect((await backlinks.json()).backlinks.map((row: { id: string }) => row.id)).toEqual([id]);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      // Publish a real link outside the code, then restore the original source.
      // The same target must gain and lose an actual incoming edge, while its
      // appearances inside the indented code block remain literal throughout.
      const literalBacklinks = async () => {
        const response = await request.get(`/api/wiki/pages/${literal}/backlinks`);
        expect(response.ok()).toBe(true);
        return (await response.json()).total;
      };
      expect(await literalBacklinks()).toBe(0);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown + `\nVisible [[${literal}|Now visible]].\n`);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a").filter({ hasText: "Now visible" })).toHaveCount(1);
      expect(await literalBacklinks()).toBe(1);
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose a")).toHaveCount(4);
      expect(await literalBacklinks()).toBe(0);
      const restoredGraph = await (await request.get("/api/wiki/graph")).json();
      expect(restoredGraph.edges.filter((edge: { source: string }) => edge.source === id)
        .map((edge: { target: string }) => edge.target).sort()).toEqual([target, continued].sort());
      expect(restoredGraph.missing_targets.filter((edge: { source: string }) => edge.source === id)).toEqual([]);
      await page.reload();
      await expect(page.locator(".prose pre")).toHaveCount(1);
      expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`list-paragraph-navigation-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(`.galaxy-evidence a[data-open='${target}']`)).toHaveCount(1);
      await expect(page.locator(`.galaxy-evidence a[data-open='${literal}']`)).toHaveCount(0);
      await expect(page.locator(`.galaxy-evidence a[data-open='${continued}']`)).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`list-paragraph-galaxy-${width}.png`), fullPage: true });
    } finally {
      for (const pageId of created.reverse()) {
        const saved = await request.get(`/api/wiki/pages/${pageId}`);
        expect(saved.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, { data: {
          base_revision: (await saved.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}


const endpoint = (id: string) => `/api/wiki/pages/${encodeURIComponent(id)}`;

for (const width of [390, 1440]) {
  test(`code spans respect paragraph, heading and table cell scopes at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const owned: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const cases = [
      { name: "paragraph", visible: true, body: (target: string) => `\`open\n\n[[${target}]]\n\n\`close` },
      { name: "heading", visible: true, body: (target: string) => `\`open\n## [[${target}]]\n\`close` },
      { name: "table-cell", visible: true, body: (target: string) => `| one | two |\n| --- | --- |\n| \`open | [[${target}]]\` |` },
      { name: "same-paragraph", visible: false, body: (target: string) => `\`open\n[[${target}]]\n\`close` },
    ];
    try {
      for (const fixture of cases) {
        const token = randomUUID().slice(0, 8);
        const source = `scope-source-${token}`;
        const target = `scope-target-${token}`;
        const title = `Synthetic ${fixture.name} scope`;
        const markdown = `# ${title}\n\n${fixture.body(target)}\n`;
        let revision = "";
        for (const [id, body] of [[target, "# Synthetic scope companion\n\nFictional target.\n"], [source, markdown]]) {
          const created = await request.post(endpoint(id), { data: {
            markdown: body, base_revision: null, request_id: randomUUID(),
          } });
          expect(created.ok()).toBe(true);
          owned.push(id);
          if (id === source) revision = (await created.json()).revision;
        }
        await page.goto(`/wiki/${source}`);
        const assertReading = async () => {
          await expect(page.locator("article > h1")).toHaveText(title);
          const links = page.locator(`.prose a[href='/wiki/${target}']`);
          await expect(links).toHaveCount(Number(fixture.visible));
          if (fixture.visible) {
            await expect(links).toHaveText(target);
            await expect(page.locator(".prose code a")).toHaveCount(0);
          } else {
            await expect(page.locator(".prose code")).toContainText(`[[${target}]]`);
            await expect(page.locator(".prose a")).toHaveCount(0);
          }
          if (fixture.name === "heading") await expect(page.locator(".prose h2 a")).toHaveText(target);
          if (fixture.name === "table-cell") await expect(page.locator(".prose td a")).toHaveText(target);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await assertReading();
        // Real API graph/backlinks must agree with the browser's rendered anchor.
        const graphResponse = await request.get("/api/wiki/graph");
        expect(graphResponse.ok()).toBe(true);
        const graph = await graphResponse.json();
        expect(graph.edges.filter((edge: { source: string }) => edge.source === source))
          .toEqual(fixture.visible ? [{ source, target, type: "wikilink" }] : []);
        expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === source)).toEqual([]);
        const backlinks = await request.get(endpoint(target) + "/backlinks");
        expect(backlinks.ok()).toBe(true);
        expect((await backlinks.json()).backlinks.map((entry: { id: string }) => entry.id))
          .toEqual(fixture.visible ? [source] : []);

        await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
        await expect(page.locator("#editor")).toHaveValue(markdown);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.reload();
        await assertReading();
        await page.screenshot({ path: info.outputPath(`code-span-${fixture.name}-${width}.png`), fullPage: true });
        if (fixture.visible) {
          await page.locator(`.prose a[href='/wiki/${target}']`).click();
          await expect(page.locator("article > h1")).toHaveText("Synthetic scope companion");
          await page.goBack();
          await assertReading();
        }
        const stored = await request.get(endpoint(source));
        expect(stored.ok()).toBe(true);
        expect(await stored.json()).toMatchObject({ markdown, revision });
        const history = await request.get(endpoint(source) + "/history");
        expect(history.ok()).toBe(true);
        expect((await history.json()).history).toHaveLength(1);
      }
      expect(errors).toEqual([]);
    } finally {
      for (const id of [...owned].reverse()) {
        const current = await request.get(endpoint(id));
        expect(current.ok()).toBe(true);
        const removed = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

