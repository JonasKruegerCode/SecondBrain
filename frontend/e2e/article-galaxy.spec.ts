import { test, expect, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Graph } from "../src/galaxy";

const contextualURL = "/galaxy?page=field-notebook";
const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

for (const width of [390, 1440]) {
  test(`galaxy display changes preserve expanded link diagnostics (${width})`, async ({ page, request }, info) => {
    const group = `display-state-${randomUUID()}`;
    const ids = [`${group}-core`, `${group}-neighbor`];
    const owned: string[] = [];
    const baseline = await (await request.get("/api/wiki/graph")).json();
    try {
      for (const [index, id] of ids.entries()) {
        const response = await request.post(`/api/wiki/pages/${id}`, { data: {
          markdown: `---\ngalaxy_group: ${group}\ngalaxy_label: Synthetic display constellation\n${index === 0 ? "galaxy_anchor: true\n" : ""}---\n# Synthetic display page ${index}\n\n[[${ids[1 - index]}]]\n${index === 0 ? `[[missing-${group}]]` : ""}`,
          base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true); owned.push(id);
      }
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/galaxy?page=${ids[0]}`);
      const sidebar = page.locator(".galaxy-sidebar-content");
      const problems = sidebar.locator(".galaxy-problems");
      const toggle = page.locator('[data-action="list"]');
      await problems.locator("summary").click();
      await expect(problems).toHaveJSProperty("open", true);
      // Both directed fixture links must expose their meaning in the accessibility tree.
      await expect(sidebar.getByRole("img", { name: "links to", exact: true })).toHaveCount(2);
      const evidence = await sidebar.locator(".galaxy-evidence").innerText();
      for (const listOnly of [true, false]) {
        await toggle.focus(); await page.keyboard.press("Enter");
        await expect(toggle).toBeFocused();
        await expect(toggle).toHaveAttribute("aria-pressed", String(listOnly));
        await expect(page.locator(".galaxy-stage")).toBeVisible({ visible: !listOnly });
        await expect(problems).toHaveJSProperty("open", true);
        await expect(problems).toContainText(`missing-${group}`);
        await expect(page.locator(".galaxy-selected-heading code")).toHaveText(ids[0]);
        expect(await sidebar.locator(".galaxy-evidence").innerText()).toBe(evidence);
        await expect(sidebar.getByRole("img", { name: "links to", exact: true })).toHaveCount(2);
        // Reveal the diagnostic only after its state/focus assertions. A
        // mobile mode button can otherwise leave it below the screenshot.
        await problems.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`galaxy-diagnostics-${listOnly ? "list" : "map"}-${width}.png`) });
      }
      // A real selection still starts a fresh detail view; only display mode
      // changes preserve the open diagnostic for the same selected page.
      await sidebar.locator(".galaxy-evidence button[data-node]").first().click();
      await expect(page.locator(".galaxy-selected-heading code")).toHaveText(ids[1]);
      await expect(problems).toHaveCount(0);
      await sidebar.locator(".galaxy-evidence button[data-node]").first().click();
      await expect(page.locator(".galaxy-selected-heading code")).toHaveText(ids[0]);
      await expect(problems).toHaveJSProperty("open", false);
      const search = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
      await search.fill(group);
      await expect(sidebar.locator(".galaxy-page")).toHaveCount(2);
      await toggle.focus(); await page.keyboard.press("Enter");
      await expect(search).toHaveValue(group);
      await expect(sidebar.locator(".galaxy-page")).toHaveCount(2);
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`); expect(current.ok()).toBe(true);
        const response = await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(response.ok(), `cleanup owned page ${id}`).toBe(true);
      }
      const restored = await (await request.get("/api/wiki/graph")).json();
      expect(restored.nodes).toEqual(baseline.nodes); expect(restored.edges).toEqual(baseline.edges);
    }
  });
}

for (const width of [390, 1440]) {
  test(`late contextual graph cannot replace a newer article neighborhood (${width})`, async ({ page }, info) => {
    const pattern = "**/api/wiki/graph";
    let release!: () => void;
    let received!: () => void;
    let delivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { received = resolve; });
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    // Observe the application's actual JSON consumption, rather than treating
    // route.fulfill or a delay as proof that the stale continuation has run.
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      let graphRead = 0;
      const consumed: number[] = [];
      Object.assign(window, { __consumedGalaxyReads: consumed });
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const input = args[0];
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const read = new URL(url, location.href).pathname === "/api/wiki/graph" ? ++graphRead : 0;
        const response = await original(...args);
        if (read) {
          const json = response.json.bind(response);
          response.json = async () => {
            const body = await json();
            consumed.push(read);
            return body;
          };
        }
        return response;
      };
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/wiki/field-notebook");
    await expect(page.locator("article > h1")).toHaveText("Field notebook");
    await page.route(pattern, async route => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      received();
      await gate;
      await route.fulfill({ response });
      delivered();
    }, { times: 1 });
    try {
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await held;
      await expect(page).toHaveURL(/\/galaxy\?page=field-notebook$/);
      // Leave the pending view through real SPA links and real search results.
      await primary(page).getByRole("link", { name: "Search", exact: true }).click();
      await page.getByRole("textbox", { name: "Search pages" }).fill("Salt marsh");
      await page.getByRole("button", { name: "Search →", exact: true }).click();
      await page.locator("#results a.card[href='/wiki/salt-marsh']").click();
      await expect(page.locator("article > h1")).toHaveText("Salt marsh listening station");
      const nextRead = page.waitForResponse(response => response.url().endsWith("/api/wiki/graph"));
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      expect((await nextRead).ok()).toBe(true);
      await expect(page).toHaveURL(/\/galaxy\?page=salt-marsh$/);
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Salt marsh listening station");
      await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "salt-marsh");
      await expect(page.locator(".galaxy-breadcrumb")).toContainText("Shore observations");
      await expect(page.locator(".galaxy-evidence")).toContainText("Explicit wikilink");
      await expect(page.locator(".galaxy-evidence a").first()).toBeVisible();
      await page.screenshot({ path: info.outputPath(`galaxy-late-selected-${width}.png`), fullPage: true });
      const search = primary(page).getByRole("link", { name: "Search", exact: true });
      await search.focus();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const snapshot = async () => ({
        title: await page.locator(".galaxy-selected-heading h2").textContent(),
        cluster: await page.locator(".galaxy-breadcrumb").textContent(),
        evidence: await page.locator(".galaxy-evidence").innerHTML(),
        context: await page.locator(".galaxy-selected-heading .galaxy-article").getAttribute("data-open"),
        reading: await page.evaluate(() => ({
          url: location.href, length: history.length, entry: history.state["secondbrain.navigation"],
          title: document.title, x: scrollX, y: scrollY,
        })),
      });
      const current = await snapshot();
      // Store a deliberate exploration state on B's visit. A stale renderer can
      // corrupt global cleanup ownership even when its old main is detached.
      await page.getByRole("button", { name: "All constellations" }).click();
      const localQuery = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
      await localQuery.fill("salt");
      await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
      await search.focus();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const explored = {
        sidebar: await page.locator(".galaxy-sidebar-content").innerHTML(),
        cluster: await page.locator(".galaxy-breadcrumb").textContent(),
        reading: await page.evaluate(() => ({
          url: location.href, length: history.length, entry: history.state["secondbrain.navigation"],
          title: document.title, x: scrollX, y: scrollY,
        })),
      };
      expect(explored.reading.url).toBe(current.reading.url);
      expect(explored.reading.entry).toEqual(current.reading.entry);
      release();
      await completed;
      await page.waitForFunction(() =>
        (window as unknown as { __consumedGalaxyReads: number[] }).__consumedGalaxyReads.includes(1));
      // The JSON observer runs before api/render continuations; animation frames
      // drain those microtasks and any scheduled focus/reading restoration.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() =>
        (window as unknown as { __consumedGalaxyReads: number[] }).__consumedGalaxyReads)).toEqual([2, 1]);
      await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
      await expect(localQuery).toHaveValue("salt");
      expect({
        sidebar: await page.locator(".galaxy-sidebar-content").innerHTML(),
        cluster: await page.locator(".galaxy-breadcrumb").textContent(),
        reading: await page.evaluate(() => ({
          url: location.href, length: history.length, entry: history.state["secondbrain.navigation"],
          title: document.title, x: scrollX, y: scrollY,
        })),
      }).toEqual(explored);
      await expect(search).toBeFocused();
      await search.click();
      await expect(page).toHaveURL(/\/search$/);
      const restoredRead = page.waitForResponse(response => response.url().endsWith("/api/wiki/graph"));
      await page.goBack();
      expect((await restoredRead).ok()).toBe(true);
      await expect(page).toHaveURL(/\/galaxy\?page=salt-marsh$/);
      await expect(localQuery).toHaveValue("salt");
      await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
      expect(await page.locator(".galaxy-sidebar-content").innerHTML()).toBe(explored.sidebar);
      expect(await page.locator(".galaxy-breadcrumb").textContent()).toBe(explored.cluster);
      expect(await page.evaluate(() => history.state["secondbrain.navigation"])).toEqual(explored.reading.entry);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`galaxy-late-restored-${width}.png`), fullPage: true });
    } finally {
      release();
      await page.unroute(pattern);
    }
  });
}

for (const width of [390, 1440]) {
  test(`contextual Galaxy retry retains its visit and reads current content (${width})`, async ({ page, request }, info) => {
    const id = `galaxy-retry-${randomUUID()}`;
    let owned = false, failedReads = 0;
    const pattern = "**/api/wiki/graph";
    try {
      const created = await request.post(`/api/wiki/pages/${id}`, { data: {
        markdown: "---\ngalaxy_group: archive-practice\n---\n# Synthetic retry origin\n\nLinked to [[field-notebook]].",
        base_revision: null, request_id: randomUUID(),
      } });
      expect(created.ok()).toBe(true);
      owned = true;
      const original = await created.json();
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/wiki/${id}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic retry origin");
      // Only inject a transport failure. The retry must read the real service.
      await page.route(pattern, async route => { failedReads++; await route.abort("failed"); }, { times: 1 });
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Couldn’t open the workspace.", exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/galaxy\\?page=${id}$`));
      expect(failedReads).toBe(1);
      const visit = await page.evaluate(() => ({ length: history.length, entry: history.state["secondbrain.navigation"] }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`galaxy-context-unavailable-${width}.png`), fullPage: true });
      const updated = await request.post(`/api/wiki/pages/${id}`, { data: {
        markdown: "---\ngalaxy_group: shore-observation\n---\n# Synthetic retry recovered\n\nLinked to [[salt-marsh]].",
        base_revision: original.revision, request_id: randomUUID(),
      } });
      expect(updated.ok()).toBe(true);
      await page.unroute(pattern);
      const graphRead = page.waitForResponse(response => response.url().endsWith("/api/wiki/graph"));
      await page.getByRole("button", { name: "Try again" }).click();
      const response = await graphRead;
      expect(response.ok()).toBe(true);
      const graph = await response.json() as Graph;
      expect(graph.nodes.find(node => node.id === id)?.title).toBe("Synthetic retry recovered");
      await expect(page).toHaveURL(new RegExp(`/galaxy\\?page=${id}$`));
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic retry recovered");
      await expect(page.locator(".galaxy-breadcrumb")).toContainText("Shore observations");
      await expect(page.locator(".galaxy-evidence a[data-open='salt-marsh']")).toHaveCount(1);
      await expect(page.locator(".galaxy-evidence a[data-open='field-notebook']")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
      expect(await page.evaluate(() => ({ length: history.length, entry: history.state["secondbrain.navigation"] }))).toEqual(visit);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`galaxy-context-recovered-${width}.png`), fullPage: true });
    } finally {
      await page.unroute(pattern);
      if (owned) {
        const latest = await request.get(`/api/wiki/pages/${id}`);
        expect(latest.ok()).toBe(true);
        const removed = await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await latest.json()).revision, request_id: randomUUID(),
        } });
        expect(removed.ok()).toBe(true);
      }
    }
  });
}

async function selectedNotebook(page: Page) {
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "field-notebook");
  await expect(page.locator(".galaxy-breadcrumb")).toContainText("Archive practice");
  await expect(page.locator(".galaxy-evidence")).toContainText("Explicit wikilink");
  await expect(page.locator(".galaxy-evidence a[data-open='archive-method']").first()).toBeVisible();
}
async function overview(page: Page) {
  await expect(page.locator(".galaxy-breadcrumb")).toHaveText("Galaxy overview");
  await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Choose a constellation" })).toBeVisible();
}

for (const width of [390, 1440]) {
  test(`article connections open its real neighborhood and preserve visit history (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/wiki/field-notebook");
    await expect(page.locator("article > h1")).toHaveText("Field notebook");
    const explore = page.getByRole("link", { name: "Explore connections", exact: true });
    await expect(explore).toHaveAttribute("href", contextualURL);
    await expect(primary(page).getByRole("link", { name: "Galaxy", exact: true })).toHaveAttribute("href", "/galaxy");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`article-connections-toolbar-${width}.png`), fullPage: true });
    await explore.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${contextualURL.replace("?", "\\?")}$`));
    await selectedNotebook(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`article-galaxy-${width}.png`), fullPage: true });
    await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article ↗", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
    await page.goBack();
    await selectedNotebook(page);
    await page.getByRole("button", { name: "All constellations" }).click();
    await overview(page);
    await primary(page).getByRole("link", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/\/search$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/galaxy\?page=field-notebook$/);
    await overview(page);
    // A hard reload is a new snapshot entry: the shareable URL selects anew.
    await page.reload();
    await selectedNotebook(page);
    await page.getByRole("button", { name: "All constellations" }).click();
    await page.getByRole("link", { name: "Refresh snapshot" }).click();
    await expect(page).toHaveURL(/\/galaxy\?page=field-notebook$/);
    await selectedNotebook(page);
    await page.goBack();
    await overview(page);
    await primary(page).getByRole("link", { name: "Search", exact: true }).click();
    await primary(page).getByRole("link", { name: "Galaxy", exact: true }).click();
    await expect(page).toHaveURL(/\/galaxy$/);
    await overview(page);
    await page.goto(contextualURL);
    await selectedNotebook(page);
  });
}

test("missing and genuinely deleted contextual targets show an honest overview", async ({ page, request }, info) => {
  const id = `article-galaxy-${randomUUID()}`;
  let revision: string | null = null;
  const missing = `${id}-missing-<script>synthetic</script>`;
  const missingOverview = async () => {
    await overview(page);
    await expect(page.locator(".galaxy-entry-notice")).toHaveAttribute("role", "status");
    await expect(page.locator(".galaxy-entry-notice")).toContainText("This page is not in the current snapshot.");
    await expect(page.locator(".galaxy-entry-notice")).not.toContainText(id);
    await expect(page.locator(".galaxy-entry-notice script")).toHaveCount(0);
  };
  try {
    await page.goto(`/galaxy?page=${encodeURIComponent(missing)}`);
    await missingOverview();
    await page.screenshot({ path: info.outputPath("galaxy-missing-entry.png"), fullPage: true });
    const created = await request.post(`/api/wiki/pages/${id}`, { data: {
      markdown: "---\ngalaxy_group: archive-practice\ngalaxy_label: Archive practice\n---\n# Synthetic contextual page\n\nA public test note linked to [[field-notebook]].",
      base_revision: null, request_id: randomUUID(),
    } });
    expect(created.ok()).toBe(true);
    revision = (await created.json()).revision;
    await page.goto(`/wiki/${id}`);
    const explore = page.getByRole("link", { name: "Explore connections", exact: true });
    await expect(explore).toHaveAttribute("href", `/galaxy?page=${encodeURIComponent(id)}`);
    await explore.click();
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic contextual page");
    await expect(page.locator(".galaxy-breadcrumb")).toContainText("Archive practice");
    await expect(page.locator(".galaxy-evidence")).toContainText("Field notebook");
    await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article ↗", exact: true }).click();
    await expect(page.locator("article > h1")).toHaveText("Synthetic contextual page");
    const deleted = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: revision, request_id: randomUUID() } });
    expect(deleted.ok()).toBe(true);
    revision = null;
    // History must discard the deleted selection even if its old core survives.
    await page.goBack();
    await missingOverview();
    // Refresh must read the actual new snapshot, not the old selected node.
    await page.getByRole("link", { name: "Refresh snapshot" }).click();
    await expect(page).toHaveURL(new RegExp(`/galaxy\\?page=${id}$`));
    await missingOverview();
    await page.screenshot({ path: info.outputPath("galaxy-deleted-entry.png"), fullPage: true });
    await page.goto(`/galaxy?page=${encodeURIComponent(id)}`);
    await missingOverview();
  } finally {
    if (revision !== null) {
      const cleanup = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: revision, request_id: randomUUID() } });
      expect(cleanup.ok(), `cleanup synthetic page ${id}`).toBe(true);
    }
  }
});

for (const width of [390, 1440]) {
  test(`contextual Galaxy resolves a renamed and regrouped stable page ID (${width})`, async ({ page, context, request }, info) => {
    const id = `article-galaxy-mutation-${randomUUID()}`;
    const targetURL = `/galaxy?page=${id}`;
    const originalTitle = "Synthetic archive observation";
    const updatedTitle = "Synthetic shore observation";
    const markdown = (title: string, group: string, label: string, link: string) =>
      `---\ngalaxy_group: ${group}\ngalaxy_label: ${label}\n---\n# ${title}\n\nAn invented regression note linked to [[${link}]].`;
    const readGraph = async (): Promise<Graph> => {
      const response = await request.get("/api/wiki/graph");
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const baseline = await readGraph();
    // Exact existing demo-vault salt-marsh frontmatter, verified against REST too.
    const shore = { group: "shore-observation", label: "Shore observations" };
    expect(baseline.nodes.find(node => node.id === "salt-marsh")?.galaxy).toMatchObject(shore);
    let owned = false;
    let editorPage: Page | undefined;
    const selected = async (title: string, label: string, neighbor: string) => {
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
      await expect(page.locator(".galaxy-selected-heading code")).toHaveText(id);
      await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id);
      await expect(page.locator(".galaxy-breadcrumb")).toContainText(label);
      await expect(page.locator(".galaxy-evidence")).toContainText("Explicit wikilink");
      await expect(page.locator(`.galaxy-evidence a[data-open='${neighbor}']`)).toHaveCount(1);
    };
    try {
      const created = await request.post(`/api/wiki/pages/${id}`, { data: {
        markdown: markdown(originalTitle, "archive-practice", "Archive practice", "field-notebook"),
        base_revision: null, request_id: randomUUID(),
      } });
      expect(created.ok()).toBe(true);
      owned = true;
      const originalGraph = await readGraph();
      expect(originalGraph.nodes.find(node => node.id === id)).toEqual({
        id, title: originalTitle, galaxy: { group: "archive-practice", label: "Archive practice" },
      });
      expect(originalGraph.edges.filter(edge => edge.source === id || edge.target === id)).toEqual([
        { source: id, target: "field-notebook", type: "wikilink" },
      ]);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(targetURL);
      await selected(originalTitle, "Archive practice", "field-notebook");
      await expect(page.locator(".galaxy-revision")).toContainText(originalGraph.revision!.slice(0, 8));
      await page.getByText("How this map is arranged", { exact: true }).click();
      await expect(page.locator(".galaxy-method")).toContainText("This map stays at the shown revision until you refresh it.");
      const originalDisplay = {
        revision: await page.locator(".galaxy-revision").textContent(),
        title: await page.locator(".galaxy-selected-heading h2").textContent(),
        cluster: await page.locator(".galaxy-breadcrumb").textContent(),
        evidence: await page.locator(".galaxy-evidence").textContent(),
      };
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`galaxy-mutation-original-${width}.png`), fullPage: true });

      editorPage = await context.newPage();
      await editorPage.setViewportSize({ width, height: 844 });
      await editorPage.goto(`/wiki/${id}`);
      await editorPage.getByRole("button", { name: "Edit page" }).click();
      const updatedMarkdown = markdown(updatedTitle, shore.group, shore.label, "salt-marsh");
      await editorPage.getByRole("textbox", { name: /Markdown/ }).fill(updatedMarkdown);
      const savedResponse = editorPage.waitForResponse(response =>
        response.url().endsWith(`/api/wiki/pages/${id}`) && response.request().method() === "POST");
      await editorPage.getByRole("button", { name: "Save changes" }).click();
      expect((await savedResponse).ok()).toBe(true);
      await expect(editorPage.locator("article > h1")).toHaveText(updatedTitle);
      await expect(editorPage.getByRole("textbox", { name: /Markdown/ })).toHaveCount(0);
      const actual = await request.get(`/api/wiki/pages/${id}`);
      expect(actual.ok()).toBe(true);
      const saved = await actual.json();
      expect(saved).toMatchObject({ id, title: updatedTitle, markdown: updatedMarkdown, galaxy: shore });
      const freshGraph = await readGraph();
      expect(freshGraph.revision).not.toBe(originalGraph.revision);
      expect(freshGraph.nodes.find(node => node.id === id)).toEqual({ id, title: updatedTitle, galaxy: shore });
      expect(freshGraph.edges.filter(edge => edge.source === id || edge.target === id)).toEqual([
        { source: id, target: "salt-marsh", type: "wikilink" },
      ]);
      await selected(originalTitle, "Archive practice", "field-notebook");
      expect({
        revision: await page.locator(".galaxy-revision").textContent(),
        title: await page.locator(".galaxy-selected-heading h2").textContent(),
        cluster: await page.locator(".galaxy-breadcrumb").textContent(),
        evidence: await page.locator(".galaxy-evidence").textContent(),
      }).toEqual(originalDisplay);

      await primary(page).getByRole("link", { name: "Search", exact: true }).click();
      await expect(page).toHaveURL(/\/search$/);
      const reread = page.waitForResponse(response => response.url().endsWith("/api/wiki/graph"));
      await page.goBack();
      expect((await reread).ok()).toBe(true);
      await expect(page).toHaveURL(new RegExp(`/galaxy\\?page=${id}$`));
      await selected(updatedTitle, shore.label, "salt-marsh");
      await expect(page.locator(".galaxy-evidence a[data-open='field-notebook']")).toHaveCount(0);
      await expect(page.locator(".galaxy-revision")).toContainText(freshGraph.revision!.slice(0, 8));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`galaxy-mutation-updated-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "Refresh snapshot" }).click();
      await expect(page).toHaveURL(new RegExp(`/galaxy\\?page=${id}$`));
      await selected(updatedTitle, shore.label, "salt-marsh");
      await page.reload();
      await selected(updatedTitle, shore.label, "salt-marsh");
      await page.goto(targetURL);
      await selected(updatedTitle, shore.label, "salt-marsh");
      await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article ↗", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${id}$`));
      await expect(page.locator("article > h1")).toHaveText(updatedTitle);
      await page.getByRole("button", { name: "Edit page" }).click();
      await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(updatedMarkdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText(updatedTitle);
      const explore = page.getByRole("link", { name: "Explore connections", exact: true });
      await expect(explore).toHaveAttribute("href", targetURL);
      await explore.click();
      await selected(updatedTitle, shore.label, "salt-marsh");
    } finally {
      await editorPage?.close();
      if (owned) {
        const latest = await request.get(`/api/wiki/pages/${id}`);
        expect(latest.ok(), `read owned page ${id} for cleanup`).toBe(true);
        const cleanup = await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await latest.json()).revision, request_id: randomUUID(),
        } });
        expect(cleanup.ok(), `cleanup owned page ${id}`).toBe(true);
        const restored = await readGraph();
        expect(restored.nodes).toEqual(baseline.nodes);
        expect(restored.edges).toEqual(baseline.edges);
      }
    }
  });
}

