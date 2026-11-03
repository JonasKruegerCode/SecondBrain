import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./reading-test";
import { wikiLinkCases } from "./wiki-link-cases";

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
  test(`versioned wiki-link corpus agrees with real graph and backlinks (${width})`, async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const owned: string[] = [];
    const rows: unknown[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    try {
      const shown = await create(request, owned, "# Fictional notebook");
      const hidden = await create(request, owned, "# Fictional metadata target");
      const control = await create(request, owned, "# Fictional control destination");
      for (const item of wikiLinkCases) {
        const body = item.body.split("[[T").join(`[[${shown.id}`).split("[[ T").join(`[[ ${shown.id}`)
          .split("[[H").join(`[[${hidden.id}`);
        const markdown = `# Fictional parity ${item.id}\n\n${body}\n\n[[${control.id}|Control destination]]\n`;
        const source = await create(request, owned, markdown);
        await page.goto(`/wiki/${source.id}`);
        await expect(page.locator("article > h1")).toHaveText(`Fictional parity ${item.id}`);
        // Heading arrival precedes asynchronous link hydration. The independent
        // control must resolve before observing all anchors from that batch.
        await expect(page.getByRole("link", { name: "Control destination", exact: true }))
          .toHaveAttribute("href", `/wiki/${control.id}`);
        const expectedLabels = [...item.labels].map(label => label === "Target ID" ? shown.id : label);
        const anchors = await page.locator(".prose a[data-wiki-target]").evaluateAll(nodes => nodes.map(node => ({
          target: node.getAttribute("data-wiki-target"), text: node.textContent,
          href: node.getAttribute("href"), visible: (node as HTMLElement).getClientRects().length > 0,
        })));
        const graphResponse = await request.get("/api/wiki/graph"); expect(graphResponse.ok()).toBe(true);
        const graph = await graphResponse.json();
        const edges = graph.edges.filter((edge: { source: string }) => edge.source === source.id);
        const missing = graph.missing_targets.filter((entry: { source: string }) => entry.source === source.id);
        const ambiguous = graph.ambiguous_targets.filter((entry: { source: string }) => entry.source === source.id);
        const targets = [...new Set(edges.map((edge: { target: string }) => edge.target))].sort();
        const expected = (item.labels.length ? [control.id, shown.id] : [control.id]).sort();
        const incoming: Record<string, boolean> = {};
        for (const target of [shown.id, hidden.id, control.id]) {
          const response = await request.get(`/api/wiki/pages/${target}/backlinks?limit=100`);
          expect(response.ok()).toBe(true);
          incoming[target] = (await response.json()).backlinks.some((entry: { id: string }) => entry.id === source.id);
        }
        const read = await request.get(`/api/wiki/pages/${source.id}`); expect(read.ok()).toBe(true);
        const current = await read.json();
        const row = { case: item.id, width, markdown, expectedTargets: expected,
          expectedLabels: [...expectedLabels, "Control destination"], anchors, edges, missing, ambiguous, incoming,
          sourceRevision: source.revision, readRevision: current.revision };
        rows.push(row); console.info("[wiki-link-parity] " + JSON.stringify(row));
        expect.soft(anchors.map(anchor => anchor.text).sort(), item.id).toEqual([...expectedLabels, "Control destination"].sort());
        expect.soft([...new Set(anchors.map(anchor => anchor.target))].sort(), item.id).toEqual(expected);
        expect.soft(targets, item.id).toEqual(expected);
        expect.soft(missing, item.id).toEqual([]); expect.soft(ambiguous, item.id).toEqual([]);
        expect.soft(incoming, item.id).toEqual({ [shown.id]: item.labels.length > 0, [hidden.id]: false, [control.id]: true });
        expect(anchors.every(anchor => anchor.visible && anchor.href === `/wiki/${anchor.target}`)).toBe(true);
        expect(current.markdown).toBe(markdown); expect(current.revision).toBe(source.revision);
        if (item.id === "details-raw") {
          await expect(page.locator('.prose')).toContainText(`[[${shown.id}|Notebook]]`);
          await expect(page.locator('.prose')).toContainText("Fictional raw details");
        }
        if (item.id === "details-prose")
          await expect(page.locator('.prose')).toContainText("Fictional details");
        await expect(page.locator('.prose [style],.prose [onclick],.prose [onmouseover]')).toHaveCount(0);
        await expect(page.locator('.prose mark,.prose small,.prose sup,.prose sub,.prose u,.prose details,.prose summary')).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).__parityXss)).toBeUndefined();
        if (item.id === "mark" || item.id === "small") {
          await page.screenshot({ path: info.outputPath(`wiki-link-${item.id}-${width}.png`) });
        }
      }
      const source = await create(request, owned, `# Fictional parity mutation\n\n[[${shown.id}|Notebook]]\n`);
      await page.goto(`/wiki/${source.id}`);
      await expect(page.getByRole("link", { name: "Notebook", exact: true })).toHaveAttribute("href", `/wiki/${shown.id}`);
      const markdown = `# Fictional parity mutation\n\nNote <mark>[[${hidden.id}|Changed destination]]</mark>\n\n[[${control.id}|Control destination]]\n`;
      const data = { markdown, base_revision: source.revision, request_id: randomUUID() };
      const saved = await request.post(`/api/wiki/pages/${source.id}`, { data }); expect(saved.ok()).toBe(true);
      const receipt = await saved.text();
      const retry = await request.post(`/api/wiki/pages/${source.id}`, { data }); expect(retry.ok()).toBe(true);
      expect(await retry.text()).toBe(receipt);
      await page.reload();
      await expect(page.getByRole("link", { name: "Control destination", exact: true }))
        .toHaveAttribute("href", `/wiki/${control.id}`);
      await expect(page.getByRole("link", { name: "Changed destination", exact: true }))
        .toHaveAttribute("href", `/wiki/${hidden.id}`);
      const graph = await (await request.get("/api/wiki/graph")).json();
      const targets = graph.edges.filter((edge: { source: string }) => edge.source === source.id)
        .map((edge: { target: string }) => edge.target).sort();
      expect(targets).toEqual([hidden.id, control.id].sort());
      for (const target of [shown.id, hidden.id, control.id]) {
        const backlinks = await (await request.get(`/api/wiki/pages/${target}/backlinks?limit=100`)).json();
        expect(backlinks.backlinks.some((entry: { id: string }) => entry.id === source.id)).toBe(target !== shown.id);
      }
      expect((await (await request.get(`/api/wiki/pages/${source.id}/history`)).json()).history).toHaveLength(2);
      expect((await (await request.get(`/api/wiki/pages/${source.id}`)).json()).markdown).toBe(markdown);
      console.info("[wiki-link-parity-mutation] " + JSON.stringify({ width, markdown, targets,
        identicalRetry: true, historyEntries: 2, removedOldBacklink: true }));
      await page.getByRole("link", { name: "Changed destination", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Fictional metadata target");
      await page.goBack();
      await expect(page.getByRole("link", { name: "Changed destination", exact: true }))
        .toHaveAttribute("href", `/wiki/${hidden.id}`);
      expect(errors).toEqual([]);
    } finally {
      // Console rows are part of the allowlisted browser.log, including failures.
      // Keep exact synthetic inputs plus both observed projections reproducible.
      console.info("[wiki-link-parity-summary] " + JSON.stringify({ schema: 1, width, cases: rows.length,
        expectedCases: wikiLinkCases.length, externalModelCalls: false }));
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`); expect(current.ok()).toBe(true);
        expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } })).ok()).toBe(true);
      }
    }
  });
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

