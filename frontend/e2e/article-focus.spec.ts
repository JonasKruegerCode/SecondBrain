import { expect, Page, TestInfo, type CDPSession } from "@playwright/test";
import { test } from "./reading-test";
import { randomUUID } from "node:crypto";

for (const width of [320, 390, 1440]) {
  test(`long article contents preserves the reading entry and keyboard section navigation (${width})`, async ({ page, request }, info) => {
    const id = `contents-${randomUUID()}`, endpoint = `/api/wiki/pages/${id}`;
    const markdown = "# Field compendium\n\nRead the introduction before exploring the sections.\n\n" +
      Array.from({ length: 20 }, (_, i) => `## Observation ${i + 1}\n\nSynthetic field observation.\n\n`).join("");
    const created = await request.post(endpoint, { data: { markdown, base_revision: null, request_id: randomUUID() } });
    expect(created.ok()).toBe(true);
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/wiki/${id}`);
      const contents = page.locator(".article-toc details"), summary = contents.locator("summary");
      await expect(contents).not.toHaveAttribute("open", "");
      await expect(page.locator(".prose p").first()).toBeInViewport();
      expect((await contents.boundingBox())!.height).toBeLessThan(100);
      await page.screenshot({ path: info.outputPath(`long-contents-closed-${width}.png`) });
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(contents).toHaveAttribute("open", "");
      const last = contents.getByRole("link", { name: "Observation 20", exact: true });
      await last.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".prose h2").last()).toBeFocused();
      await expect(page.locator(".prose h2").last()).toBeInViewport();
      await summary.focus();
      await page.keyboard.press("Space");
      await expect(contents).not.toHaveAttribute("open", "");
      await expect(summary).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await (await request.get(endpoint)).json()).markdown).toBe(markdown);
    } finally {
      const current = await (await request.get(endpoint)).json();
      expect((await request.delete(endpoint, { data: { base_revision: current.revision, request_id: randomUUID() } })).ok()).toBe(true);
    }
  });
}

async function arrival(page: Page, title: string, info: TestInfo, width: number, step: string) {
  const heading = page.locator("article > h1");
  await expect(heading).toHaveText(title);
  const observed = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.tagName === "BODY" ? null : document.activeElement?.textContent,
    scrollY,
  }));
  console.log(`[article-focus] ${JSON.stringify({ width, step, observed })}`);
  await expect(heading).toBeFocused();
  expect(observed.scrollY).toBe(0);
  await page.keyboard.press("Tab");
  await expect(page.locator(".article-toc a").first()).toBeFocused();
  await page.screenshot({ path: info.outputPath(`article-focus-${step}-${width}.png`) });
}

for (const width of [390, 1440]) {
  test(`keyboard article arrivals retain a useful reading destination (${width})`, async ({ page, context }, info) => {
    const browser = context.browser();
    let cdp: CDPSession | null = null;
    let cdpUnavailable = false;
    const targets: { type: string; url: string; opener: boolean }[] = [];
    const targetIds = new Map<string, number>();
    const lifecycle: unknown[] = [];
    let activationStartedAt: number | null = null;
    const recordLifecycle = (event: string, detail: object) => {
      if (activationStartedAt !== null && lifecycle.length < 32) {
        lifecycle.push({ event, elapsedMs: Date.now() - activationStartedAt, ...detail });
      }
    };
    const onContextPage = (opened: Page) => recordLifecycle("context-page", { url: opened.url(), closed: opened.isClosed() });
    context.on("page", onContextPage);
    // Setup precedes navigation so protocol round trips do not delay the
    // first native gesture. Optional diagnostics cannot replace its outcome.
    if (browser?.browserType().name() === "chromium") {
      try {
        cdp = await browser.newBrowserCDPSession();
        const known = new Set((await cdp.send("Target.getTargets")).targetInfos.map(target => target.targetId));
        cdp.on("Target.targetCreated", ({ targetInfo }) => {
          if (targetInfo.type === "page" && !known.has(targetInfo.targetId) && targetIds.size < 16) {
            targetIds.set(targetInfo.targetId, targetIds.size + 1);
            targets.push({ type: targetInfo.type, url: targetInfo.url, opener: Boolean(targetInfo.openerId) });
            recordLifecycle("target-created", { target: targetIds.get(targetInfo.targetId), url: targetInfo.url,
              attached: targetInfo.attached, opener: Boolean(targetInfo.openerId) });
          }
        });
        cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
          if (targetIds.has(targetInfo.targetId)) recordLifecycle("target-changed", {
            target: targetIds.get(targetInfo.targetId), url: targetInfo.url, attached: targetInfo.attached });
        });
        cdp.on("Target.targetDestroyed", ({ targetId }) => {
          if (targetIds.has(targetId)) recordLifecycle("target-destroyed", { target: targetIds.get(targetId) });
        });
        await cdp.send("Target.setDiscoverTargets", { discover: true });
      } catch {
        cdpUnavailable = true;
        await cdp?.detach().catch(() => {});
        cdp = null;
      }
    }
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/?overview=1");
      const open = page.getByRole("link", { name: /Open Lantern Bay field atlas/ });
      await expect(open).toBeVisible();
      await open.focus();
      await page.keyboard.press("Enter");
      await arrival(page, "Lantern Bay field atlas", info, width, "home");
      // Follow the actual native new-tab gesture, rather than assigning window.open
      // or scripting a click event whose browser default would never run.
      const contentsLink = page.locator(".article-toc a").first();
      const fragment = await contentsLink.getAttribute("href");
      expect(fragment).toBe("#section-1");
      await contentsLink.scrollIntoViewIfNeeded();
      const source = await page.evaluate(() => ({ url: location.href, scrollY, title: document.title }));
      await page.evaluate(() => {
        window.addEventListener("click", event => {
          (window as any).__tocActivation = { button: event.button, ctrl: event.ctrlKey,
            meta: event.metaKey, prevented: event.defaultPrevented, trusted: event.isTrusted };
        }, { once: true });
        const link = document.querySelector<HTMLAnchorElement>(".article-toc a");
        const events: unknown[] = [], notices: unknown[] = [];
        const box = link?.getBoundingClientRect();
        const initialBox = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
        const describe = (element: Element | null) => {
          const anchor = element?.closest("a");
          return { tag: element?.tagName ?? null, id: element?.id ?? null,
            anchorHref: anchor?.getAttribute("href") ?? null,
            anchorUrl: anchor instanceof HTMLAnchorElement ? anchor.href : null,
            connected: element?.isConnected ?? false, anchorConnected: anchor?.isConnected ?? false,
            tocAnchor: anchor === link };
        };
        const record = (event: MouseEvent) => {
          // Native event targets discriminate down/up drift without forcing a
          // synchronous layout/hit-test read inside each event listener.
          events.push({ type: event.type, at: performance.now(), target: describe(event.target instanceof Element ? event.target : null),
            x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons, detail: event.detail,
            ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey,
            trusted: event.isTrusted, prevented: event.defaultPrevented,
            focused: document.hasFocus(), visibility: document.visibilityState });
        };
        const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
        for (const type of types) window.addEventListener(type, record as EventListener);
        const notice = document.querySelector<HTMLElement>(".pwa-notice");
        const noticeState = () => notices.push({ at: performance.now(), hidden: notice?.hidden,
          kind: notice?.dataset.kind ?? null });
        noticeState();
        const observer = new MutationObserver(noticeState);
        if (notice) observer.observe(notice, { attributes: true, attributeFilter: ["hidden", "data-kind"] });
        (window as any).__tocTrace = { initialBox, events, notices };
        (window as any).__stopTocTrace = () => {
          for (const type of types) window.removeEventListener(type, record as EventListener);
          observer.disconnect();
        };
      });
      targets.length = 0;
      targetIds.clear();
      activationStartedAt = Date.now();
      // A browser-created tab need not retain an opener/popup association.
      const [opened] = await Promise.all([
        context.waitForEvent("page", { timeout: 8000 }),
        contentsLink.click({ modifiers: ["ControlOrMeta"] }),
      ]).catch(async error => {
        console.log(`[toc-tab-diagnostic] ${JSON.stringify({ width, pages: context.pages().length,
          activation: await page.evaluate(() => (window as any).__tocActivation), sourceUrl: page.url() })}`);
        throw error;
      }).finally(async () => {
        const dom = await page.evaluate(() => {
          (window as any).__stopTocTrace?.();
          const trace = (window as any).__tocTrace;
          delete (window as any).__stopTocTrace;
          delete (window as any).__tocTrace;
          return trace;
        }).catch(() => ({ unavailable: true }));
        activationStartedAt = null;
        console.log(`[toc-activation-trace] ${JSON.stringify({ width, cdp: Boolean(cdp), cdpUnavailable, targets,
          lifecycle, contextPages: context.pages().map(item => ({ url: item.url(), closed: item.isClosed() })), dom })}`);
      });
      try {
        await opened.bringToFront();
        await opened.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => (window as any).__tocActivation))
          .toMatchObject({ button: 0, prevented: false, trusted: true });
        await expect(opened).toHaveURL(source.url + fragment);
        await expect(opened.locator("article > h1")).toHaveText("Lantern Bay field atlas");
        await expect(opened.locator(fragment!)).toBeFocused();
        await opened.reload();
        await expect(opened).toHaveURL(source.url + fragment);
        await expect(opened.locator(fragment!)).toBeFocused();
        await expect(opened.locator(fragment!)).toHaveText("Three routes into the atlas");
        await opened.screenshot({ path: info.outputPath(`toc-native-tab-${width}.png`) });
        expect(await page.evaluate(() => ({ url: location.href, scrollY, title: document.title }))).toEqual(source);
        await expect(page.locator(fragment!)).not.toBeFocused();
        console.log(`[toc-native-tab] ${JSON.stringify({ width, sourceUnchanged: true, fragment, targetReloaded: true })}`);
      } finally { await opened.close(); }
      // Ordinary keyboard activation still focuses the section in this visit,
      // without changing the established TOC URL/history behavior.
      await contentsLink.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(fragment!)).toBeFocused();
      await expect(page).toHaveURL(source.url);

      const survey = page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true });
      await survey.focus();
      await page.keyboard.press("Enter");
      await arrival(page, "Night sky survey", info, width, "wikilink");
      const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
      await search.focus();
      await page.keyboard.press("Enter");
      const input = page.getByRole("textbox", { name: "Search pages" });
      await input.fill("sheltered garden");
      await page.keyboard.press("Enter");
      const result = page.locator('#results a[href="/wiki/night-sky-survey"]');
      await expect(result).toBeVisible();
      await result.focus();
      await page.keyboard.press("Enter");
      await arrival(page, "Night sky survey", info, width, "search");
    } finally {
      context.off("page", onContextPage);
      await page.evaluate(() => {
        (window as any).__stopTocTrace?.();
        delete (window as any).__stopTocTrace;
        delete (window as any).__tocTrace;
      }).catch(() => {});
      await cdp?.detach().catch(() => {});
    }
  });
}

async function holdRead(page: Page, pattern: string) {
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { received = resolve; });
  await page.route(pattern, async route => {
    console.info("[held-article-read] handler entered");
    const response = await route.fetch();
    console.info("[held-article-read] actual response fetched");
    received();
    await gate;
    await route.fulfill({ response });
  });
  return { held, release };
}

test("fresh URLs, fragment arrivals and history keep their distinct focus paths", async ({ page }) => {
  await page.goto("/wiki/night-sky-survey");
  await expect(page.locator("article > h1")).toHaveText("Night sky survey");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
  await page.goto("/wiki/night-sky-survey#Sample%20log");
  const section = page.getByRole("heading", { name: "Sample log", exact: true });
  await expect(section).toBeFocused();
  const tide = page.locator(".prose").getByRole("link", { name: "tide clock", exact: true });
  await tide.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("article > h1")).toHaveText("Tide clock project");
  await expect(page.locator("article > h1")).toBeFocused();
  await page.goBack();
  await expect(page.locator("article > h1")).toHaveText("Night sky survey");
  await expect(section).toBeFocused();
  await page.goForward();
  await expect(page.locator("article > h1")).toHaveText("Tide clock project");
  await expect(page.locator("article > h1")).toBeFocused();
});

test("an arriving article respects deliberate header or main focus during its real read", async ({ page }) => {
  for (const destination of ["header", "main"]) {
    await page.goto("/wiki/home");
    await expect(page.locator("article > h1")).toHaveText("Lantern Bay field atlas");
    const hold = await holdRead(page, "**/api/wiki/pages/night-sky-survey");
    try {
      await page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true }).click();
      await hold.held;
      const target = destination === "main" ? page.locator("#main-content") :
        page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
      await target.focus();
      hold.release();
      await expect(page.locator("article > h1")).toHaveText("Night sky survey");
      await expect(target).toBeFocused();
      await expect(page.locator("article > h1")).not.toBeFocused();
    } finally {
      hold.release();
      await page.unroute("**/api/wiki/pages/night-sky-survey");
    }
  }
});

test("a late article read cannot take focus from a newer search", async ({ page }) => {
  await page.goto("/wiki/home");
  await expect(page.locator("article > h1")).toHaveText("Lantern Bay field atlas");
  const hold = await holdRead(page, "**/api/wiki/pages/night-sky-survey");
  try {
    await page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true }).click();
    await hold.held;
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Search pages" });
    await input.fill("Unsubmitted synthetic search");
    await input.focus();
    // Wait until the actual delayed response has completed before checking the
    // latest view. This is scripted timing, not an API outage claim.
    const responded = page.waitForResponse(response => response.url().endsWith("/api/wiki/pages/night-sky-survey"));
    hold.release();
    await (await responded).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Unsubmitted synthetic search");
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("article")).toHaveCount(0);
  } finally { hold.release(); }
});

test("a saved-start redirect preserves focus chosen during the page-list read", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("secondbrain.startpage", "night-sky-survey"));
  const hold = await holdRead(page, "**/api/wiki/pages");
  try {
    await page.goto("/");
    await hold.held;
    const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
    await search.focus();
    hold.release();
    await expect(page.locator("article > h1")).toHaveText("Night sky survey");
    await expect(search).toBeFocused();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home", exact: true })).not.toHaveAttribute("aria-current", "page");
  } finally { hold.release(); }
});
