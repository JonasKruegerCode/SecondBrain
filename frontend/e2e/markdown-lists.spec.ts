import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

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
