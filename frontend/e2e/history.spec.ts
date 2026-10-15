import { test, expect, APIRequestContext, Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
type Owned = { id: string; revision: string };
type Entry = { commit: string; date: string; message: string };
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function create(request: APIRequestContext, title: string, owned: Owned[]) {
  const id = `history-e2e-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown: `# ${title}\nSynthetic history fixture.`, base_revision: null, request_id: randomUUID() } });
  expect(response.ok()).toBe(true);
  const item = { id, revision: (await response.json()).revision as string }; owned.push(item); return item;
}
async function revise(request: APIRequestContext, item: Owned, title: string) {
  const response = await request.post(`/api/wiki/pages/${item.id}`, { data: { markdown: `# ${title}\nSecond synthetic revision.`, base_revision: item.revision, request_id: randomUUID() } });
  expect(response.ok()).toBe(true); item.revision = (await response.json()).revision;
}
async function cleanup(request: APIRequestContext, owned: Owned[]) {
  for (const item of owned.reverse()) {
    const response = await request.delete(`/api/wiki/pages/${item.id}`, { data: { base_revision: item.revision, request_id: randomUUID() } });
    expect(response.ok(), `cleanup ${item.id}`).toBe(true);
  }
}
async function history(request: APIRequestContext, id: string): Promise<Entry[]> {
  const response = await request.get(`/api/wiki/pages/${id}/history`); expect(response.ok()).toBe(true); return (await response.json()).history;
}
async function observe(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { historyBodies: Record<string, number>; historyFailures: Record<string, number> };
    state.historyBodies = {}; state.historyFailures = {};
    const parse = Response.prototype.json;
    Response.prototype.json = async function () {
      const body = await parse.call(this), path = this.url ? new URL(this.url).pathname : "";
      if (path.endsWith("/history")) setTimeout(() => { state.historyBodies[path] = (state.historyBodies[path] || 0) + 1; }, 0);
      return body;
    };
    const original = window.fetch;
    window.fetch = async function (...args) {
      try { return await original.apply(this, args); }
      catch (error) {
        const input = args[0], path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        if (path.endsWith("/history")) setTimeout(() => { state.historyFailures[path] = (state.historyFailures[path] || 0) + 1; }, 0);
        throw error;
      }
    };
  });
}
async function settled(page: Page, id: string, kind: "historyBodies" | "historyFailures", count = 1) {
  // The zero-delay observer runs after the UI promise chain, preventing premature stale-result assertions.
  await page.waitForFunction(({ path, kind, count }) => ((window as unknown as Record<string, Record<string, number>>)[kind][path] || 0) === count, { path: `/api/wiki/pages/${id}/history`, kind, count });
}
async function toggle(page: Page, open: boolean) {
  await page.locator(".page-history summary").focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".page-history")).toHaveJSProperty("open", open);
}
async function matches(page: Page, entries: Entry[]) {
  expect(entries.length).toBeGreaterThan(0);
  const rows = page.locator(".history-list li"); await expect(rows).toHaveCount(entries.length);
  for (const [i, entry] of entries.entries()) {
    await expect(rows.nth(i).locator("p")).toHaveText(entry.message);
    await expect(rows.nth(i).locator("code")).toHaveText(entry.commit.slice(0, 8));
    await expect(rows.nth(i).locator("code")).toHaveAttribute("title", entry.commit);
    await expect(rows.nth(i).locator("time")).toHaveAttribute("datetime", entry.date);
  }
  await expect(page.locator(".history-content .error")).toHaveCount(0);
}
async function screenshots(page: Page, info: TestInfo, state: string, assertion: () => Promise<void>) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 }); await assertion();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const target = await page.locator(".page-history summary").boundingBox();
    expect(target!.height, "History reopening must retain a usable touch target").toBeGreaterThanOrEqual(44);
    await page.locator(".page-history").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`history-${state}-${width}.png`), fullPage: true });
  }
}
test("keyboard history reopening while pending shares one real Git request", async ({ page, request }, info) => {
  const owned: Owned[] = [], gate = latch(), fetched = latch(), fulfilled = latch(); let calls = 0; let entries: Entry[] = [];
  try {
    const item = await create(request, "Synthetic keyboard history", owned); await revise(request, item, "Synthetic keyboard history"); await observe(page);
    await page.route(`**/api/wiki/pages/${item.id}/history`, async route => {
      calls++; const response = await route.fetch(); expect(response.ok()).toBe(true); entries = (await response.json()).history;
      fetched.resolve(); await gate.promise; await route.fulfill({ response }); fulfilled.resolve();
    });
    await page.goto(`/wiki/${item.id}`); await expect(page.locator("article h1")).toHaveText("Synthetic keyboard history"); expect(calls).toBe(0);
    await toggle(page, true); await fetched.promise; expect(entries).toHaveLength(2); expect(entries).toEqual(await history(request, item.id));
    const loading = async () => { await expect(page.locator(".history-content")).toHaveText("Loading recent changes…"); };
    await screenshots(page, info, "loading", loading); await toggle(page, false); await toggle(page, true); await loading(); expect(calls).toBe(1);
    gate.resolve(); await fulfilled.promise; await settled(page, item.id, "historyBodies"); await matches(page, entries); expect(calls).toBe(1);
  } finally { gate.resolve(); await cleanup(request, owned); }
});
test("scripted one-shot transport failure retries through the real history endpoint", async ({ page, request }, info) => {
  const owned: Owned[] = []; let calls = 0; let entries: Entry[] = [];
  try {
    const item = await create(request, "Synthetic retry history", owned); await observe(page);
    await page.route(`**/api/wiki/pages/${item.id}/history`, async route => {
      if (++calls === 1) { await route.abort("failed"); return; }
      const response = await route.fetch(); expect(response.ok()).toBe(true); entries = (await response.json()).history; await route.fulfill({ response });
    });
    await page.goto(`/wiki/${item.id}`); await toggle(page, true); await settled(page, item.id, "historyFailures");
    const error = async () => { await expect(page.locator(".history-content .error")).toContainText("Close and reopen history to retry."); await expect(page.locator(".history-list")).toHaveCount(0); };
    await screenshots(page, info, "scripted-transport-error", error); expect(calls).toBe(1);
    await toggle(page, false); await toggle(page, true); await settled(page, item.id, "historyBodies"); expect(calls).toBe(2); expect(entries).toEqual(await history(request, item.id));
    await screenshots(page, info, "real-endpoint-recovered", () => matches(page, entries));
  } finally { await cleanup(request, owned); }
});
for (const outcome of ["real success", "scripted transport failure"] as const) {
  test(`late history ${outcome} cannot contaminate the next article history`, async ({ page, request }) => {
    const owned: Owned[] = [], gate = latch(), fetched = latch(), finished = latch(); let oldEntries: Entry[] = [];
    try {
      const first = await create(request, "Synthetic old article", owned), next = await create(request, "Synthetic next article", owned); await revise(request, first, "Synthetic old article"); await observe(page);
      await page.route(`**/api/wiki/pages/${first.id}/history`, async route => {
        const response = await route.fetch(); expect(response.ok()).toBe(true); oldEntries = (await response.json()).history; fetched.resolve(); await gate.promise;
        if (outcome === "real success") await route.fulfill({ response }); else await route.abort("failed"); finished.resolve();
      });
      await page.goto(`/wiki/${first.id}`); await toggle(page, true); await fetched.promise; await expect(page.locator(".history-content")).toHaveText("Loading recent changes…");
      // SPA navigation retains the old asynchronous operation in the same document.
      await page.getByRole("link", { name: "All pages", exact: false }).click(); await page.locator(`a[href="/wiki/${next.id}"]`).first().click();
      await expect(page.locator("article h1")).toHaveText("Synthetic next article"); await expect(page.locator(".page-history")).toHaveJSProperty("open", false);
      const nextEntries = await history(request, next.id); await toggle(page, true); await settled(page, next.id, "historyBodies"); await matches(page, nextEntries);
      gate.resolve(); await finished.promise; await settled(page, first.id, outcome === "real success" ? "historyBodies" : "historyFailures");
      await expect(page.locator("article h1")).toHaveText("Synthetic next article"); await matches(page, nextEntries);
      for (const entry of oldEntries) await expect(page.locator(`.history-list code[title="${entry.commit}"]`)).toHaveCount(0);
    } finally { gate.resolve(); await cleanup(request, owned); }
  });
}
test("reopening history refreshes commits after an external real REST revision", async ({ page, request }, info) => {
  const owned: Owned[] = [];
  try {
    const item = await create(request, "Synthetic external revision", owned); await observe(page);
    await page.goto(`/wiki/${item.id}`); await toggle(page, true); await settled(page, item.id, "historyBodies");
    const before = await history(request, item.id); await matches(page, before);
    await revise(request, item, "Synthetic external revision"); const current = await history(request, item.id);
    expect(current).toHaveLength(before.length + 1); expect(current[0].commit).not.toBe(before[0].commit);
    expect(current.slice(1)).toEqual(before);
    await toggle(page, false); await toggle(page, true); await settled(page, item.id, "historyBodies", 2);
    await screenshots(page, info, "current-after-external-revision", () => matches(page, current));
  } finally { await cleanup(request, owned); }
});

for (const outcome of ["real success", "scripted transport failure"] as const) {
  for (const arrival of ["during editing", "after save"] as const) {
    test(`late same-article history ${outcome} ${arrival} preserves the current editor and commits`, async ({ page, request }, info) => {
      const owned: Owned[] = [], gate = latch(), fetched = latch(), finished = latch();
      let calls = 0;
      try {
        const title = "Synthetic history and editor", item = await create(request, title, owned);
        const original = await history(request, item.id);
        expect(original).toHaveLength(1);
        await observe(page);
        await page.route(`**/api/wiki/pages/${item.id}/history`, async route => {
          const call = ++calls, response = await route.fetch();
          expect(response.ok()).toBe(true);
          if (call === 1) {
            expect((await response.json()).history).toEqual(original);
            fetched.resolve();
            await gate.promise;
            if (outcome === "real success") await route.fulfill({ response });
            else await route.abort("failed");
            finished.resolve();
          } else await route.fulfill({ response });
        });
        await page.goto(`/wiki/${item.id}`);
        const visit = await page.evaluate(() => ({ url: location.href, state: window.history.state, length: window.history.length }));
        await toggle(page, true);
        await fetched.promise;
        await expect(page.locator(".history-content")).toHaveText("Loading recent changes…");
        await page.getByRole("button", { name: "Edit page" }).click();
        const editor = page.getByRole("textbox", { name: /Markdown/ });
        const draft = `# ${title}\nA saved, independently invented observation.`;
        await editor.fill(draft);
        // The editor owns a new history panel even though the page ID is unchanged.
        await toggle(page, true);
        await settled(page, item.id, "historyBodies");
        await matches(page, original);
        await editor.focus();
        await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(5, 18));
        const identity = await editor.elementHandle();
        const releaseOld = async () => {
          gate.resolve(); await finished.promise;
          await settled(page, item.id, outcome === "real success" ? "historyBodies" : "historyFailures", outcome === "real success" ? (arrival === "during editing" ? 2 : 3) : 1);
        };
        if (arrival === "during editing") {
          await releaseOld();
          await expect(editor).toBeFocused();
          await expect(editor).toHaveValue(draft);
          expect(await identity!.evaluate(element => element === document.querySelector("#editor"))).toBe(true);
          expect(await editor.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([5, 18]);
          await matches(page, original);
        }
        const acknowledged = page.waitForResponse(response => response.url().endsWith(`/api/wiki/pages/${item.id}`) && response.request().method() === "POST");
        await page.getByRole("button", { name: "Save changes" }).click();
        const response = await acknowledged;
        expect(response.ok()).toBe(true);
        const saved = await response.json(); item.revision = saved.revision;
        await expect(page.locator("#editor")).toHaveCount(0);
        await expect(page.locator("article h1")).toBeFocused();
        await expect(page.locator(".prose")).toContainText("A saved, independently invented observation.");
        const current = await history(request, item.id);
        expect(current).toHaveLength(2);
        expect(current[0].commit).not.toBe(original[0].commit);
        expect(current.slice(1)).toEqual(original);
        await toggle(page, true);
        await settled(page, item.id, "historyBodies", arrival === "during editing" && outcome === "real success" ? 3 : 2);
        await matches(page, current);
        if (arrival === "after save") await releaseOld();
        const stable = async () => {
          await matches(page, current);
          await expect(page.locator(".page-history summary")).toBeFocused();
          await expect(page.locator(".revision")).toContainText(saved.revision.slice(0, 8));
          await expect(page.locator(".notice")).toContainText("Saved locally");
          await expect(page.locator("#editor")).toHaveCount(0);
          expect(await page.evaluate(() => ({ url: location.href, state: window.history.state, length: window.history.length }))).toEqual(visit);
        };
        await screenshots(page, info, `same-article-${outcome.replace(/ /g, "-")}-${arrival.replace(/ /g, "-")}`, stable);
        expect(calls).toBe(3);
        const readback = await request.get(`/api/wiki/pages/${item.id}`);
        expect(readback.ok()).toBe(true);
        expect(await readback.json()).toMatchObject({ markdown: draft, revision: saved.revision });
        expect(await history(request, item.id)).toEqual(current);
      } finally {
        gate.resolve();
        // A save may commit before a later assertion fails. Clean only this test's
        // owned page using its actual current revision, never a guessed receipt.
        for (const item of owned) {
          const response = await request.get(`/api/wiki/pages/${item.id}`);
          expect(response.ok()).toBe(true); item.revision = (await response.json()).revision;
        }
        await cleanup(request, owned);
      }
    });
  }
}
