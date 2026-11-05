import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`ambiguous title candidates expose stable page identities at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const token = randomUUID();
    const title = `Synthetic shared title ${token} ${"Long readable title ".repeat(5).trim()}`;
    // Exercise wrapping with distinct IDs near the supported 160-character limit.
    const ids = ["first", "second"].map(label =>
      `resolver-${token}-${"identity".repeat(12)}-${label}`);
    const source = `resolver-source-${token}`;
    const created: string[] = [];
    const endpoint = (id: string) => `/api/wiki/pages/${encodeURIComponent(id)}`;
    try {
      for (const [index, id] of ids.entries()) {
        const response = await request.post(endpoint(id), { data: {
          markdown: `# ${title}\n\n## Section\n\nSynthetic target ${index + 1}.\n`,
          base_revision: null,
          request_id: randomUUID(),
        } });
        expect(response.ok()).toBeTruthy();
        created.push(id);
      }
      const response = await request.post(endpoint(source), { data: {
        markdown: `# Synthetic resolver source\n\n[[${title}#Section|Choose synthetic target]]\n`,
        base_revision: null,
        request_id: randomUUID(),
      } });
      expect(response.ok()).toBeTruthy();
      created.push(source);

      await page.goto(`/wiki/${source}`);
      await page.locator(".prose").getByRole("link", { name: "Choose synthetic target", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Choose a page.", exact: true })).toBeVisible();
      const identities = page.locator(".grid .card-id");
      await expect(identities).toHaveCount(2);
      for (const id of ids) {
        await expect(identities.filter({ hasText: `Page ID: ${id}` })).toHaveText(`Page ID: ${id}`);
        await expect(identities.filter({ hasText: `Page ID: ${id}` })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      for (const identity of await identities.all()) {
        expect(await identity.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      }
      await page.screenshot({ path: testInfo.outputPath(`candidate-identities-${width}.png`), fullPage: true });

      const chosen = page.locator(".grid a").filter({
        has: page.locator(".card-id", { hasText: `Page ID: ${ids[1]}` }),
      });
      await expect(chosen).toHaveCount(1);
      await expect(chosen).toHaveAttribute("href", `/wiki/${ids[1]}#Section`);
      await chosen.focus();
      await expect(chosen).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).hash)
        .toBe(`/wiki/${ids[1]}#Section`);
      await expect(page.locator("article h1")).toHaveText(title);
      await expect(page.locator(".prose")).toContainText("Synthetic target 2.");
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id));
        if (current.ok()) {
          const saved = await current.json();
          const deleted = await request.delete(endpoint(id), { data: {
            base_revision: saved.revision,
            request_id: randomUUID(),
          } });
          expect(deleted.ok()).toBeTruthy();
        }
      }
    }
  });
}
