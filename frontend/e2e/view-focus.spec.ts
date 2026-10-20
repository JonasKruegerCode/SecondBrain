import { holdChatWriter, releaseChatWriter, seedChats } from "./chat-storage";
import { expect, APIRequestContext, Page } from "@playwright/test";
import { test } from "./reading-test";
import { randomUUID } from "node:crypto";

for (const width of [390, 1440]) {
  for (const failure of ["storage denied", "quota exceeded"] as const) {
    test(`start preference storage failure preserves the editor and recovers (${failure}, ${width})`, async ({ page, request }, info) => {
      const fixture = await create(request, "# Synthetic storage recovery\n\nThe published article stays unchanged.");
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.setViewportSize({ width, height: 844 });
        // Explicit Storage API fault injection, not a real browser permission or
        // disk-quota experiment. All page reads/history use the running service.
        await page.addInitScript(({ failure }) => {
          const storage = window.localStorage;
          const key = "secondbrain.startpage";
          const recoveryKey = "synthetic.start-storage-recovered";
          let blocked = sessionStorage.getItem(recoveryKey) !== "yes";
          const set = Storage.prototype.setItem;
          if (!storage.getItem(key)) set.call(storage, key, "home");
          Object.defineProperty(window, "localStorage", { configurable: true, get() {
            if (blocked && failure === "storage denied")
              throw new DOMException("Synthetic storage denial", "SecurityError");
            return storage;
          }});
          Storage.prototype.setItem = function(name, value) {
            if (blocked && this === storage && name === key)
              throw new DOMException("Synthetic full storage", "QuotaExceededError");
            return set.call(this, name, value);
          };
          window.addEventListener("synthetic-start-storage-ready", () => {
            blocked = false;
            sessionStorage.setItem(recoveryKey, "yes");
          });
        }, { failure });
        await page.goto("/");
        // A denied read falls back to the overview; quota failures still allow
        // reading the saved Home preference. Both survive a real reload.
        const start = failure === "storage denied"
          ? page.getByRole("link", { name: /Open Lantern Bay/ })
          : page.locator("article > h1");
        await expect(start).toBeVisible();
        if (failure === "quota exceeded") {
          await expect(start).toHaveText("Lantern Bay field atlas");
          // The heading precedes asynchronous link hydration. Finish the last
          // real batch before replacing this document, so the check observes
          // storage recovery rather than native teardown-cancelled fetches.
          await expect(page.locator('.prose a[data-wiki-target="field-notebook"]'))
            .toHaveAttribute("href", "/wiki/field-notebook");
        }
        await page.reload();
        await expect(start).toBeVisible();
        if (failure === "quota exceeded") {
          await expect(start).toHaveText("Lantern Bay field atlas");
          await expect(page.locator('.prose a[data-wiki-target="field-notebook"]'))
            .toHaveAttribute("href", "/wiki/field-notebook");
        }
        await page.goto(`/wiki/${fixture.id}`);
        await page.getByRole("button", { name: "Edit page" }).click();
        const editor = page.getByRole("textbox", { name: /Markdown/ });
        const handle = await editor.elementHandle();
        const draft = fixture.markdown + "\n\nAn unsaved synthetic draft.";
        await editor.fill(draft);
        await editor.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 13));
        await page.getByRole("button", { name: "Set as start page" }).click();
        await expect(page.locator(".notice.error")).toContainText("could not remember this preference");
        await expect(editor).toHaveValue(draft);
        expect(await editor.evaluate((node, original) => node === original, handle)).toBe(true);
        expect(await editor.evaluate(node => [(node as HTMLTextAreaElement).selectionStart,
          (node as HTMLTextAreaElement).selectionEnd])).toEqual([4, 13]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`start-storage-${failure === "storage denied" ? "denied" : "quota"}-${width}.png`) });
        await page.evaluate(() => window.dispatchEvent(new Event("synthetic-start-storage-ready")));
        expect(await page.evaluate(() => localStorage.getItem("secondbrain.startpage"))).toBe("home");
        await page.getByRole("button", { name: "Set as start page" }).click();
        await expect(page.locator(".notice")).toHaveText("This is now your start page.");
        await expect(page.locator(".notice")).not.toHaveClass(/error/);
        await expect(editor).toHaveValue(draft);
        expect(await editor.evaluate((node, original) => node === original, handle)).toBe(true);
        const current = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
        expect(current.markdown).toBe(fixture.markdown);
        expect(current.revision).toBe(fixture.revision);
        // Cancel deliberately discards only the draft, then the saved preference
        // survives a document navigation and reload to the real article.
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(page.locator(".prose")).toContainText("The published article stays unchanged.");
        await page.goto("/");
        await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
        // Automatic start-page navigation replaces the URL before the article
        // read completes. Reload only after the saved destination is displayed.
        await expect(page.locator("article > h1")).toHaveText("Synthetic storage recovery");
        await page.reload();
        await expect(page.locator("article > h1")).toHaveText("Synthetic storage recovery");
        expect(errors).toEqual([]);
      } finally {
        await deleteReadingPages(request, [fixture.id]);
        expect((await request.get(`/api/wiki/pages/${fixture.id}`)).status()).toBe(404);
      }
    });
  }
}

for (const width of [390, 1440]) {
  for (const failure of ["deleted after listing", "transport unavailable"] as const) {
    test(`saved start falls back without changing direct URLs (${failure}, ${width})`, async ({ page, request }, info) => {
      const fixture = await create(request, "# Synthetic saved start\n\nA recoverable starting point.");
      let deleted = false, visitLength = 0, targetReads = 0;
      const pattern = `**/api/wiki/pages/${fixture.id}`;
      await page.setViewportSize({ width, height: 844 });
      try {
        await page.goto(`/wiki/${fixture.id}`);
        await page.getByRole("button", { name: "Set as start page" }).click();
        await page.goto("/search");
        await expect(page.locator("main h1")).toHaveText("Find a thought.");
        await page.route(pattern, async route => {
          targetReads++;
          visitLength = await page.evaluate(() => history.length);
          if (failure === "deleted after listing") {
            // The real list was returned before the real revision-guarded delete.
            const result = await request.delete(`/api/wiki/pages/${fixture.id}`, { data: {
              base_revision: fixture.revision, request_id: randomUUID(),
            } });
            expect(result.ok()).toBe(true);
            deleted = true;
            await route.continue(); // Actual 404 from the running service.
          } else await route.abort("failed"); // Explicit transport injection only.
        }, { times: 1 });
        await page.goto("/");
        await expect(page).toHaveURL(/\/\?overview=1$/);
        await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
        await expect(page.locator(".start-page-notice")).toContainText("could not be opened");
        await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
        expect(targetReads).toBe(1);
        expect(await page.evaluate(() => history.length)).toBe(visitLength);
        expect(await page.evaluate(() => localStorage.getItem("secondbrain.startpage"))).toBe(fixture.id);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`start-fallback-${failure.startsWith("deleted") ? "deleted" : "transport"}-${width}.png`), fullPage: true });
        await page.goBack();
        await expect(page).toHaveURL(/\/search$/);
        await expect(page.locator("main h1")).toHaveText("Find a thought.");
        if (!deleted) await page.route(pattern, route => route.abort("failed"), { times: 1 });
        await page.goto(`/wiki/${fixture.id}`);
        await expect(page.getByRole("heading", { name: deleted ? "This page is missing." : "Couldn’t open the workspace." })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
        await expect(page.locator(".start-page-notice")).toHaveCount(0);
        if (!deleted) {
          await page.getByRole("button", { name: "Try again" }).click();
          await expect(page.locator("article h1")).toHaveText("Synthetic saved start");
          await page.goto("/");
          await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
        }
      } finally {
        await page.unroute(pattern);
        if (!deleted) expect((await request.delete(`/api/wiki/pages/${fixture.id}`, { data: {
          base_revision: fixture.revision, request_id: randomUUID(),
        } })).ok()).toBe(true);
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`search query normalization retains its fragment destination (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/search?q=%20tide%20clock%20#main-content");
    await expect(page.locator('#results a[href="/wiki/tide-clock"]')).toBeVisible();
    const observed = await page.evaluate(() => ({ hash: location.hash, tag: document.activeElement?.tagName }));
    console.log(`[search-fragment] ${JSON.stringify({ width, observed })}`);
    expect(observed.hash).toBe("#main-content");
    expect(observed.tag).toBe("MAIN");
    await expect(page).toHaveURL(/\/search\?q=tide%20clock#main-content$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await page.screenshot({ path: info.outputPath(`search-fragment-${width}.png`) });
    await page.keyboard.press("Tab");
    const input = page.getByRole("textbox", { name: "Search pages" });
    await expect(input).toBeFocused();
    await input.fill(" night sky ");
    await page.keyboard.press("Enter");
    await expect(page.locator('#results a[href="/wiki/night-sky-survey"]')).toBeVisible();
    await expect(page).toHaveURL(/\/search\?q=night%20sky#main-content$/);
    await expect(input).toBeFocused();
    await input.fill("  ");
    const blank = page.waitForResponse(response => response.url().endsWith("/api/wiki/search?q="));
    await page.keyboard.press("Enter");
    await (await blank).finished();
    await expect(page).toHaveURL(/\/search#main-content$/);
    await expect(input).toBeFocused();
    await expect(page.locator("#results")).toContainText("No pages found.");
  });
}

test("a delayed initial search respects newer fragment and input choices", async ({ page }) => {
  let release!: () => void;
  let received!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { received = resolve; });
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  const pattern = "**/api/wiki/search?q=tide%20clock";
  await page.route(pattern, async route => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  try {
    await page.goto("/search?q=tide%20clock#main-content");
    await held;
    await expect(page.locator("#main-content")).toBeFocused();
    const input = page.getByRole("textbox", { name: "Search pages" });
    await input.fill("Unsubmitted next thought");
    await input.focus();
    // Script a native address-fragment change while the actual payload is held.
    await page.evaluate(() => { location.hash = "another-fragment"; });
    await expect(page).toHaveURL(/#another-fragment$/);
    release();
    await completed;
    await expect(page.locator('#results a[href="/wiki/tide-clock"]')).toBeVisible();
    await expect(input).toHaveValue("Unsubmitted next thought");
    await expect(input).toBeFocused();
    await expect(page).toHaveURL(/\/search\?q=tide%20clock#another-fragment$/);
  } finally { release(); await page.unroute(pattern); }
});

test("search query fragments survive result navigation, history and reload", async ({ page }) => {
  await page.goto("/search?q=tide%20clock#main-content");
  const result = page.locator('#results a[href="/wiki/tide-clock"]');
  await expect(result).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await result.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("article > h1")).toHaveText("Tide clock project");
  await expect(page.locator("article > h1")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=tide%20clock#main-content$/);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(result).toBeVisible();
  await page.goForward();
  await expect(page.locator("article > h1")).toBeFocused();
  await page.goBack();
  await expect(page.locator("#main-content")).toBeFocused();
  await page.reload();
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(result).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`keyboard navigation reaches each view's content (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["Search", "Home", "Galaxy", "Chat"]) {
      await page.goto("/wiki/night-sky-survey");
      await expect(page.locator("article > h1")).toHaveText("Night sky survey");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const link = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true });
      await link.focus();
      await page.keyboard.press("Enter");
      const heading = page.locator("main h1");
      await expect(heading).toBeVisible();
      const observed = await page.evaluate(() => ({ tag: document.activeElement?.tagName, scrollY }));
      console.log(`[view-focus] ${JSON.stringify({ width, name, observed })}`);
      await expect(heading).toBeFocused();
      expect(observed.tag).toBe("H1");
      expect(observed.scrollY).toBe(0);
      if (name === "Chat") await expect(page.locator("#chat-input")).not.toBeFocused();
      await page.screenshot({ path: info.outputPath(`view-focus-${name.toLowerCase()}-${width}.png`) });
      await page.keyboard.press("Tab");
      const next = name === "Search" ? page.getByRole("textbox", { name: "Search pages" }) :
        name === "Home" ? page.getByRole("link", { name: /Open Lantern Bay field atlas/ }) :
        name === "Galaxy" ? page.getByRole("link", { name: "Page overview ↗" }) :
        page.locator("#chat-input");
      await expect(next).toBeFocused();
    }
  });
}

async function create(request: APIRequestContext, markdown: string) {
  const id = `e2e-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, { data: {
    markdown, base_revision: null, request_id: randomUUID(),
  }});
  expect(response.ok()).toBeTruthy();
  return { id, ...(await response.json()) };
}

async function activate(page: Page, name: string) {
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await page.keyboard.press("Enter");
}

function readingPage(title: string, destination?: string) {
  return `# ${title}\n\n` + Array.from({ length: 100 }, (_, index) =>
    `Synthetic reading paragraph ${index + 1}. A quiet notebook contains observations of clouds, stones, and the changing afternoon light. ` +
    (destination ? `[Continue reading](/wiki/${destination})` : "The next observation waits further down the page.")
  ).join("\n\n");
}

async function deleteReadingPages(request: APIRequestContext, ids: string[]) {
  for (const id of ids.reverse()) {
    const latest = await request.get(`/api/wiki/pages/${id}`);
    if (latest.ok()) expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
      base_revision: (await latest.json()).revision, request_id: randomUUID(),
    }})).ok()).toBeTruthy();
  }
}

async function followVisibleReadingLink(page: Page) {
  const links = page.locator('article a').filter({ hasText: "Continue reading" });
  const index = await links.evaluateAll(elements => elements.findIndex(element => {
    const box = element.getBoundingClientRect();
    return box.top > 40 && box.bottom < window.innerHeight - 40;
  }));
  expect(index).toBeGreaterThanOrEqual(0);
  // Use a link already inside the viewport so activation does not move the
  // source reading point to an offscreen header or distant paragraph.
  await links.nth(index).click();
}

async function expectReadingPoint(page: Page, point: number) {
  await expect.poll(async () => Math.abs(await page.evaluate(() => scrollY) - point)).toBeLessThanOrEqual(2);
}

for (const width of [390, 1440]) {
  test(`ordinary history restores each reading point (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const owned: string[] = [];
    try {
      const target = await create(request, readingPage("Reading target"));
      owned.push(target.id);
      const source = await create(request, readingPage("Reading source", target.id));
      owned.push(source.id);
      await page.goto(`/wiki/${source.id}`);
      await expect(page.locator("article > h1")).toHaveText("Reading source");
      await page.evaluate(() => window.scrollTo(0, 900));
      await expectReadingPoint(page, 900);
      await followVisibleReadingLink(page);
      await expect(page.locator("article > h1")).toHaveText("Reading target");
      await page.evaluate(() => window.scrollTo(0, 1500));
      await expectReadingPoint(page, 1500);
      await page.goBack();
      await expect(page.locator("article > h1")).toHaveText("Reading source");
      await expectReadingPoint(page, 900);
      await page.screenshot({ path: info.outputPath(`history-reading-${width}.png`) });
      await page.goForward();
      await expect(page.locator("article > h1")).toHaveText("Reading target");
      await expectReadingPoint(page, 1500);
      // Revisiting the routes after changing the reading points must use the
      // latest entry snapshots rather than an old route-level scroll value.
      await page.goBack();
      await expect(page.locator("article > h1")).toHaveText("Reading source");
      await expectReadingPoint(page, 900);
      await page.evaluate(() => window.scrollTo(0, 1900));
      await followVisibleReadingLink(page);
      await expect(page.locator("article > h1")).toHaveText("Reading target");
      await page.evaluate(() => window.scrollTo(0, 2400));
      await page.goBack();
      await expect(page.locator("article > h1")).toHaveText("Reading source");
      await expectReadingPoint(page, 1900);
      await page.goForward();
      await expect(page.locator("article > h1")).toHaveText("Reading target");
      await expectReadingPoint(page, 2400);
    } finally { await deleteReadingPages(request, owned); }
  });

  test(`delayed history preserves deliberate header focus and scroll (${width})`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const owned: string[] = [];
    let release: (() => void) | undefined;
    let pattern: string | undefined;
    try {
      const target = await create(request, readingPage("Delayed reading target"));
      owned.push(target.id);
      const source = await create(request, readingPage("Delayed reading source", target.id));
      owned.push(source.id);
      await page.goto(`/wiki/${source.id}`);
      await expect(page.locator("article > h1")).toHaveText("Delayed reading source");
      await page.evaluate(() => window.scrollTo(0, 900));
      await expectReadingPoint(page, 900);
      await followVisibleReadingLink(page);
      await expect(page.locator("article > h1")).toHaveText("Delayed reading target");
      await page.evaluate(() => window.scrollTo(0, 1500));
      let received!: () => void;
      let delivered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = new Promise<void>(resolve => { received = resolve; });
      const completed = new Promise<void>(resolve => { delivered = resolve; });
      pattern = `**/api/wiki/pages/${source.id}`;
      await page.route(pattern, async route => {
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
        delivered();
      });
      const back = page.goBack();
      await held;
      await back;
      const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
      await search.focus();
      const chosenPoint = await page.evaluate(() => scrollY);
      release!();
      await completed;
      await expect(page.locator("article > h1")).toHaveText("Delayed reading source");
      await expect(search).toBeFocused();
      await expectReadingPoint(page, chosenPoint);
    } finally {
      release?.();
      if (pattern) await page.unroute(pattern);
      await deleteReadingPages(request, owned);
    }
  });
}

// These reads use disposable pages saved through the real API. Holding a fetched
// response delays delivery only; it does not replace the backend payload.
for (const width of [390, 1440]) {
  test(`full reload preserves reading points across Back and Forward (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const owned: string[] = [];
    try {
      const target = await create(request, readingPage("Reload reading target"));
      owned.push(target.id);
      const source = await create(request, readingPage("Reload reading source", target.id));
      owned.push(source.id);
      await page.goto(`/wiki/${source.id}`);
      await expect(page.locator("article > h1")).toHaveText("Reload reading source");
      await page.evaluate(() => window.scrollTo(0, 900));
      await expectReadingPoint(page, 900);
      await followVisibleReadingLink(page);
      await expect(page.locator("article > h1")).toHaveText("Reload reading target");
      await page.evaluate(() => window.scrollTo(0, 1500));
      await expectReadingPoint(page, 1500);
      await page.reload();
      await expect(page.locator("article > h1")).toHaveText("Reload reading target");
      await expectReadingPoint(page, 1500);
      await page.screenshot({ path: info.outputPath(`reload-reading-${width}.png`) });
      await page.goBack();
      await expect(page.locator("article > h1")).toHaveText("Reload reading source");
      await expectReadingPoint(page, 900);
      await page.goForward();
      await expect(page.locator("article > h1")).toHaveText("Reload reading target");
      await expectReadingPoint(page, 1500);
      const cache = await page.evaluate(() => JSON.parse(sessionStorage.getItem("secondbrain.reading-points")!));
      expect(cache.points.length).toBeLessThanOrEqual(100);
      expect(Object.keys(cache).sort()).toEqual(["points", "session"]);
      for (const [id, point] of cache.points) {
        expect(typeof id).toBe("string");
        expect(Object.keys(point).sort()).toEqual(["x", "y"]);
      }
      expect(JSON.stringify(cache)).not.toContain(source.id);
      expect(JSON.stringify(cache)).not.toContain("Synthetic reading paragraph");
    } finally { await deleteReadingPages(request, owned); }
  });

  test(`delayed reload respects deliberate header focus and scroll (${width})`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const owned: string[] = [];
    let release: (() => void) | undefined;
    let pattern: string | undefined;
    try {
      const source = await create(request, readingPage("Delayed reload source"));
      owned.push(source.id);
      await page.goto(`/wiki/${source.id}`);
      await expect(page.locator("article > h1")).toHaveText("Delayed reload source");
      await page.evaluate(() => window.scrollTo(0, 900));
      await expectReadingPoint(page, 900);
      let received!: () => void;
      let delivered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = new Promise<void>(resolve => { received = resolve; });
      const completed = new Promise<void>(resolve => { delivered = resolve; });
      pattern = `**/api/wiki/pages/${source.id}`;
      await page.route(pattern, async route => {
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
        delivered();
      });
      const reload = page.reload({ waitUntil: "domcontentloaded" });
      await held;
      await reload;
      const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
      await search.focus();
      await page.mouse.wheel(0, -300);
      const chosenPoint = await page.evaluate(() => scrollY);
      release!();
      await completed;
      await expect(page.locator("article > h1")).toHaveText("Delayed reload source");
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(search).toBeFocused();
      await expectReadingPoint(page, chosenPoint);
      expect(chosenPoint).not.toBe(900);
    } finally {
      release?.();
      if (pattern) await page.unroute(pattern);
      await deleteReadingPages(request, owned);
    }
  });
}

test("delayed search reload restores after real result cards arrive", async ({ page, request }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const owned: string[] = [];
  const query = `reloadsearch${randomUUID().replace(/-/g, "")}`;
  const pattern = `**/api/wiki/search?q=${query}`;
  let release: (() => void) | undefined;
  try {
    for (let index = 0; index < 16; index++) {
      const result = await create(request, `# ${query} observation ${index + 1}\n\nSynthetic search fixture. Clouds and stones provide a quiet reading route for this disposable observation.`);
      owned.push(result.id);
    }
    await page.goto(`/search?q=${query}`);
    await expect(page.locator("#results .card")).toHaveCount(16);
    await page.evaluate(() => window.scrollTo(0, 900));
    await expectReadingPoint(page, 900);
    let received!: () => void;
    let delivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { received = resolve; });
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    await page.route(pattern, async route => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
      delivered();
    });
    const reload = page.reload({ waitUntil: "domcontentloaded" });
    await held;
    await reload;
    await expect(page.locator("#results")).toHaveText("Searching…");
    release!();
    await completed;
    await expect(page.locator("#results .card")).toHaveCount(16);
    await expectReadingPoint(page, 900);
    const geometry = await page.evaluate(() => ({
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll<HTMLElement>("#results .card")].map(card => ({
        right: card.getBoundingClientRect().right,
        titleWidth: card.querySelector<HTMLElement>("h3")!.clientWidth,
        titleScrollWidth: card.querySelector<HTMLElement>("h3")!.scrollWidth,
      })),
    }));
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
    for (const card of geometry.cards) {
      expect(card.right).toBeLessThanOrEqual(geometry.width);
      expect(card.titleScrollWidth).toBeLessThanOrEqual(card.titleWidth);
    }
    await page.screenshot({ path: info.outputPath("reload-search-390.png") });
  } finally {
    release?.();
    await page.unroute(pattern);
    await deleteReadingPages(request, owned);
  }
});

test("a fragment wins over the cached reading point after full reload", async ({ page, request }) => {
  const owned: string[] = [];
  try {
    const source = await create(request, readingPage("Fragment reload source") + "\n\n## Reload destination\n\nThe fragment takes priority.");
    owned.push(source.id);
    await page.goto(`/wiki/${source.id}#reload-destination`);
    const destination = page.getByRole("heading", { name: "Reload destination", exact: true });
    await expect(destination).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 900));
    await expectReadingPoint(page, 900);
    await page.reload();
    await expect(destination).toBeFocused();
    await expect(page).toHaveURL(/#reload-destination$/);
    await expect.poll(async () => page.evaluate(() => scrollY)).toBeGreaterThan(1500);
    await expect(destination).toBeInViewport();
  } finally { await deleteReadingPages(request, owned); }
});

test("unavailable or invalid tab storage cannot resume stale reading coordinates", async ({ page, request }) => {
  const owned: string[] = [];
  try {
    const source = await create(request, readingPage("Storage fallback source"));
    owned.push(source.id);
    // Every reload retains a real history entry. Each invalid cache must force
    // a fresh navigation session and a harmless initial reading position.
    await page.addInitScript(() => {
      const failure = history.state?.__e2eStorageFailure;
      if (failure === "unavailable") {
        // Block only sessionStorage, without changing localStorage or API reads.
        Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("Storage disabled", "SecurityError"); } });
      } else if (failure === "corrupt" || failure === "mismatched") {
        sessionStorage.setItem("secondbrain.reading-points", failure === "corrupt" ? "{broken" : JSON.stringify({
          session: "different-tab-session", points: [["stale-visit", { x: 0, y: 900 }]],
        }));
      }
    });
    for (const failure of ["corrupt", "mismatched", "unavailable"] as const) {
      await page.goto(`/wiki/${source.id}`);
      await expect(page.locator("article > h1")).toHaveText("Storage fallback source");
      await page.evaluate(() => window.scrollTo(0, 900));
      await expectReadingPoint(page, 900);
      const previousSession = await page.evaluate(() => history.state["secondbrain.navigation"].session);
      await page.evaluate(failure => {
        history.replaceState({ ...history.state, __e2eStorageFailure: failure }, "");
      }, failure);
      await page.reload();
      await expect(page.locator("article > h1")).toHaveText("Storage fallback source");
      // Let queued layout/restoration frames run before asserting no stale jump.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expectReadingPoint(page, 0);
      expect(await page.evaluate(() => history.state["secondbrain.navigation"].session)).not.toBe(previousSession);
      // Keep the hard-blocked case last; the earlier cases retain normal storage.
    }
  } finally { await deleteReadingPages(request, owned); }
});

test("Back during a pending same-page visit restores its completed reading point", async ({ page, request }) => {
  const owned: string[] = [];
  let release: (() => void) | undefined;
  let pattern: string | undefined;
  try {
    const source = await create(request, readingPage("Same-page reading"));
    owned.push(source.id);
    const updated = await request.post(`/api/wiki/pages/${source.id}`, { data: {
      markdown: readingPage("Same-page reading", source.id),
      base_revision: source.revision, request_id: randomUUID(),
    }});
    expect(updated.ok()).toBeTruthy();
    await page.goto(`/wiki/${source.id}`);
    await expect(page.locator("article > h1")).toHaveText("Same-page reading");
    await page.evaluate(() => window.scrollTo(0, 900));
    await expectReadingPoint(page, 900);
    let received!: () => void;
    let delivered!: () => void;
    let freshDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { received = resolve; });
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    const freshCompleted = new Promise<void>(resolve => { freshDelivered = resolve; });
    let first = true;
    pattern = `**/api/wiki/pages/${source.id}`;
    await page.route(pattern, async route => {
      const holdThisRead = first;
      first = false;
      const response = await route.fetch();
      if (holdThisRead) {
        received();
        await gate;
        await route.fulfill({ response });
        delivered();
      } else {
        await route.fulfill({ response });
        freshDelivered();
      }
    });
    await followVisibleReadingLink(page);
    await held;
    await page.goBack();
    await freshCompleted;
    await expect(page.locator("article > h1")).toHaveText("Same-page reading");
    await expectReadingPoint(page, 900);
    release!();
    await completed;
    await expect(page.locator("article > h1")).toHaveText("Same-page reading");
    await expectReadingPoint(page, 900);
    // The abandoned entry has no completed reading point yet.
    await page.goForward();
    await expectReadingPoint(page, 0);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expectReadingPoint(page, 1500);
    await followVisibleReadingLink(page);
    await expect(page.locator("article > h1")).toHaveText("Same-page reading");
    await expectReadingPoint(page, 0);
    await page.evaluate(() => window.scrollTo(0, 2400));
    await expectReadingPoint(page, 2400);
    // All three entries share a URL, but retain separate reading points.
    await page.goBack();
    await expectReadingPoint(page, 1500);
    await page.goBack();
    await expectReadingPoint(page, 900);
    await page.goForward();
    await expectReadingPoint(page, 1500);
    await page.goForward();
    await expectReadingPoint(page, 2400);
  } finally {
    release?.();
    if (pattern) await page.unroute(pattern);
    await deleteReadingPages(request, owned);
  }
});

test("resolution choices, missing links and real 404s have keyboard destinations", async ({ page, request }) => {
  const owned: string[] = [];
  const add = async (markdown: string) => {
    const result = await create(request, markdown);
    owned.push(result.id);
    return result;
  };
  const title = `Shared reference ${randomUUID()}`;
  try {
    await add(`# ${title}\n\n## Details\n\nFirst synthetic choice.`);
    await add(`# ${title}\n\n## Details\n\nSecond synthetic choice.`);
    const absent = `absent-${randomUUID()}`;
    const source = await add(`# Resolution source\n\n[[${title}#Details|Choose a reference]]\n\n[Unresolved reference](/resolve?target=${absent})\n\n[Deleted article](/wiki/${absent})`);
    await page.goto(`/wiki/${source.id}`);
    await expect(page.getByRole("link", { name: "Choose a reference", exact: true })).toHaveClass(/ambiguous-link/);
    await activate(page, "Choose a reference");
    await expect(page.locator("main h1")).toHaveText("Choose a page.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(".card").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeFocused();
    await page.goBack();
    await expect(page.locator("main h1")).toHaveText("Choose a page.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.goBack();
    await expect(page.locator("article > h1")).toHaveText("Resolution source");
    await activate(page, "Unresolved reference");
    await expect(page.locator("main h1")).toHaveText("A missing page.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Search for this title →" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("Find a thought.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.goto(`/wiki/${source.id}`);
    await activate(page, "Deleted article");
    await expect(page.locator("main h1")).toHaveText("This page is missing.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Back to home →" })).toBeFocused();
  } finally {
    for (const id of owned.reverse()) {
      const latest = await request.get(`/api/wiki/pages/${id}`);
      if (latest.ok()) expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
        base_revision: (await latest.json()).revision, request_id: randomUUID(),
      }})).ok()).toBeTruthy();
    }
  }
});

test("slow home and galaxy arrivals preserve deliberately chosen focus", async ({ page }) => {
  for (const [name, endpoint] of [["Home", "pages"], ["Galaxy", "graph"]]) {
    await page.goto("/wiki/night-sky-survey");
    await expect(page.locator("article > h1")).toBeVisible();
    let release!: () => void;
    let received!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { received = resolve; });
    const pattern = `**/api/wiki/${endpoint}`;
    await page.route(pattern, async route => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await activate(page, name);
      await held;
      const main = page.locator("#main-content");
      await main.focus();
      release();
      await expect(page.locator("main h1")).toBeVisible();
      await expect(main).toBeFocused();
    } finally { release(); await page.unroute(pattern); }
  }
});

test("resolved links retain header focus chosen during the real resolution read", async ({ page, request }) => {
  const source = await create(request, "# Resolve source\n\n[Resolve survey](/resolve?target=night-sky-survey)");
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { received = resolve; });
  // Hold only this navigation read, not the destination article's independent
  // wikilink hydration requests, which may still be running during cleanup.
  const pattern = "**/api/wiki/resolve-links?source=&target=night-sky-survey";
  let delivered!: () => void;
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  try {
    await page.goto(`/wiki/${source.id}`);
    await expect(page.locator("article > h1")).toHaveText("Resolve source");
    await page.route(pattern, async route => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
      delivered();
    });
    await activate(page, "Resolve survey");
    await held;
    const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
    await search.focus();
    release();
    await completed;
    await expect(page.locator("article > h1")).toHaveText("Night sky survey");
    await expect(search).toBeFocused();
  } finally {
    release?.(); await page.unroute(pattern);
    expect((await request.delete(`/api/wiki/pages/${source.id}`, { data: {
      base_revision: source.revision, request_id: randomUUID(),
    }})).ok()).toBeTruthy();
  }
});

for (const width of [390, 1440]) {
  test(`search reports submitted outcomes without taking draft focus (${width})`, async ({ page, request }, info) => {
    const term = `status${randomUUID().replace(/-/g, "")}`;
    const missing = `absent${randomUUID().replace(/-/g, "")}`;
    const fixtures: { id: string; revision: string }[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const held = new Promise<void>(resolve => { received = resolve; });
    const pattern = `**/api/wiki/search?q=${term}`;
    await page.setViewportSize({ width, height: 844 });
    try {
      for (const title of ["Harbor observations", "Garden observations"])
        fixtures.push(await create(request, `# ${title}\n\n${term}`));
      await page.route(pattern, async route => {
        const response = await route.fetch(); // Hold the actual indexed search.
        expect((await response.json()).results).toHaveLength(2);
        received();
        await gate;
        await route.fulfill({ response });
      }, { times: 1 });
      await page.goto("/search");
      const input = page.getByRole("textbox", { name: "Search pages" });
      const status = page.locator("#search-status");
      const results = page.locator("#results");
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(status).toHaveAttribute("aria-atomic", "true");
      await expect(status).toBeEmpty();
      await input.fill(term);
      await page.keyboard.press("Enter");
      await held;
      await expect(status).toHaveText(`Searching for “${term}”…`);
      await expect(results).toHaveAttribute("aria-busy", "true");
      await input.fill("Unsubmitted garden query");
      await expect(input).toBeFocused();
      // Its identity survives every update; result cards are outside the live node.
      await status.evaluate(node => { (window as any).__searchStatus = node; });
      release();
      await expect(status).toHaveText(`2 results for “${term}”.`);
      await expect(results).toHaveAttribute("aria-busy", "false");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Unsubmitted garden query");
      await expect(page).toHaveURL(new RegExp(`/search\\?q=${term}$`));
      await expect(results.locator(".card")).toHaveCount(2);
      await expect(status.locator("a")).toHaveCount(0);
      expect(await status.evaluate(node => node === (window as any).__searchStatus)).toBe(true);
      await page.screenshot({ path: info.outputPath(`search-status-results-${width}.png`) });

      await input.fill(missing);
      await page.keyboard.press("Enter");
      await expect(status).toHaveText(`No pages found for “${missing}”. Try another word or phrase.`);
      await expect(results.locator(".card")).toHaveCount(0);
      await expect(results).toHaveAttribute("aria-busy", "false");
      await expect(input).toBeFocused();

      await page.route(pattern, route => route.fulfill({ status: 503,
        json: { message: "Synthetic search unavailable." },
      }), { times: 1 }); // Explicit UI failure injection, not a real outage.
      await input.fill(term);
      await page.keyboard.press("Enter");
      await expect(status).toHaveText(`Search failed for “${term}”. Synthetic search unavailable. Submit your search to try again.`);
      await expect(results).toHaveAttribute("aria-busy", "false");
      await expect(input).toBeFocused();
      await page.screenshot({ path: info.outputPath(`search-status-error-${width}.png`) });
      await page.keyboard.press("Enter");
      await expect(status).toHaveText(`2 results for “${term}”.`);
      await expect(results).toHaveAttribute("aria-busy", "false");
      await expect(input).toBeFocused();
      expect(await status.evaluate(node => node === (window as any).__searchStatus)).toBe(true);
      const result = results.getByRole("link", { name: /Garden observations/ });
      await result.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("article > h1")).toHaveText("Garden observations");
      await expect(page.locator("article > h1")).toBeFocused();
      await expect(status).toHaveCount(0);
      console.log(`[search-status] ${JSON.stringify({ width, mountedStatus: true, submittedCount: 2,
        empty: true, scriptedError: true, realRetry: true, draftFocusPreserved: true })}`);
      // Reproduce a closed page before cleanup: fixture deletion must use the
      // independent API context, without an unroute call blocking that work.
      await page.close();
    } finally {
      release();
      for (const fixture of fixtures)
        expect((await request.delete(`/api/wiki/pages/${fixture.id}`, { data: {
          base_revision: fixture.revision, request_id: randomUUID(),
        }})).ok()).toBeTruthy();
      console.log(`[search-fixture-cleanup] ${JSON.stringify({ width, deleted: fixtures.length, pageClosed: page.isClosed() })}`);
    }
  });
}

for (const width of [390, 1440]) {
  test(`backlink replies respect newer header focus (${width})`, async ({ page, request }, info) => {
    const fixture = await create(request, "# Backlink focus observation\n\nAn invented reading destination.");
    const releases: (() => void)[] = [];
    const heldRead = async (pattern: string, fail = false) => {
      let release!: () => void, received!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = new Promise<void>(resolve => { received = resolve; });
      releases.push(release);
      await page.route(pattern, async route => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true); // Actual service snapshot, even for injected failure.
        received();
        await gate;
        if (fail) await route.fulfill({ status: 503, json: { message: "Synthetic backlink read unavailable." } });
        else await route.fulfill({ response });
      }, { times: 1 });
      return { held, release };
    };
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/wiki/${fixture.id}`);
      const panel = page.locator(".page-backlinks");
      await panel.locator("summary").click();
      const refresh = panel.getByRole("button", { name: "Refresh links", exact: true });
      await expect(refresh).toBeVisible();
      const header = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
      const visit = await page.evaluate(() => ({ url: location.href, length: history.length, entry: history.state }));
      const proof: { phase: string; headerFocused: boolean }[] = [];
      const preservesHeader = async (phase: string) => {
        const headerFocused = await header.evaluate(node => node === document.activeElement);
        proof.push({ phase, headerFocused });
        expect.soft(headerFocused, `${phase} must retain deliberate header focus`).toBe(true);
        expect(await page.evaluate(() => ({ url: location.href, length: history.length, entry: history.state }))).toEqual(visit);
      };
      for (const phase of ["refresh", "read-error", "revision-mismatch"] as const) {
        if (phase === "revision-mismatch") {
          const update = await request.post(`/api/wiki/pages/${fixture.id}`, { data: {
            markdown: "# Backlink focus observation\n\nA newer invented reading destination.",
            base_revision: fixture.revision, request_id: randomUUID(),
          }});
          expect(update.ok()).toBe(true);
        }
        const hold = await heldRead(`**/api/wiki/pages/${fixture.id}/backlinks`, phase === "read-error");
        await refresh.focus();
        await page.keyboard.press("Enter");
        await hold.held;
        await header.focus();
        await expect(header).toBeFocused();
        hold.release();
        await expect(panel).toContainText(phase === "refresh" ? "No other pages link here yet." :
          phase === "read-error" ? "Couldn’t load incoming links." : "This article has changed.");
        await preservesHeader(phase);
        if (phase === "refresh") await page.screenshot({ path: info.outputPath(`backlink-refresh-focus-${width}.png`) });
        if (phase === "read-error") {
          await panel.getByRole("button", { name: "Try again", exact: true }).focus();
          await page.keyboard.press("Enter");
          await expect(refresh).toBeVisible();
          await expect(refresh).toBeFocused(); // Uninterrupted retry still restores its control.
        }
      }
      const reload = panel.getByRole("button", { name: "Reload article", exact: true });
      for (const fail of [true, false]) {
        const hold = await heldRead(`**/api/wiki/pages/${fixture.id}`, fail);
        await reload.focus();
        await page.keyboard.press("Enter");
        await hold.held;
        await header.focus();
        await expect(header).toBeFocused();
        hold.release();
        if (fail) {
          await expect(panel).toContainText("Couldn’t reload this article.");
          await expect(reload).toBeEnabled();
        } else await expect(page.locator(".prose")).toContainText("A newer invented reading destination.");
        await preservesHeader(fail ? "reload-error" : "reload-success");
      }
      await page.screenshot({ path: info.outputPath(`backlink-reload-focus-${width}.png`) });
      console.log(`[backlink-focus] ${JSON.stringify({ width, proof, scriptedFailures: 2, actualReload: true })}`);
      await page.close();
    } finally {
      for (const release of releases) release();
      await deleteReadingPages(request, [fixture.id]);
      expect((await request.get(`/api/wiki/pages/${fixture.id}`)).status()).toBe(404);
      console.log(`[backlink-focus-cleanup] ${JSON.stringify({ width, deleted: true, pageClosed: page.isClosed() })}`);
    }
  });
}

for (const width of [390, 1440]) {
  test(`article reload retains a newer history choice (${width})`, async ({ page, request }, info) => {
    const fixture = await create(request, "# History during reload\n\nAn invented reading destination.");
    let release!: () => void, received!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { received = resolve; });
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/wiki/${fixture.id}`);
      const backlinks = page.locator(".page-backlinks");
      await backlinks.locator("summary").click();
      const refresh = backlinks.getByRole("button", { name: "Refresh links", exact: true });
      await expect(refresh).toBeVisible();
      const update = await request.post(`/api/wiki/pages/${fixture.id}`, { data: {
        markdown: "# History during reload\n\nA newer invented reading destination.",
        base_revision: fixture.revision, request_id: randomUUID(),
      }});
      expect(update.ok()).toBe(true);
      const expected = await request.get(`/api/wiki/pages/${fixture.id}/history`);
      expect(expected.ok()).toBe(true);
      const entries: { commit: string }[] = (await expected.json()).history;
      expect(entries.length).toBe(2);
      await refresh.focus();
      await page.keyboard.press("Enter");
      const reload = backlinks.getByRole("button", { name: "Reload article", exact: true });
      await expect(reload).toBeVisible();
      await page.route(`**/api/wiki/pages/${fixture.id}`, async route => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        received();
        await gate;
        await route.fulfill({ response });
      }, { times: 1 });
      const visit = await page.evaluate(() => ({ url: location.href, length: history.length, entry: history.state }));
      await reload.focus();
      await page.keyboard.press("Enter");
      await held;
      const historyPanel = page.locator(".page-history");
      const summary = historyPanel.locator("summary");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(summary).toBeFocused();
      await expect(historyPanel).toHaveJSProperty("open", true);
      await expect(historyPanel.locator(".history-list li")).toHaveCount(entries.length);
      release();
      await expect(page.locator(".prose")).toContainText("A newer invented reading destination.");
      const proof = await summary.evaluate(node => ({ focused: node === document.activeElement,
        open: (node.parentElement as HTMLDetailsElement).open, bodyFocused: document.activeElement === document.body }));
      console.log(`[reload-history-focus] ${JSON.stringify({ width, ...proof, actualReload: true })}`);
      expect.soft(proof.focused, "Reload must retain the newer history summary focus").toBe(true);
      expect.soft(proof.open, "Reload must retain the chosen open history").toBe(true);
      expect.soft(proof.bodyFocused, "Reload must not strand focus on body").toBe(false);
      expect(await page.evaluate(() => ({ url: location.href, length: history.length, entry: history.state }))).toEqual(visit);
      if (proof.open) {
        await expect(historyPanel.locator(".history-list li")).toHaveCount(entries.length);
        for (const entry of entries)
          await expect(historyPanel.locator(`code[title="${entry.commit}"]`)).toHaveCount(1);
      }
      await page.screenshot({ path: info.outputPath(`reload-history-focus-${width}.png`) });
      await page.close();
    } finally {
      release();
      await deleteReadingPages(request, [fixture.id]);
      expect((await request.get(`/api/wiki/pages/${fixture.id}`)).status()).toBe(404);
      console.log(`[reload-history-cleanup] ${JSON.stringify({ width, deleted: true, pageClosed: page.isClosed() })}`);
    }
  });
}

test("direct views retain the skip-link and cross-route main fragments take precedence", async ({ page, request }) => {
  for (const path of ["/?overview=1", "/search", "/galaxy", "/chat"]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
  }
  const source = await create(request, "# Fragment source\n\n[Survey content](/wiki/night-sky-survey#main-content)");
  try {
    await page.goto(`/wiki/${source.id}`);
    await activate(page, "Survey content");
    await expect(page.locator("main h1")).toHaveText("Night sky survey");
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goBack();
    await expect(page.locator("article > h1")).toBeFocused();
    await page.goForward();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goto("/search#main-content");
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goto("/chat");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.locator("#chat-input")).toBeFocused();
  } finally {
    expect((await request.delete(`/api/wiki/pages/${source.id}`, { data: {
      base_revision: source.revision, request_id: randomUUID(),
    }})).ok()).toBeTruthy();
  }
});

// A real native transaction holds initialization; no timer substitutes for readiness.
for (const width of [390, 1440]) {
  for (const destination of ["heading", "header"] as const) {
    test(`chat waits for native initialization before route focus (${width}, ${destination})`, async ({ page, context }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/?overview=1");
      const peer = await context.newPage();
      await peer.goto("/?overview=1");
      await seedChats(peer, []);
      await holdChatWriter(peer);
      let released = false;
      try {
        const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
        await navigation.getByRole("link", { name: "Chat", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("main h1")).toHaveCount(0);
        await expect(page.locator("main [role=status]")).toContainText("Opening your conversations");
        const header = navigation.getByRole("link", { name: "Search", exact: true });
        if (destination === "header") await header.focus();
        await releaseChatWriter(peer);
        released = true;
        await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
        const heading = page.locator("#chat-title");
        await expect(heading).toHaveAttribute("tabindex", "-1");
        if (destination === "header") {
          await expect(header).toBeFocused();
          await expect(heading).not.toBeFocused();
        } else {
          await expect(heading).toBeFocused();
          await expect(page.getByLabel("Message", { exact: true })).not.toBeFocused();
          expect(await page.evaluate(() => scrollY)).toBe(0);
          await page.keyboard.press("Tab");
          await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
          await page.screenshot({ path: info.outputPath(`chat-ready-focus-${width}.png`), fullPage: true });
        }
      } finally {
        if (!released) await releaseChatWriter(peer);
        await peer.close();
      }
    });
  }
}

test("leaving chat during native initialization cannot complete the departed route", async ({ page, context }) => {
  await page.goto("/?overview=1");
  const peer = await context.newPage();
  await peer.goto("/?overview=1");
  await seedChats(peer, []);
  await holdChatWriter(peer);
  let released = false;
  try {
    const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
    await navigation.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.locator("main [role=status]")).toContainText("Opening your conversations");
    await navigation.getByRole("link", { name: "Home", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A growing collection", exact: true })).toBeVisible();
    const before = await page.locator("main").innerHTML();
    await releaseChatWriter(peer);
    released = true;
    // A subsequent native transaction establishes that the aborted queued read ran.
    await seedChats(peer, []);
    expect(await page.locator("main").innerHTML()).toBe(before);
    await expect(page).toHaveURL(/\/\?overview=1$/);
    await expect(page.locator("#chat-title")).toHaveCount(0);
  } finally {
    if (!released) await releaseChatWriter(peer);
    await peer.close();
  }
});
