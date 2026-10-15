import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [1440, 390]) {
  test(`Markdown task state and ordered numbering survive reading at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `markdown-lists-${randomUUID()}`;
    const endpoint = `/api/wiki/pages/${encodeURIComponent(id)}`;
    const markdown = [
      "# Synthetic Markdown lists", "",
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
