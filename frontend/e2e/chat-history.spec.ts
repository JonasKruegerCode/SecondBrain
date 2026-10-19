import { chromium, expect } from "@playwright/test";
import { test } from "./reading-test";

// A real Blink text setting changes glyph metrics without narrowing the
// viewport. This is separate from browser zoom, Safari and physical devices.
for (const width of [390, 600, 800, 1024, 1440]) {
  test(`native minimum text keeps chat and navigation controls reachable (${width})`, async ({ browserName, baseURL }, info) => {
    test.skip(browserName !== "chromium", "Blink minimum font size is Chromium-specific");
    const browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--blink-settings=minimumFontSize=24"],
    });
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      let modelRequests = 0;
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/wiki/chat" && request.method() === "POST") modelRequests++;
      });
      await page.goto(`${baseURL}/?overview=1`);
      await expect(page.getByRole("heading", { name: "A growing collection", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: info.outputPath(`home-minimum-text-${width}.png`) });
      await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Chat", exact: true }).click();
      const heading = page.locator(".chat-history-heading");
      const label = heading.locator("span");
      const create = heading.getByRole("button", { name: "New", exact: true });
      await expect(create).toBeVisible();
      await page.screenshot({ path: info.outputPath(`chat-minimum-text-${width}.png`) });
      const parent = (await heading.boundingBox())!;
      const labelBounds = (await label.boundingBox())!;
      // Prove the native setting actually enlarged the formerly nine-pixel label.
      expect(labelBounds.height).toBeGreaterThanOrEqual(24);
      for (const target of [label, create]) {
        const box = (await target.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(parent.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(parent.y + parent.height + 1);
        expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.locator("textarea").fill("Synthetic unsent question.");
      await create.click();
      await expect(page.locator("textarea")).toHaveValue("");
      await page.locator("textarea").fill("A second synthetic unsent question.");
      await create.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("textarea")).toHaveValue("");
      const search = page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Search", exact: true });
      await search.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search$/);
      expect(modelRequests).toBe(0);
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

for (const width of [1440, 1024, 390]) {
  test(`full local chat history stays usable without stretching the workspace (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/chat");
    const seed = async (count: number) => {
      await page.evaluate(count => localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify(
        Array.from({ length: count }, (_, i) => ({ id: `synthetic-history-${i}`, title: `Synthetic conversation ${i + 1}`,
          updated: 100 - i, messages: [{ role: "user", content: `Synthetic saved question ${i + 1}.` }] })),
      )), count);
      await page.reload();
      await expect(page.locator(".chat-history-list button")).toHaveCount(count);
    };
    await seed(1);
    const singleComposer = await page.locator(".chat-composer").boundingBox();
    await seed(20);
    const fullComposer = await page.locator(".chat-composer").boundingBox();
    // Opening a full saved history must not move the input below the reader.
    expect(fullComposer!.y).toBeLessThanOrEqual(singleComposer!.y + 2);
    if (width > 760) expect(fullComposer!.y + fullComposer!.height).toBeLessThanOrEqual(1000);
    const list = page.locator(".chat-history-list");
    await page.locator(".chat-history-list button").first().focus();
    for (let i = 1; i < 20; i++) await page.keyboard.press("Tab");
    const last = page.locator(".chat-history-list button").last();
    await expect(last).toBeFocused();
    const metrics = await list.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight, x: element.scrollLeft, y: element.scrollTop }));
    if (width > 760) {
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
      expect(metrics.y).toBeGreaterThan(0);
    } else {
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.width);
      expect(metrics.x).toBeGreaterThan(0);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.height + 1);
    }
    const bounds = await list.boundingBox();
    const selected = await last.boundingBox();
    if (width > 760) {
      expect(selected!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
      expect(selected!.x + selected!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    } else {
      // Native horizontal focus scrolling may expose only part of a button.
      // Keep a touch-sized visible target; activation reveals the selected item.
      expect(Math.min(selected!.x + selected!.width, bounds!.x + bounds!.width) - Math.max(selected!.x, bounds!.x)).toBeGreaterThanOrEqual(44);
    }
    expect(selected!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
    expect(selected!.y + selected!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-message.user")).toContainText("Synthetic saved question 20.");
    await expect(page.locator(".chat-history-list button.active")).toContainText("Synthetic conversation 20");
    // Selecting history replaces the list and moves the active item first.
    // Keep the keyboard at that item rather than restarting at New/body.
    const active = page.locator(".chat-history-list button.active");
    await expect(active).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(".chat-history-list button").nth(1)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(active).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`chat-history-selected-focus-${width}.png`) });
    await page.reload();
    await expect(page.locator(".chat-message.user")).toContainText("Synthetic saved question 20.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`chat-history-${width}.png`), fullPage: true });
  });
}

for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 450 }]) {
  test(`short viewport preserves chat questions and failed editor drafts (${viewport.width}x${viewport.height})`, async ({ page, request }, info) => {
    const { randomUUID } = await import("node:crypto");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize(viewport);
    const reachable = async (target: ReturnType<typeof page.locator>) => {
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeVisible();
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    };
    const id = `short-viewport-${randomUUID()}`;
    const endpoint = `/api/wiki/pages/${id}`;
    const markdown = "# Synthetic short viewport\n\nOriginal synthetic source.\n";
    let created = false;
    try {
      await page.goto("/chat");
      await page.evaluate(() => localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({ id: `short-history-${i}`, title: `Synthetic conversation ${i + 1}`,
          updated: 100 - i, messages: [{ role: "user", content: `Synthetic saved question ${i + 1}.` }] })),
      )));
      await page.reload();
      const history = page.locator("[data-conversation]");
      await expect(history).toHaveCount(20);
      await reachable(history.last());
      await history.last().click();
      await expect(page.locator(".chat-message.user").last()).toContainText("Synthetic saved question 20.");
      const question = "Synthetic short viewport follow-up.";
      const input = page.getByLabel("Message", { exact: true });
      await input.fill(question);
      await reachable(input);
      await expect(input).toHaveValue(question);
      await page.screenshot({ path: info.outputPath("short-chat-input.png") });
      let attempts = 0;
      await page.route("**/api/wiki/chat", route => {
        attempts++;
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic short viewport provider failure." }) });
      });
      const send = page.getByRole("button", { name: "Send", exact: false });
      await reachable(send);
      await send.click();
      await expect(page.locator(".chat-error")).toContainText("Synthetic short viewport provider failure.");
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await reachable(retry);
      await page.screenshot({ path: info.outputPath("short-chat-retry.png") });
      await retry.click();
      await expect.poll(() => attempts).toBe(2);
      await expect(page.locator(".chat-error")).toContainText("Synthetic short viewport provider failure.");
      await expect(page.locator(".chat-message.user").last()).toContainText(question);
      await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!));
      expect(stored.find((item: { id: string }) => item.id === "short-history-19").messages.at(-1).content).toBe(question);

      const response = await request.post(endpoint, { data: { markdown, base_revision: null, request_id: randomUUID() } });
      expect(response.ok()).toBeTruthy();
      created = true;
      const revision = (await response.json()).revision;
      await page.goto(`/wiki/${id}`);
      await page.locator("#edit").click();
      const draft = markdown + "\nSynthetic unsaved short viewport draft.";
      await page.locator("#editor").fill(draft);
      await page.route(`**${endpoint}`, route => route.request().method() === "POST"
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Synthetic save failure." }) })
        : route.continue());
      await reachable(page.locator("#save"));
      await page.screenshot({ path: info.outputPath("short-editor-save.png") });
      await page.locator("#save").click();
      await expect(page.locator(".notice")).toHaveText("The save response could not be confirmed. Your draft is preserved. Try saving again.");
      await expect(page.locator("#editor")).toHaveValue(draft);
      await reachable(page.locator("#edit"));
      await page.screenshot({ path: info.outputPath("short-editor-cancel.png") });
      const dialog = page.waitForEvent("dialog");
      const cancel = page.locator("#edit").click();
      const confirmation = await dialog;
      expect(confirmation.message()).toBe("Discard unsaved changes?");
      await confirmation.accept();
      await cancel;
      await expect(page.locator("#editor")).toHaveCount(0);
      const unchanged = await (await request.get(endpoint)).json();
      expect(unchanged.markdown).toBe(markdown);
      expect(unchanged.revision).toBe(revision);
      expect(errors).toEqual([]);
    } finally {
      if (created) {
        const current = await request.get(endpoint);
        expect(current.ok()).toBeTruthy();
        expect((await request.delete(endpoint, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } })).ok()).toBeTruthy();
        expect((await request.get(endpoint)).status()).toBe(404);
      }
    }
  });
}
