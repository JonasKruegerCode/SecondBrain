import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

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
