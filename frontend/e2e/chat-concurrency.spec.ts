import { expect } from "@playwright/test";
import { test } from "./reading-test";

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
    await page.evaluate(({ key, messages }) => localStorage.setItem(key, JSON.stringify([
      { id: "bounded", title: "Synthetic bounded history", updated: 1, messages },
    ])), { key, messages });
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
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
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

test("bounded chat history keeps its original conversation after quota recovery across SPA navigation", async ({ page }) => {
  await page.goto("/chat");
  const messages = boundedHistory();
  await page.evaluate(({ key, messages }) => localStorage.setItem(key, JSON.stringify([
    { id: "bounded", title: "Synthetic bounded history", updated: 1, messages },
  ])), { key, messages });
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
  await page.evaluate(key => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Synthetic full storage", "QuotaExceededError");
      return set.call(this, name, value);
    };
    window.addEventListener("synthetic-storage-ready", () => { Storage.prototype.setItem = set; }, { once: true });
  }, key);
  await page.getByLabel("Message").fill("Synthetic SPA unsaved question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-error")).toContainText("Synthetic provider failure.");
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A growing collection", exact: true })).toBeVisible();
  await navigation.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-message.user").last()).toContainText("Synthetic SPA unsaved question.");
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic SPA recovery reply.");
  await expect(page.locator(".chat-conversation-notice")).toHaveCount(0);
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
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
  await page.evaluate(({ key, messages }) => localStorage.setItem(key, JSON.stringify([
    { id: "bounded", title: "Synthetic bounded history", updated: 1, messages },
  ])), { key, messages });
  await page.reload();
  // Both responses are synthetic; no provider request is made by this test.
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
  await page.evaluate(key => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Synthetic full storage", "QuotaExceededError");
      return set.call(this, name, value);
    };
    window.addEventListener("synthetic-storage-ready", () => { Storage.prototype.setItem = set; }, { once: true });
  }, key);
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
  await other.evaluate(({ key, concurrent }) => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved[0].messages = concurrent;
    saved[0].updated++;
    localStorage.setItem(key, JSON.stringify(saved));
  }, { key, concurrent });
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic recovery reply.");
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
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

for (const finish of ["send", "retry", "new", "select"] as const) {
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
    } else if (finish === "new") await page.getByRole("button", { name: "New", exact: true }).click();
    else if (finish === "select") await page.locator('[data-conversation="shared"]').click();
    else await page.getByRole("button", { name: "Retry", exact: true }).click();
    if (finish !== "new") await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.locator(".chat-conversation-notice")).toContainText("unsaved messages");
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
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

const deletedKey = "secondbrain.chat.deleted.v1";
const storageLock = "secondbrain.chat.storage.v1";

test("a queued chat save reads the peer publication after its native storage lock releases", async ({ page, context }) => {
  await page.goto("/chat");
  await page.evaluate(({ key, deletedKey }) => {
    localStorage.setItem(key, JSON.stringify([
      { id: "shared", title: "Synthetic previous question", updated: 1,
        messages: [{ role: "user", content: "Synthetic previous question." }] },
    ]));
    localStorage.removeItem(deletedKey);
  }, { key, deletedKey });
  await page.reload();
  const peer = await context.newPage();
  await peer.goto("/chat");
  // A native same-origin lock holds a peer publication in progress. This is
  // scheduling/storage evidence, with no simulated provider response.
  await peer.evaluate(({ storageLock, key, deletedKey }) => {
    const state = window as unknown as {
      releaseChatStorage?: () => void; chatStorageHeld?: boolean; chatStorageDone?: boolean;
    };
    const hold = new Promise<void>(resolve => { state.releaseChatStorage = resolve; });
    void navigator.locks.request(storageLock, async () => {
      state.chatStorageHeld = true;
      await hold;
      localStorage.setItem(deletedKey, JSON.stringify([{ id: "shared", deleted: 2 }]));
      localStorage.setItem(key, JSON.stringify([
        { id: "peer", title: "Synthetic peer question", updated: 3,
          messages: [{ role: "user", content: "Synthetic peer question." }] },
      ]));
      state.chatStorageDone = true;
    });
  }, { storageLock, key, deletedKey });
  await peer.waitForFunction(() => (window as unknown as { chatStorageHeld?: boolean }).chatStorageHeld);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeDisabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).map((item: { id: string }) => item.id), key))
    .toEqual(["shared"]);
  await peer.evaluate(() => (window as unknown as { releaseChatStorage: () => void }).releaseChatStorage());
  await peer.waitForFunction(() => (window as unknown as { chatStorageDone?: boolean }).chatStorageDone);
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  const active = await page.locator("[data-conversation].active").getAttribute("data-conversation");
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(saved.map((item: { id: string }) => item.id).sort()).toEqual([active, "peer"].sort());
  expect(await page.evaluate(deletedKey => JSON.parse(localStorage.getItem(deletedKey)!), deletedKey))
    .toEqual([{ id: "shared", deleted: 2 }]);
  await page.reload();
  await expect(page.locator('[data-conversation="shared"]')).toHaveCount(0);
  await expect(page.locator('[data-conversation="peer"]')).toHaveCount(1);
  await peer.close();
});

for (const operation of ["new", "delete"] as const) {
  test(`overlapping native tab ${operation} and new actions retain saved chats and deletion intent`, async ({ page, context }) => {
    // Observe the native lock callbacks without changing Storage or introducing
    // yields inside a transaction. A failed assertion must distinguish a stale
    // observer from a writer that never saw the preceding publication.
    await context.addInitScript(({ key, deletedKey, storageLock }) => {
      type Snapshot = { conversations: string[]; deleted: string[] };
      const snapshot = (): Snapshot => ({
        conversations: JSON.parse(localStorage.getItem(key) || "[]").map((item: { id: string }) => item.id),
        deleted: JSON.parse(localStorage.getItem(deletedKey) || "[]").map((item: { id: string }) => item.id),
      });
      const trace: Array<{ phase: string; snapshot: Snapshot }> = [];
      (window as unknown as { chatStorageTrace: typeof trace }).chatStorageTrace = trace;
      if (!navigator.locks) return;
      const request = navigator.locks.request.bind(navigator.locks);
      Object.defineProperty(navigator.locks, "request", {
        value: (name: string, options: LockOptions | LockGrantedCallback<unknown>, callback?: LockGrantedCallback<unknown>) => {
          const action = typeof options === "function" ? options : callback!;
          const observed: LockGrantedCallback<unknown> = lock => {
            if (name === storageLock) trace.push({ phase: "acquired", snapshot: snapshot() });
            const result = action(lock);
            if (name === storageLock) trace.push({ phase: "returned", snapshot: snapshot() });
            return result;
          };
          return typeof options === "function" ? request(name, observed) : request(name, options, observed);
        },
      });
    }, { key, deletedKey, storageLock });
    const peer = await context.newPage();
    let providerRequests = 0;
    context.on("request", request => {
      if (new URL(request.url()).pathname === "/api/wiki/chat" && request.method() === "POST") providerRequests++;
    });
    await Promise.all([page.goto("/chat"), peer.goto("/chat")]);
    for (let trial = 0; trial < 20; trial++) {
      await page.evaluate(({ key, deletedKey, operation }) => {
        localStorage.removeItem(deletedKey);
        localStorage.setItem(key, JSON.stringify(operation === "new" ? [] : [
          { id: "shared", title: "Synthetic saved question", updated: 1,
            messages: [{ role: "user", content: "Synthetic saved question." }] },
        ]));
      }, { key, deletedKey, operation });
      await Promise.all([page.reload(), peer.reload()]);
      await Promise.all([
        page.locator('[data-action="new"]').waitFor(), peer.locator('[data-action="new"]').waitFor(),
      ]);
      // Dispatch the real UI handlers in separate native pages together; do
      // not replace Storage, defer its methods or route provider responses.
      await Promise.all([
        page.evaluate(operation => document.querySelector<HTMLButtonElement>(`[data-action="${operation}"]`)!.click(), operation),
        peer.evaluate(() => document.querySelector<HTMLButtonElement>('[data-action="new"]')!.click()),
      ]);
      await Promise.all([
        expect(page.locator('[data-action="new"]')).toBeEnabled(),
        expect(peer.locator('[data-action="new"]')).toBeEnabled(),
      ]);
      const ids = await Promise.all([
        page.locator("[data-conversation].active").getAttribute("data-conversation"),
        peer.locator("[data-conversation].active").getAttribute("data-conversation"),
      ]);
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
      const expected = [...ids].sort();
      const actual = saved.map((item: { id: string }) => item.id).sort();
      if (operation === "new" && JSON.stringify(actual) !== JSON.stringify(expected)) {
        const observe = () => ({
          trace: (window as unknown as { chatStorageTrace?: unknown }).chatStorageTrace,
          conversations: JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1") || "[]")
            .map((item: { id: string }) => item.id),
          deleted: JSON.parse(localStorage.getItem("secondbrain.chat.deleted.v1") || "[]")
            .map((item: { id: string }) => item.id),
        });
        const writers = await Promise.all([page.evaluate(observe), peer.evaluate(observe)]);
        const fresh = await context.newPage();
        await fresh.goto("/?overview=1"); // Real read-only app route, never a chat writer.
        const freshSnapshot = await fresh.evaluate(observe);
        await Promise.all([page.reload(), peer.reload()]);
        const reloaded = await Promise.all([page.evaluate(observe), peer.evaluate(observe)]);
        console.info("[chat-storage-observation] " + JSON.stringify({ operation, trial, ids, initial: actual,
          writers, fresh: freshSnapshot, reloaded }));
        await fresh.close();
      }
      if (operation === "new") {
        expect(saved.map((item: { id: string }) => item.id).sort(), `trial ${trial}`).toEqual(ids.sort());
      } else {
        expect(saved.some((item: { id: string }) => item.id === "shared"), `trial ${trial}`).toBeFalsy();
        expect(saved.some((item: { id: string }) => item.id === ids[1]), `trial ${trial}`).toBeTruthy();
        expect(await page.evaluate(deletedKey => JSON.parse(localStorage.getItem(deletedKey)!).some(
          (item: { id: string }) => item.id === "shared"), deletedKey), `trial ${trial}`).toBeTruthy();
      }
    }
    expect(providerRequests).toBe(0);
    await peer.close();
  });
}

test("rejected chat storage coordination retains the unsent draft and can recover", async ({ page }) => {
  await page.goto("/chat");
  let requests = 0;
  page.on("request", request => { if (request.url().endsWith("/api/wiki/chat")) requests++; });
  await page.evaluate(() => {
    const request = navigator.locks.request.bind(navigator.locks);
    Object.defineProperty(navigator.locks, "request", {
      configurable: true, value: () => Promise.reject(new DOMException("Synthetic coordination rejection", "SecurityError")),
    });
    window.addEventListener("synthetic-lock-recovered", () => {
      Object.defineProperty(navigator.locks, "request", { configurable: true, value: request });
    }, { once: true });
  });
  await page.getByLabel("Message").fill("Synthetic unsent question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-error")).toContainText("could not coordinate chat storage");
  await expect(page.getByLabel("Message")).toHaveValue("Synthetic unsent question.");
  await expect(page.getByLabel("Message")).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  expect(requests).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-lock-recovered")));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-error")).toHaveCount(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).length, key)).toBeGreaterThan(0);
});

test("browsers without Web Locks explain the single-tab chat storage boundary", async ({ page }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");
  await expect(page.locator(".chat-lock-notice")).toContainText("Use one Chat tab at a time");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByLabel("Message")).toBeEnabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).length, key)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath("chat-single-tab-fallback-390.png"), fullPage: true });
  await page.reload();
  await expect(page.locator(".chat-lock-notice")).toBeVisible();
  await expect(page.locator("[data-conversation]")).toHaveCount(1);
});

test("leaving chat cancels a queued storage action before it can publish", async ({ page, context }) => {
  await page.goto("/chat");
  const peer = await context.newPage();
  await peer.goto("/chat");
  await peer.evaluate(storageLock => {
    const state = window as unknown as { releaseChatStorage?: () => void; chatStorageHeld?: boolean };
    const hold = new Promise<void>(resolve => { state.releaseChatStorage = resolve; });
    void navigator.locks.request(storageLock, async () => {
      state.chatStorageHeld = true;
      await hold;
    });
  }, storageLock);
  await peer.waitForFunction(() => (window as unknown as { chatStorageHeld?: boolean }).chatStorageHeld);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".chat-page")).toHaveCount(0);
  await peer.evaluate(() => (window as unknown as { releaseChatStorage: () => void }).releaseChatStorage());
  await peer.evaluate(storageLock => navigator.locks.request(storageLock, () => undefined), storageLock);
  expect(await peer.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await peer.close();
});
