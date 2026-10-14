import { test, expect, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

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
    await explore.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${contextualURL.replace("?", "\\?")}$`));
    await selectedNotebook(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`article-galaxy-${width}.png`), fullPage: true });
    await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article", exact: true }).click();
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

test("missing and genuinely deleted contextual targets show an honest overview", async ({ page, request }) => {
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
    const created = await request.post(`/api/wiki/pages/${id}`, { data: {
      markdown: "# Synthetic contextual page\n\nA public test note linked to [[field-notebook]].",
      base_revision: null, request_id: randomUUID(),
    } });
    expect(created.ok()).toBe(true);
    revision = (await created.json()).revision;
    await page.goto(`/wiki/${id}`);
    const explore = page.getByRole("link", { name: "Explore connections", exact: true });
    await expect(explore).toHaveAttribute("href", `/galaxy?page=${encodeURIComponent(id)}`);
    await explore.click();
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Synthetic contextual page");
    await expect(page.locator(".galaxy-evidence")).toContainText("Field notebook");
    const deleted = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: revision, request_id: randomUUID() } });
    expect(deleted.ok()).toBe(true);
    revision = null;
    // Refresh must read the actual new snapshot, not the old selected node.
    await page.getByRole("link", { name: "Refresh snapshot" }).click();
    await expect(page).toHaveURL(new RegExp(`/galaxy\\?page=${id}$`));
    await missingOverview();
    await page.goto(`/galaxy?page=${encodeURIComponent(id)}`);
    await missingOverview();
  } finally {
    if (revision !== null) {
      const cleanup = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: revision, request_id: randomUUID() } });
      expect(cleanup.ok(), `cleanup synthetic page ${id}`).toBe(true);
    }
  }
});
