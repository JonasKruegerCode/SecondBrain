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
  test(`punctuated URL notes do not invent graph connections (${width})`, async ({ page, request }, info) => {
    const owned: string[] = [];
    await page.setViewportSize({ width, height: 900 });
    try {
      const hidden = await create(request, owned, "# Fictional external-only reference");
      const shown = await create(request, owned, "# Fictional notebook");
      for (const punctuation of ["!", ".", "?", ",", ";", ":"]) {
        const markdown = `# Fictional observing note\n\n*HTTPS://example.invalid/[[${hidden.id}]] **Field note${punctuation}*** [[${shown.id}|Notebook]]\n`;
        const saved = await create(request, owned, markdown);
        await page.goto(`/wiki/${saved.id}`);
        await expect(page.locator(".prose strong")).toHaveText(`Field note${punctuation}`);
        await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(1);
        await expect(page.locator('.prose a[href^="HTTPS://example.invalid/"]')).toHaveAttribute(
          "href", `HTTPS://example.invalid/%5B%5B${hidden.id}%5D%5D`,
        );
        const graph = await (await request.get("/api/wiki/graph")).json();
        const edges = graph.edges.filter((edge: { source: string }) => edge.source === saved.id);
        console.info("[punctuated-note] " + JSON.stringify({ width, punctuation, edges, expected: shown.id }));
        if (punctuation === "!") await page.screenshot({ path: info.outputPath(`punctuated-note-${width}.png`) });
        expect(edges).toEqual([{ source: saved.id, target: shown.id, type: "wikilink" }]);
        expect((await (await request.get(`/api/wiki/pages/${saved.id}`)).json()).markdown).toBe(markdown);
        await page.getByRole("link", { name: "Notebook", exact: true }).click();
        await expect(page.locator("article h1")).toHaveText("Fictional notebook");
        await page.goBack();
        await page.reload();
        await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`);
        expect(current.ok()).toBeTruthy();
        expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } })).ok()).toBeTruthy();
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`literal star URL references do not invent graph connections (${width})`, async ({ page, request }) => {
    const owned: string[] = [];
    await page.setViewportSize({ width, height: 900 });
    try {
      const hidden = await create(request, owned, "# Fictional external-only target");
      const shown = await create(request, owned, "# Fictional deliberate target");
      for (const prefix of ["", "prefix ", "\\"]) {
        const markdown = `# Fictional observing reference\n\n${prefix}**HTTPS://example.invalid/[[${hidden.id}]] **Field note*** [[${shown.id}|Visible notebook]]\n`;
        const saved = await create(request, owned, markdown);
        await page.goto(`/wiki/${saved.id}`);
        await expect(page.locator(".prose strong")).toHaveText("Field note");
        await expect(page.locator('.prose a[href^="HTTPS://example.invalid/"]')).toHaveAttribute(
          "href", `HTTPS://example.invalid/%5B%5B${hidden.id}%5D%5D`,
        );
        await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(1);
        await expect(page.getByRole("link", { name: "Visible notebook", exact: true })).toHaveAttribute("href", `/wiki/${shown.id}`);
        const graphResponse = await request.get("/api/wiki/graph");
        expect(graphResponse.ok()).toBeTruthy();
        const graph = await graphResponse.json();
        expect(graph.edges.filter((edge: { source: string }) => edge.source === saved.id)).toEqual([
          { source: saved.id, target: shown.id, type: "wikilink" },
        ]);
        const readback = await request.get(`/api/wiki/pages/${saved.id}`);
        expect(readback.ok()).toBeTruthy();
        expect((await readback.json()).markdown).toBe(markdown);
        await page.getByRole("link", { name: "Visible notebook", exact: true }).click();
        await expect(page.locator("article h1")).toHaveText("Fictional deliberate target");
        await page.goBack();
        await page.reload();
        await expect(page.locator(".prose a[data-wiki-target]")).toHaveCount(1);
      }
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

