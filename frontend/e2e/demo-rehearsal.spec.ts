import { expect } from "@playwright/test";
import { test } from "./reading-test";
import { randomUUID } from "node:crypto";

test("galaxy return rereads the graph after its selected page is deleted", async ({ page, request }) => {
  const id = `galaxy-return-${randomUUID()}`;
  const created = await request.post(`/api/wiki/pages/${id}`, { data: {
    markdown: "# Temporary return star\nA synthetic isolated page.",
    base_revision: null, request_id: randomUUID(),
  } });
  expect(created.ok()).toBe(true);
  const receipt = await created.json();
  try {
    await page.goto("/galaxy");
    await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(id);
    await page.locator(`.galaxy-page[data-node="${id}"]`).click();
    await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article" }).click();
    await expect(page.locator("article h1")).toHaveText("Temporary return star");
    const removed = await request.delete(`/api/wiki/pages/${id}`, { data: {
      base_revision: receipt.revision, request_id: randomUUID(),
    } });
    expect(removed.ok()).toBe(true);
    await page.goBack();
    await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
    await expect(page.locator(`.galaxy-page[data-node="${id}"]`)).toHaveCount(0);
    await expect(page.locator(".galaxy-cluster").filter({ hasText: "Archive practice" })).toBeVisible();
    await expect(page.locator(".galaxy")).toBeVisible();
  } finally {
    const current = await request.get(`/api/wiki/pages/${id}`);
    if (current.ok()) {
      const cleanup = await request.delete(`/api/wiki/pages/${id}`, { data: {
        base_revision: (await current.json()).revision, request_id: randomUUID(),
      } });
      expect(cleanup.ok()).toBe(true);
    } else expect(current.status()).toBe(404);
  }
});

for (const width of [390, 1440]) {
  test(`galaxy article round trip restores its visit (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    for (const list of [false, true]) {
      await page.goto("/galaxy");
      await page.locator(".galaxy-cluster").filter({ hasText: "Archive practice" }).click();
      await page.locator('.galaxy-page[data-node="field-notebook"]').click();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      const map = page.locator(".galaxy-stage svg");
      await page.locator(".galaxy-stage").scrollIntoViewIfNeeded();
      const stage = (await page.locator(".galaxy-stage").boundingBox())!;
      const unpanned = await map.getAttribute("viewBox");
      await page.mouse.move(stage.x + 12, stage.y + stage.height / 2);
      await page.mouse.down();
      await page.mouse.move(stage.x + 62, stage.y + stage.height / 2 + 25, { steps: 5 });
      await page.mouse.up();
      await expect(map).not.toHaveAttribute("viewBox", unpanned!);
      const viewBox = await map.getAttribute("viewBox");
      if (list) await page.getByRole("button", { name: "List view", exact: true }).click();
      await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article" }).click();
      await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
      await expect(page.locator("article h1")).toHaveText("Field notebook");
      await page.goBack();
      await expect(page).toHaveURL(/\/galaxy$/);
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
      await expect(page.locator(".galaxy-breadcrumb")).toContainText("Archive practice");
      if (list) await expect(page.locator(".galaxy-stage")).toBeHidden();
      else await expect(map).toHaveAttribute("viewBox", viewBox!);
      await page.screenshot({ path: testInfo.outputPath(`galaxy-return-${width}-${list ? "list" : "map"}.png`), fullPage: true });
      if (!list) {
        const sidebar = page.locator(".galaxy-sidebar-content");
        await sidebar.evaluate(element => { element.scrollTop = 180; });
        const offset = await sidebar.evaluate(element => element.scrollTop);
        expect(offset).toBeGreaterThan(0);
        await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Search", exact: true }).click();
        await expect(page).toHaveURL(/\/search$/);
        await page.goBack();
        await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
        await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBe(offset);
        await expect(map).toHaveAttribute("viewBox", viewBox!);
        await page.screenshot({ path: testInfo.outputPath(`galaxy-offset-return-${width}-viewport.png`) });
      }
      const find = page.getByRole("searchbox", { name: "Find a page in this snapshot" });
      await find.fill("tide");
      const matches = await page.locator(".galaxy-page").count();
      expect(matches).toBeGreaterThan(0);
      await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Search", exact: true }).click();
      await expect(page).toHaveURL(/\/search$/);
      await page.goBack();
      await expect(find).toHaveValue("tide");
      await expect(page.locator(".galaxy-page")).toHaveCount(matches);
      if (list) await expect(page.locator(".galaxy-stage")).toBeHidden();
      else await expect(map).toHaveAttribute("viewBox", viewBox!);
      await find.fill("");
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
      // Refresh creates an adjacent visit with the same URL. Back/Forward must
      // still distinguish its overview from the preceding selected-page view.
      await page.getByRole("link", { name: "Refresh snapshot" }).click();
      await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
      await page.goBack();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
      if (list) await expect(page.locator(".galaxy-stage")).toBeHidden();
      else await expect(map).toHaveAttribute("viewBox", viewBox!);
      await page.goForward();
      await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
      // A fresh explicit visit still opens the overview instead of reusing the
      // last Galaxy state merely because its URL matches a previous entry.
      await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Home", exact: true }).click();
      await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Galaxy", exact: true }).click();
      await expect(page.locator(".galaxy-selected-heading")).toHaveCount(0);
      await expect(page.locator(".galaxy-cluster").filter({ hasText: "Archive practice" })).toBeVisible();
      await expect(page.locator(".galaxy-stage")).toBeVisible();
    }
  });
}

// A single rehearsal of the public fictional atlas against the managed API.
// The demo deliberately has no model provider: its real 503 is the chat outcome.
test("rehearse a connected atlas journey and preserve an unanswered question", async ({ page }, testInfo) => {
  test.setTimeout(30_000);
  let chatCalls = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/wiki/chat" && request.method() === "POST") chatCalls++;
  });

  await page.goto("/?overview=1");
  await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
  await page.locator('.grid a[href="/wiki/mira-quill"]').click();
  await expect(page.locator("article h1")).toHaveText("Mira Quill — fictional archivist");
  await expect(page.locator(".prose")).toContainText("Mira records uncertainty explicitly");
  await page.locator(".prose").getByRole("link", { name: "archive method", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/archive-method$/);
  await expect(page.locator("article h1")).toHaveText("Archive method: observation, source, interpretation");

  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill("Field notebook");
  const searchResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/wiki/search" && response.request().method() === "GET");
  await page.getByRole("button", { name: "Search" }).click();
  expect((await searchResponse).ok()).toBe(true);
  await page.locator('#results a[href="/wiki/field-notebook"]').click();
  await expect(page.locator("article h1")).toHaveText("Field notebook");
  await expect(page.locator(".prose")).toContainText("All entries below are invented examples");
  await page.screenshot({ path: testInfo.outputPath("rehearsal-searched-article.png"), fullPage: true });

  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Galaxy", exact: true }).click();
  await page.locator(".galaxy-cluster").filter({ hasText: "Archive practice" }).click();
  await expect(page.locator(".galaxy-breadcrumb")).toContainText("Archive practice");
  await page.locator('.galaxy-star[data-node="field-notebook"]').click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
  const evidence = page.locator(".galaxy-evidence li").filter({
    has: page.locator('button[data-node="archive-method"]'),
  }).first();
  await expect(evidence).toContainText("Explicit wikilink");
  await expect(evidence.locator('[aria-label="links to"]')).toBeVisible();
  await evidence.locator('button[data-node="archive-method"]').click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Archive method: observation, source, interpretation");
  await page.screenshot({ path: testInfo.outputPath("rehearsal-link-evidence.png"), fullPage: true });
  await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article" }).click();
  await expect(page).toHaveURL(/\/wiki\/archive-method$/);

  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Chat", exact: true }).click();
  const question = "How does the archive method distinguish a source from an interpretation?";
  await page.getByLabel("Message", { exact: true }).fill(question);
  const chatResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/wiki/chat" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send" }).click();
  const unavailable = await chatResponse;
  expect(unavailable.status()).toBe(503);
  expect(await unavailable.json()).toMatchObject({ error: "chat_unavailable" });
  await expect(page.getByRole("alert")).toContainText("not configured");
  await expect(page.locator(".chat-message.user p")).toHaveText(question);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("rehearsal-provider-unconfigured.png"), fullPage: true });

  await page.reload();
  await expect(page.locator(".chat-message.user p")).toHaveText(question);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(chatCalls).toBe(1);
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await expect(page.locator(".chat-message")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(page.locator(".chat-history-list")).not.toContainText(question.slice(0, 54));
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  expect(chatCalls).toBe(1);
});
