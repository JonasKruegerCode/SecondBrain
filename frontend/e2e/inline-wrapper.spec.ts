import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./reading-test";

async function create(request: APIRequestContext, owned: string[], markdown: string) {
  const id = `inline-wrapper-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: null, request_id: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  owned.push(id);
  return { id, ...(await response.json()) };
}

for (const width of [390, 1440]) {
  test(`inline wrapper links retain graph parity and sanitize attributes (${width})`, async ({ page, request }) => {
    const owned: string[] = [];
    try {
      const target = await create(request, owned, "# Fictional wrapper destination\nA synthetic observation.");
      const fixture = await create(request, owned,
        `# Fictional wrapper article\n\n<span style="color:red" onclick="window.__wrapperXss=1">[[${target.id}|Span destination]] and **important observation**</span>\n\n<kbd title="discarded" onmouseover="window.__wrapperXss=2">[[${target.id}|Keyboard destination]]</kbd>\n\n<span><a href="javascript:window.__wrapperXss=3">Unsafe destination</a><img src="data:image/svg+xml,bad" onerror="window.__wrapperXss=4" alt="Inert image"></span>\n\n<button><a href="https://example.invalid/">Inert button child</a></button>\n\n<object><img src="https://example.invalid/object.png" alt="Hidden object child"></object>`,
      );
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/wiki/${fixture.id}`);
      await expect(page.locator('.prose a[data-wiki-target]')).toHaveCount(2);
      for (const name of ["Span destination", "Keyboard destination"]) {
        await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("href", `/wiki/${target.id}`);
      }
      await expect(page.locator(".prose strong")).toHaveText("important observation");
      await expect(page.locator(".prose span,.prose kbd,.prose button,.prose object")).toHaveCount(0);
      await expect(page.locator('.prose a[href^="javascript:"],.prose [style],.prose [onclick],.prose [onmouseover],.prose [onerror]')).toHaveCount(0);
      await expect(page.getByText("Unsafe destination", { exact: true })).not.toHaveAttribute("href");
      await expect(page.locator('.prose img[alt="Inert image"]')).not.toHaveAttribute("src");
      await expect(page.locator('.prose a[href="https://example.invalid/"],.prose img[src="https://example.invalid/object.png"]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__wrapperXss)).toBeUndefined();
      const response = await request.get("/api/wiki/graph");
      expect(response.ok()).toBeTruthy();
      const graph = await response.json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === fixture.id)).toEqual([
        { source: fixture.id, target: target.id, type: "wikilink" },
      ]);
      await page.getByRole("link", { name: "Span destination", exact: true }).click();
      await expect(page.locator("article h1")).toHaveText("Fictional wrapper destination");
      await page.goBack();
      await expect(page.locator('.prose a[data-wiki-target]')).toHaveCount(2);
      await page.reload();
      await expect(page.locator('.prose a[data-wiki-target]')).toHaveCount(2);
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`);
        expect(current.ok()).toBeTruthy();
        const removed = await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBeTruthy();
      }
    }
  });
}

