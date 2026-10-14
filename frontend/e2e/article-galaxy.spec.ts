import { test, expect, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Graph } from "../src/galaxy";

const contextualURL = "/galaxy?page=field-notebook";
const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });
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
