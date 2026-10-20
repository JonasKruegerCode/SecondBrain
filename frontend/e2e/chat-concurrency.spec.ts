import { expect } from "@playwright/test";
import { test } from "./reading-test";
import { abortChatWrites, chatRoot, holdChatWriter, releaseChatWriter, seedChats } from "./chat-storage";

const key = "secondbrain.chat.conversations.v1";
const question = "Initial synthetic question.";
const boundedHistory = () => Array.from({ length: 24 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: `Synthetic history turn ${index}.`,
}));

for (const width of [390, 1440]) {
  test(`bounded chat history keeps one conversation after a successful follow-up (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/chat");
    const messages = boundedHistory();
    await seedChats(page, [
      { id: "bounded", title: "Synthetic bounded history", updated: 1, messages },
    ]);
    await page.reload();
    // Explicit synthetic provider response: this tests browser history, not model quality.
    await page.route("**/api/wiki/chat", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic bounded reply.", sources: [], activity: [] }),
    }));
    await page.getByLabel("Message").fill("Synthetic bounded follow-up.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic bounded reply.");
    await expect(page.locator(".chat-conversation-notice")).toHaveCount(0);
    await expect(page.locator("[data-conversation]")).toHaveCount(1);
    const saved = (await chatRoot(page)).conversations;
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("bounded");
    expect(saved[0].messages).toEqual([
      ...messages.slice(2),
      { role: "user", content: "Synthetic bounded follow-up." },
      { role: "assistant", content: "Synthetic bounded reply.", sources: [], activity: [] },
    ]);
    await page.reload();
    await expect(page.locator(".chat-message")).toHaveCount(24);
    await expect(page.locator("[data-conversation]")).toHaveCount(1);
    await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic bounded reply.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`chat-bounded-history-${width}.png`), fullPage: true });
  });
}

test("bounded chat history keeps its original conversation after transaction abort after put success across SPA navigation", async ({ page }) => {
  await page.goto("/chat");
  const messages = boundedHistory();
  await seedChats(page, [
    { id: "bounded", title: "Synthetic bounded history", updated: 1, messages },
  ]);
  await page.reload();
  // Explicit synthetic failure and recovery responses; no real model is called.
  let requests = 0;
  await page.route("**/api/wiki/chat", route => {
    requests++;
    return route.fulfill({
      status: requests === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(requests === 1
        ? { message: "Synthetic provider failure." }
        : { answer: "Synthetic SPA recovery reply.", sources: [], activity: [] }),
    });
  });
  await abortChatWrites(page);
  await page.getByLabel("Message").fill("Synthetic SPA unsaved question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-error")).toContainText("Synthetic provider failure.");
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A growing collection", exact: true })).toBeVisible();
  await navigation.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-message.user").last()).toContainText("Synthetic SPA unsaved question.");
  expect(await page.evaluate(() => (window as any).chatPutSucceeded)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic SPA recovery reply.");
  await expect(page.locator(".chat-conversation-notice")).toHaveCount(0);
  const saved = (await chatRoot(page)).conversations;
  expect(saved).toHaveLength(1);
  expect(saved[0].id).toBe("bounded");
  expect(saved[0].messages).toEqual([
    ...messages.slice(2),
    { role: "user", content: "Synthetic SPA unsaved question." },
    { role: "assistant", content: "Synthetic SPA recovery reply.", sources: [], activity: [] },
  ]);
  expect(requests).toBe(2);
  await page.reload();
  await expect(page.locator("[data-conversation]")).toHaveCount(1);
  await expect(page.locator(".chat-message")).toHaveCount(24);
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic SPA recovery reply.");
});

test("bounded chat history recovery preserves a concurrent saved branch", async ({ page, context }) => {
  await page.goto("/chat");
  const messages = boundedHistory();
  await seedChats(page, [
    { id: "bounded", title: "Synthetic bounded history", updated: 1, messages },
  ]);
  await page.reload();
  // Both responses are synthetic; no real provider request is made by this test.
  let requests = 0;
  await page.route("**/api/wiki/chat", route => {
    requests++;
    return route.fulfill({
      status: requests === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(requests === 1
        ? { message: "Synthetic provider failure." }
        : { answer: "Synthetic recovery reply.", sources: [], activity: [] }),
    });
  });
  await abortChatWrites(page);
  await page.getByLabel("Message").fill("Synthetic unsaved bounded question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-error")).toContainText("Synthetic provider failure.");
  const other = await context.newPage();
  await other.goto("/chat");
  const concurrent = [
    ...messages.slice(2),
    { role: "user", content: "Synthetic concurrent bounded question." },
    { role: "assistant", content: "Synthetic concurrent bounded answer." },
  ];
  {
    const saved = (await chatRoot(other)).conversations;
    saved[0].messages = concurrent;
    saved[0].updated++;
    await seedChats(other, saved);
  }
  expect(await page.evaluate(() => (window as any).chatPutSucceeded)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic recovery reply.");
  const saved = (await chatRoot(page)).conversations;
  expect(saved).toHaveLength(2);
  expect(saved.find((item: { id: string }) => item.id === "bounded").messages).toEqual(concurrent);
  const local = saved.find((item: { id: string }) => item.id !== "bounded");
  expect(local.messages).toEqual([
    ...messages.slice(2),
    { role: "user", content: "Synthetic unsaved bounded question." },
    { role: "assistant", content: "Synthetic recovery reply.", sources: [], activity: [] },
  ]);
  expect(requests).toBe(2);
  await page.reload();
  await expect(page.locator("[data-conversation]")).toHaveCount(2);
  await expect(page.locator(".chat-message")).toHaveCount(24);
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic recovery reply.");
  await page.locator('[data-conversation="bounded"]').click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic concurrent bounded answer.");
  await other.close();
});

for (const width of [1440, 390]) {
  test(`stale chat retains newer saved turns (${width})`, async ({ page, context }, testInfo) => {
    await page.goto("/chat");
    await seedChats(page, [
      { id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] },
    ]);
    await page.reload();
    const other = await context.newPage();
    await other.goto("/chat");
    const advance = async (withQuestion = false) => {
      const saved = (await chatRoot(other)).conversations;
      if (withQuestion) saved[0].messages.push({ role: "user", content: "Question sent in the other tab." });
      saved[0].messages.push({ role: "assistant", content: "New answer saved in the other tab." });
      saved[0].updated++;
      await seedChats(other, saved);
    };
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
  await seedChats(page, [
    { id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] },
  ]);
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
  {
    const saved = (await chatRoot(other)).conversations;
    saved[0].messages.push({ role: "user", content: "Concurrent newer question." });
    saved[0].updated++;
    await seedChats(other, saved);
  }
  release();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic delayed adapter answer.");
  await expect(page.locator(".chat-conversation-notice")).toContainText("both versions are kept");
  const saved = (await chatRoot(page)).conversations;
  expect(saved).toHaveLength(2);
  expect(saved.find((item: { id: string }) => item.id === "shared").messages.at(-1).content).toBe("Concurrent newer question.");
  expect(saved.find((item: { id: string }) => item.id !== "shared").messages.map((item: { content: string }) => item.content)).toEqual([
    question, "Synthetic delayed adapter answer.",
  ]);
  await page.reload();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic delayed adapter answer.");
  await other.close();
});

for (const finish of ["send", "retry", "new", "select"] as const) {
  test(`storage recovery retains divergent saved and unsaved branches (${finish})`, async ({ page, context }) => {
    await page.goto("/chat");
    await seedChats(page, [
      { id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] },
    ]);
    await page.reload();
    await abortChatWrites(page);
    await page.getByLabel("Message").fill("Unsaved local question.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    const other = await context.newPage();
    await other.goto("/chat");
    {
      const saved = (await chatRoot(other)).conversations;
      saved[0].messages.push({ role: "user", content: "Concurrent saved question." });
      saved[0].updated++;
      await seedChats(other, saved);
    }
    expect(await page.evaluate(() => (window as any).chatPutSucceeded)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
    if (finish === "send") {
      await page.getByLabel("Message").fill("Local recovery follow-up.");
      await page.getByRole("button", { name: "Send" }).click();
    } else if (finish === "new") await page.getByRole("button", { name: "New", exact: true }).click();
    else if (finish === "select") await page.locator('[data-conversation="shared"]').click();
    else await page.getByRole("button", { name: "Retry", exact: true }).click();
    if (finish !== "new") await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.locator(".chat-conversation-notice")).toContainText("unsaved messages");
    const saved = (await chatRoot(page)).conversations;
    expect(saved).toHaveLength(finish === "new" ? 3 : 2);
    expect(saved.find((item: { id: string }) => item.id === "shared").messages.at(-1).content).toBe("Concurrent saved question.");
    expect(saved.find((item: { id: string; messages: unknown[] }) => item.id !== "shared" && item.messages.length).messages.map((item: { content: string }) => item.content)).toEqual([
      question, "Unsaved local question.", ...(finish === "send" ? ["Local recovery follow-up."] : []),
    ]);
    await page.reload();
    await expect(page.locator(".chat-message.user")).toHaveCount(finish === "new" ? 0 : finish === "send" ? 3 : 2);
    await other.close();
  });
}


for (const operation of ["new", "delete"] as const) {
  test(`overlapping native tab ${operation} and new retain exact committed IDs`, async ({ page, context }) => {
    const peer = await context.newPage();
    let requests = 0;
    context.on("request", request => { if (new URL(request.url()).pathname === "/api/wiki/chat") requests++; });
    await Promise.all([page.goto("/chat"), peer.goto("/chat")]);
    for (let trial = 0; trial < 20; trial++) {
      await seedChats(page, operation === "new" ? [] : [{ id: "shared", title: question, updated: 1,
        messages: [{ role: "user", content: question }] }]);
      await Promise.all([page.reload(), peer.reload()]);
      await Promise.all([expect(page.locator('[data-action="new"]')).toBeEnabled(), expect(peer.locator('[data-action="new"]')).toBeEnabled()]);
      await Promise.all([
        page.evaluate(operation => document.querySelector<HTMLButtonElement>(`[data-action="${operation}"]`)!.click(), operation),
        peer.evaluate(() => document.querySelector<HTMLButtonElement>('[data-action="new"]')!.click()),
      ]);
      await Promise.all([expect(page.locator('[data-action="new"]')).toBeEnabled(), expect(peer.locator('[data-action="new"]')).toBeEnabled()]);
      const ids = await Promise.all([page.locator("[data-conversation].active").getAttribute("data-conversation"), peer.locator("[data-conversation].active").getAttribute("data-conversation")]);
      const committed = await chatRoot(page);
      const actual = committed.conversations.map(item => item.id).sort();
      if (operation === "new") expect(actual, `trial ${trial}`).toEqual([...ids].sort());
      else {
        expect(actual, `trial ${trial}`).not.toContain("shared");
        expect(actual, `trial ${trial}`).toContain(ids[1]);
        expect(committed.tombstones.map(item => item.id), `trial ${trial}`).toContain("shared");
      }
      const fresh = await context.newPage();
      await fresh.goto("/?overview=1");
      expect(await chatRoot(fresh), `fresh reader ${trial}`).toEqual(committed);
      await Promise.all([page.reload(), peer.reload()]);
      expect(await chatRoot(page), `writer reload ${trial}`).toEqual(committed);
      expect(await chatRoot(peer), `peer reload ${trial}`).toEqual(committed);
      await fresh.close();
    }
    expect(requests).toBe(0);
    await peer.close();
  });
}

test("a queued native writer reads the preceding atomic root publication", async ({ page, context }) => {
  await page.goto("/chat");
  await seedChats(page, [{ id: "shared", title: question, updated: 1, messages: [{ role: "user", content: question }] }]);
  await page.reload();
  const peer = await context.newPage();
  await peer.goto("/?overview=1");
  await holdChatWriter(peer, { version: 1, conversations: [{ id: "peer", title: question, updated: 3, messages: [] }], tombstones: [{ id: "shared", deleted: 2 }] });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeDisabled();
  await releaseChatWriter(peer);
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  const active = await page.locator("[data-conversation].active").getAttribute("data-conversation");
  const root = await chatRoot(page);
  expect(root.conversations.map(item => item.id).sort()).toEqual([active, "peer"].sort());
  expect(root.tombstones).toEqual([{ id: "shared", deleted: 2 }]);
  await page.reload();
  await expect(page.locator('[data-conversation="shared"]')).toHaveCount(0);
  await expect(page.locator('[data-conversation="peer"]')).toHaveCount(1);
  await peer.close();
});

test("a failed native preflight retains the unsent draft and can recover", async ({ page }) => {
  await page.goto("/chat");
  const initial = await chatRoot(page);
  const draftId = await page.locator("[data-conversation].active").getAttribute("data-conversation");
  let requests = 0;
  page.on("request", request => { if (request.url().endsWith("/api/wiki/chat")) requests++; });
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === "secondbrain.chat.v1") throw new DOMException("Synthetic unavailable database", "InvalidStateError");
      return original.apply(this, args);
    };
    window.addEventListener("synthetic-storage-ready", () => { IDBDatabase.prototype.transaction = original; }, { once: true });
  });
  await page.getByLabel("Message").fill("Synthetic unsent question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-error")).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveValue("Synthetic unsent question.");
  await expect(page.getByLabel("Message")).toBeEnabled();
  expect(requests).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  expect(await chatRoot(page)).toEqual(initial);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-error")).toHaveCount(0);
  const recovered = (await chatRoot(page)).conversations;
  expect(recovered).toHaveLength(2);
  expect(recovered.map(item => item.id)).toContain(draftId);
  expect(recovered.every(item => item.messages.length === 0)).toBe(true);
  await page.locator(`[data-conversation="${draftId}"]`).click();
  await expect(page.getByLabel("Message")).toHaveValue("Synthetic unsent question.");
  expect(requests).toBe(0);
});

test("native IndexedDB works without Web Locks", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  await page.goto("/chat");
  await expect(page.locator(".chat-lock-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByLabel("Message")).toBeEnabled();
  expect((await chatRoot(page)).conversations).toHaveLength(1);
  await page.reload();
  await expect(page.locator("[data-conversation]")).toHaveCount(1);
});

test("leaving chat aborts a queued native writer before publication", async ({ page, context }) => {
  await page.goto("/chat");
  const before = await chatRoot(page);
  const peer = await context.newPage();
  await peer.goto("/?overview=1");
  await holdChatWriter(peer);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeDisabled();
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".chat-page")).toHaveCount(0);
  await releaseChatWriter(peer);
  expect(await chatRoot(peer)).toEqual(before);
  await navigation.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  expect(await chatRoot(page)).toEqual(before);
  await peer.close();
});

test("concurrent initial migration is atomic and empty root never reimports legacy chats", async ({ page, context }) => {
  await page.goto("/?overview=1");
  await page.evaluate(({ key, question }) => {
    localStorage.setItem(key, JSON.stringify([{ id: "legacy", title: question, updated: 1, messages: [{ role: "user", content: question }] }, { id: "removed", title: question, updated: 1, messages: [] }]));
    localStorage.setItem("secondbrain.chat.deleted.v1", JSON.stringify([{ id: "removed", deleted: 2 }]));
  }, { key, question });
  const peer = await context.newPage();
  await Promise.all([page.goto("/chat"), peer.goto("/chat")]);
  await Promise.all([expect(page.locator('[data-conversation="legacy"]')).toHaveCount(1), expect(peer.locator('[data-conversation="legacy"]')).toHaveCount(1)]);
  const migrated = await chatRoot(page);
  expect(migrated.conversations.map(item => item.id)).toEqual(["legacy"]);
  expect(migrated.tombstones).toEqual([{ id: "removed", deleted: 2 }]);
  expect(await chatRoot(peer)).toEqual(migrated);
  await seedChats(page, []);
  await Promise.all([page.reload(), peer.reload()]);
  await expect(page.locator('[data-conversation="legacy"]')).toHaveCount(0);
  await expect(peer.locator('[data-conversation="legacy"]')).toHaveCount(0);
  await expect(page.locator("[data-conversation]")).toHaveCount(1);
  await expect(peer.locator("[data-conversation]")).toHaveCount(1);
  await expect(page.locator(".chat-message")).toHaveCount(0);
  await expect(peer.locator(".chat-message")).toHaveCount(0);
  expect(await chatRoot(page)).toEqual({ version: 1, conversations: [], tombstones: [] });
  await peer.close();
});

for (const failure of ["legacy-read", "abort-after-put"] as const) {
  test(`failed first migration (${failure}) leaves no root marker and can retry`, async ({ page }) => {
    await page.goto("/?overview=1");
    await page.evaluate(({ key, question }) => {
      localStorage.setItem(key, JSON.stringify([{ id: "legacy-retry", title: question, updated: 1,
        messages: [{ role: "user", content: question }] }]));
    }, { key, question });
    if (failure === "legacy-read") {
      await page.evaluate(key => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (name) {
          if (name === key) throw new DOMException("Synthetic legacy read failure", "SecurityError");
          return original.call(this, name);
        };
        window.addEventListener("synthetic-storage-ready", () => {
          Storage.prototype.getItem = original;
        }, { once: true });
      }, key);
    } else await abortChatWrites(page);
    const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
    await navigation.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
    await expect(page.locator(".chat-storage-notice").filter({ hasText: "Browser storage is unavailable" })).toBeVisible();
    expect(await chatRoot(page)).toBeUndefined();
    if (failure === "abort-after-put") expect(await page.evaluate(() => (window as any).chatPutSucceeded)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
    await navigation.getByRole("link", { name: "Home", exact: true }).click();
    await navigation.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.locator('[data-conversation="legacy-retry"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
    const root = await chatRoot(page);
    expect(root.conversations.map(item => item.id)).toEqual(["legacy-retry"]);
    expect(root.conversations[0].messages).toEqual([{ role: "user", content: question }]);
    expect(root.tombstones).toEqual([]);
  });
}

test("an answer survives native abort after put success across SPA navigation and durable recovery", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  const before = await chatRoot(page);
  const originalId = await page.locator("[data-conversation].active").getAttribute("data-conversation");
  let requests = 0;
  await page.route("**/api/wiki/chat", route => {
    requests++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      answer: "Synthetic answer retained after transaction abort.", sources: [], activity: [],
    }) });
  });
  await abortChatWrites(page);
  await page.getByLabel("Message").fill("Synthetic question retained after transaction abort.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer retained after transaction abort.");
  expect(await page.evaluate(() => (window as any).chatPutSucceeded)).toBe(true);
  await expect(page.locator(".chat-storage-notice").filter({ hasText: "Browser storage is unavailable" })).toBeVisible();
  expect(await chatRoot(page)).toEqual(before);
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".chat-page")).toHaveCount(0);
  await navigation.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  await expect(page.locator(".chat-message.user")).toContainText("Synthetic question retained after transaction abort.");
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer retained after transaction abort.");
  await expect(page.locator(".chat-storage-notice").filter({ hasText: "Browser storage is unavailable" })).toBeVisible();
  expect(await chatRoot(page)).toEqual(before);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  const committed = await chatRoot(page);
  expect(committed.conversations).toHaveLength(2);
  expect(committed.conversations.find(item => item.id === originalId)?.messages).toEqual([
    { role: "user", content: "Synthetic question retained after transaction abort." },
    { role: "assistant", content: "Synthetic answer retained after transaction abort.", sources: [], activity: [] },
  ]);
  await page.reload();
  await page.locator(`[data-conversation="${originalId}"]`).click();
  await expect(page.locator(".chat-message.user")).toContainText("Synthetic question retained after transaction abort.");
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer retained after transaction abort.");
  await expect(page.locator(".chat-storage-notice").filter({ hasText: "Browser storage is unavailable" })).toHaveCount(0);
  expect(requests).toBe(1);
});

for (const recovery of ["same", "branch", "deleted"] as const) {
  test(`a received answer survives a publication read outage (${recovery})`, async ({ page, context }, info) => {
    await page.goto("/chat");
    const peer = await context.newPage();
    await peer.goto("/?overview=1");
    const history = boundedHistory();
    await seedChats(page, [{ id: "publication", title: "Synthetic publication history", updated: 1, messages: history }]);
    await page.reload();
    let arrived!: () => void;
    let release!: () => void;
    const requested = new Promise<void>(resolve => { arrived = resolve; });
    const response = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await page.route("**/api/wiki/chat", async route => {
      requests++;
      arrived();
      await response;
      await route.fulfill({ json: { answer: "Synthetic received answer during read outage.", sources: [], activity: [] } });
    });
    await page.getByLabel("Message").fill("Synthetic publication question.");
    await page.getByRole("button", { name: "Send" }).click();
    await requested;
    const before = await chatRoot(peer);
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === "secondbrain.chat.v1") throw new DOMException("Synthetic publication read outage", "InvalidStateError");
        return original.apply(this, args);
      };
      window.addEventListener("synthetic-storage-ready", () => { IDBDatabase.prototype.transaction = original; }, { once: true });
    });
    release();
    await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic received answer during read outage.");
    await expect(page.locator(".chat-error")).toHaveCount(0);
    await expect(page.locator(".chat-storage-notice").filter({ hasText: "Browser storage is unavailable" })).toBeVisible();
    expect(await chatRoot(peer)).toEqual(before);
    if (recovery === "same") {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`received-answer-session-${width}.png`), fullPage: true });
      }
    }
    const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
    await navigation.getByRole("link", { name: "Home", exact: true }).click();
    await navigation.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.getByLabel("Message")).toBeEnabled();
    await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic received answer during read outage.");
    const expectedLocal = [...history.slice(2), { role: "user", content: "Synthetic publication question." },
      { role: "assistant", content: "Synthetic received answer during read outage.", sources: [], activity: [] }];
    if (recovery === "branch") {
      before.conversations[0].messages = [...before.conversations[0].messages.slice(1),
        { role: "user", content: "Synthetic concurrent saved question." }];
      before.conversations[0].updated++;
      await seedChats(peer, before.conversations);
    } else if (recovery === "deleted") {
      await seedChats(peer, [], [{ id: "publication", deleted: Date.now() }]);
    }
    await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByLabel("Message")).toBeEnabled();
    const saved = await chatRoot(peer);
    if (recovery === "deleted") {
      expect(saved.conversations).toHaveLength(1);
      expect(saved.conversations[0].messages).toEqual([]);
      expect(saved.conversations.some(item => item.id === "publication")).toBe(false);
      expect(saved.tombstones.map(item => item.id)).toContain("publication");
    } else {
      expect(saved.conversations).toHaveLength(recovery === "same" ? 2 : 3);
      const retained = saved.conversations.find(item => item.messages.at(-1)?.content === "Synthetic received answer during read outage.");
      expect(retained.messages).toEqual(expectedLocal);
      expect(retained.id === "publication").toBe(recovery === "same");
      if (recovery === "branch") expect(saved.conversations.find(item => item.id === "publication").messages).toEqual(before.conversations[0].messages);
      await page.reload();
      await page.locator(`[data-conversation="${retained.id}"]`).click();
      await expect(page.locator(".chat-message")).toHaveCount(24);
      await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic received answer during read outage.");
      await expect(page.locator(".chat-error")).toHaveCount(0);
    }
    expect(requests).toBe(1);
    await peer.close();
  });
}

for (const finish of ["stop", "leave"] as const) {
  test(`a received answer waiting for storage respects ${finish}`, async ({ page, context }) => {
    await page.goto("/chat");
    const peer = await context.newPage();
    await peer.goto("/?overview=1");
    let arrived!: () => void;
    let release!: () => void;
    const requested = new Promise<void>(resolve => { arrived = resolve; });
    const response = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await page.route("**/api/wiki/chat", async route => {
      requests++;
      arrived();
      await response;
      await route.fulfill({ json: { answer: "Synthetic answer cancelled before publication.", sources: [], activity: [] } });
    });
    await page.getByLabel("Message").fill("Synthetic queued publication question.");
    await page.getByRole("button", { name: "Send" }).click();
    await requested;
    await holdChatWriter(peer);
    await page.evaluate(() => {
      (window as any).publicationStarted = false;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = original.apply(this, args);
        if (this.name === "secondbrain.chat.v1") (window as any).publicationStarted = true;
        return transaction;
      };
    });
    release();
    await page.waitForFunction(() => (window as any).publicationStarted === true);
    if (finish === "stop") await page.getByRole("button", { name: "Stop reply", exact: true }).click();
    else await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Home", exact: true }).click();
    await releaseChatWriter(peer);
    const saved = await chatRoot(peer);
    expect(saved.conversations.flatMap(item => item.messages).some(item => item.role === "assistant")).toBe(false);
    if (finish === "leave") await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
    expect(requests).toBe(1);
    await peer.close();
  });
}
