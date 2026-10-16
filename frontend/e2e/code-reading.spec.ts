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
