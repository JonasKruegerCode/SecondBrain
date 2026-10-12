import { test, expect } from "@playwright/test";

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
