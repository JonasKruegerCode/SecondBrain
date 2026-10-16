import { expect } from "@playwright/test";
import { test } from "./reading-test";

const key = "secondbrain.chat.conversations.v1";
const question = "Initial synthetic question.";
for (const width of [1440, 390]) {
  test(`stale chat retains newer saved turns (${width})`, async ({ page, context }, testInfo) => {
    await page.goto("/chat");
    await page.evaluate(({ key, question }) => localStorage.setItem(key, JSON.stringify([
      { id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] },
    ])), { key, question });
    await page.reload();
    const other = await context.newPage();
    await other.goto("/chat");
    const advance = (withQuestion = false) => other.evaluate(({ key, withQuestion }) => {
      const saved = JSON.parse(localStorage.getItem(key)!);
      if (withQuestion) saved[0].messages.push({ role: "user", content: "Question sent in the other tab." });
      saved[0].messages.push({ role: "assistant", content: "New answer saved in the other tab." });
      saved[0].updated++;
      localStorage.setItem(key, JSON.stringify(saved));
    }, { key, withQuestion });
    // First obtain a real unconfigured-provider error, then finish elsewhere.
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".chat-error")).toContainText("retry when ready");
    await advance();
    let requests = 0;
    page.on("request", request => { if (request.url().endsWith("/api/wiki/chat")) requests++; });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(requests).toBe(0);
    // Leave this view stale again before submitting a follow-up.
    await advance(true);
    await page.setViewportSize({ width, height: 900 });
    const requested = page.waitForRequest("**/api/wiki/chat");
    await page.getByLabel("Message").fill("Follow-up from stale tab.");
    await page.getByRole("button", { name: "Send" }).click();
    expect((await requested).postDataJSON().messages.map((item: { content: string }) => item.content)).toEqual([
      question, "New answer saved in the other tab.", "Question sent in the other tab.", "New answer saved in the other tab.", "Follow-up from stale tab.",
    ]);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.locator(".chat-conversation-notice")).toContainText("latest saved messages");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`chat-concurrent-${width}.png`), fullPage: true });
    await page.reload();
    await expect(page.locator(".chat-message")).toHaveCount(5);
    await other.close();
  });
}

test("late synthetic reply preserves both concurrent transcripts", async ({ page, context }) => {
  await page.goto("/chat");
  await page.evaluate(({ key, question }) => localStorage.setItem(key, JSON.stringify([
    { id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] },
  ])), { key, question });
  await page.reload();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/wiki/chat", async route => {
    await hold;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      answer: "Synthetic delayed adapter answer.", sources: [], activity: [],
    }) });
  });
  const requested = page.waitForRequest("**/api/wiki/chat");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await requested;
  const other = await context.newPage();
  await other.goto("/chat");
  await other.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved[0].messages.push({ role: "user", content: "Concurrent newer question." });
    saved[0].updated++;
    localStorage.setItem(key, JSON.stringify(saved));
  }, key);
  release();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic delayed adapter answer.");
  await expect(page.locator(".chat-conversation-notice")).toContainText("both versions are kept");
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(saved).toHaveLength(2);
  expect(saved.find((item: { id: string }) => item.id === "shared").messages.at(-1).content).toBe("Concurrent newer question.");
  expect(saved.find((item: { id: string }) => item.id !== "shared").messages.map((item: { content: string }) => item.content)).toEqual([
    question, "Synthetic delayed adapter answer.",
  ]);
  await page.reload();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic delayed adapter answer.");
  await other.close();
});

for (const finish of ["send", "retry"] as const) {
  test(`storage recovery retains divergent saved and unsaved branches (${finish})`, async ({ page, context }) => {
    await page.goto("/chat");
    await page.evaluate(({ key, question }) => localStorage.setItem(key, JSON.stringify([
      { id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] },
    ])), { key, question });
    await page.reload();
    await page.evaluate(key => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException("Synthetic full storage", "QuotaExceededError");
        return set.call(this, name, value);
      };
      window.addEventListener("synthetic-storage-ready", () => { Storage.prototype.setItem = set; }, { once: true });
    }, key);
    await page.getByLabel("Message").fill("Unsaved local question.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    const other = await context.newPage();
    await other.goto("/chat");
    await other.evaluate(key => {
      const saved = JSON.parse(localStorage.getItem(key)!);
      saved[0].messages.push({ role: "user", content: "Concurrent saved question." });
      saved[0].updated++;
      localStorage.setItem(key, JSON.stringify(saved));
    }, key);
    await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
    if (finish === "send") {
      await page.getByLabel("Message").fill("Local recovery follow-up.");
      await page.getByRole("button", { name: "Send" }).click();
    } else await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.locator(".chat-conversation-notice")).toContainText("unsaved messages");
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
    expect(saved).toHaveLength(2);
    expect(saved.find((item: { id: string }) => item.id === "shared").messages.at(-1).content).toBe("Concurrent saved question.");
    expect(saved.find((item: { id: string }) => item.id !== "shared").messages.map((item: { content: string }) => item.content)).toEqual([
      question, "Unsaved local question.", ...(finish === "send" ? ["Local recovery follow-up."] : []),
    ]);
    await page.reload();
    await expect(page.locator(".chat-message.user")).toHaveCount(finish === "send" ? 3 : 2);
    await other.close();
  });
}
