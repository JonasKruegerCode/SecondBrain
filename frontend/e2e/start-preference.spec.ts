import { expect, type Page } from "@playwright/test";
import { test } from "./reading-test";
import { randomUUID } from "node:crypto";

// Real demo routes and native IDB; faults are explicit API injections, not
// experiments in physical quota, device failure or browser crash durability.
async function record(page: Page, value?: { version: 1; pageId: string }) {
  return page.evaluate(value => new Promise<any>((resolve, reject) => {
    const opening = indexedDB.open("secondbrain.preferences.v1", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("preferences");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("preferences", value ? "readwrite" : "readonly");
      const store = tx.objectStore("preferences");
      const request = value ? store.put(value, "start-page") : store.get("start-page");
      let result: unknown;
      request.onsuccess = () => { result = value || request.result; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), value);
}
async function holdWriter(page: Page) {
  await record(page);
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open("secondbrain.preferences.v1", 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("preferences", "readwrite");
      const store = tx.objectStore("preferences");
      const state = window as any;
      state.preferenceReleased = false;
      state.preferenceDone = new Promise<void>((done, fail) => {
        tx.oncomplete = () => { db.close(); done(); };
        tx.onabort = () => { db.close(); fail(tx.error); };
      });
      const keepAlive = () => {
        const request = store.get("start-page");
        request.onsuccess = () => { if (!state.preferenceReleased) keepAlive(); };
      };
      const first = store.get("start-page");
      first.onsuccess = () => { keepAlive(); resolve(); };
    };
  }));
}
async function releaseWriter(page: Page) {
  await page.evaluate(async () => {
    (window as any).preferenceReleased = true;
    await (window as any).preferenceDone;
  });
}
// Observe actual transaction creation so releasing a native lock cannot race
// the app's module import or the real /pages response.
async function observeTransactions(page: Page) {
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    (window as any).preferenceTransactions = 0;
    IDBDatabase.prototype.transaction = function(...args: any[]) {
      const tx = (original as any).apply(this, args) as IDBTransaction;
      if (this.name === "secondbrain.preferences.v1") (window as any).preferenceTransactions++;
      return tx;
    };
  });
}
async function transactions(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (window as any).preferenceTransactions)).toBeGreaterThanOrEqual(count);
}
async function moduleCall(page: Page, method: "readStartPage" | "saveStartPage", id?: string) {
  return page.evaluate(async ({ method, id }) => {
    const path = "/src/start-preference.ts";
    const module = await import(/* @vite-ignore */ path);
    return module[method](id);
  }, { method, id });
}

for (const width of [390, 1440]) {
  test(`pending preference keeps keyboard focus and ignores duplicate activation (${width})`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/wiki/home");
    const peer = await context.newPage();
    await peer.goto("/wiki/home");
    await holdWriter(peer);
    try {
      await observeTransactions(page);
      const start = page.locator("#start");
      await start.focus();
      await page.keyboard.press("Enter");
      await transactions(page, 1);
      await expect(start).toBeFocused();
      await expect(start).toHaveAttribute("aria-disabled", "true");
      await page.screenshot({ path: info.outputPath(`pending-start-focus-${width}.png`) });
      // aria-disabled keeps focus but requires the handler's duplicate guard.
      await page.keyboard.press("Enter");
      await start.evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
      expect(await page.evaluate(() => (window as any).preferenceTransactions)).toBe(1);
      await releaseWriter(peer);
      await expect(page.locator(".notice")).toHaveText("This is now your start page.");
      await expect(start).toHaveAttribute("aria-disabled", "false");
      await expect(start).toBeFocused();
      await page.screenshot({ path: info.outputPath(`confirmed-start-focus-${width}.png`) });
      expect(await record(page)).toEqual({ version: 1, pageId: "home" });
    } finally { await releaseWriter(peer); await peer.close(); }
  });

  test(`legacy import and authoritative preference precedence (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/wiki/home");
    await page.evaluate(() => localStorage.setItem("secondbrain.startpage", "home"));
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator("article > h1")).toHaveText("Lantern Bay field atlas");
    expect(await record(page)).toEqual({ version: 1, pageId: "home" });
    await record(page, { version: 1, pageId: "field-notebook" });
    await page.evaluate(() => localStorage.setItem("secondbrain.startpage", "home"));
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
    await expect(page.locator(".prose")).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
    expect(await record(page)).toEqual({ version: 1, pageId: "field-notebook" });
  });

  for (const failure of ["put throws", "abort after put"] as const) {
    test(`preference ${failure} preserves editor and retries (${width})`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/wiki/home");
      const published = await (await request.get("/api/wiki/pages/home")).json();
      await record(page, { version: 1, pageId: "field-notebook" });
      await page.evaluate(failure => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) {
          if (this.name !== "preferences") return original.apply(this, args);
          if (failure === "put throws") throw new DOMException("Synthetic quota", "QuotaExceededError");
          const request = original.apply(this, args);
          request.addEventListener("success", () => {
            (window as any).preferencePutSucceeded = true;
            this.transaction.abort();
          });
          return request;
        };
        window.addEventListener("synthetic-preference-ready", () => {
          IDBObjectStore.prototype.put = original;
        }, { once: true });
      }, failure);
      await page.getByRole("button", { name: "Edit page" }).click();
      const editor = page.getByRole("textbox", { name: /Markdown/ });
      const original = await editor.elementHandle();
      const draft = published.markdown + "\n\nUnsaved synthetic draft.";
      await editor.fill(draft);
      await editor.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 13));
      await page.getByRole("button", { name: "Set as start page" }).click();
      await expect(page.locator(".notice.error")).toHaveText("Your browser could not remember this preference.");
      await expect(page.getByText("This is now your start page.", { exact: true })).toHaveCount(0);
      if (failure === "abort after put") expect(await page.evaluate(() => (window as any).preferencePutSucceeded)).toBe(true);
      expect(await record(page)).toEqual({ version: 1, pageId: "field-notebook" });
      await expect(editor).toHaveValue(draft);
      expect(await editor.evaluate((node, old) => node === old, original)).toBe(true);
      expect(await editor.evaluate(node => [(node as HTMLTextAreaElement).selectionStart,
        (node as HTMLTextAreaElement).selectionEnd])).toEqual([4, 13]);
      await page.evaluate(() => window.dispatchEvent(new Event("synthetic-preference-ready")));
      await page.getByRole("button", { name: "Set as start page" }).click();
      await expect(page.locator(".notice")).toHaveText("This is now your start page.");
      expect(await record(page)).toEqual({ version: 1, pageId: "home" });
      await expect(editor).toHaveValue(draft);
      expect(await editor.evaluate((node, old) => node === old, original)).toBe(true);
      const current = await (await request.get("/api/wiki/pages/home")).json();
      expect(current.markdown).toBe(published.markdown);
      expect(current.revision).toBe(published.revision);
    });
  }
}

test("concurrent first migrations cannot overwrite an explicitly queued Set", async ({ page, context }) => {
  await page.goto("/wiki/home");
  const peer = await context.newPage();
  await peer.goto("/wiki/home");
  await page.evaluate(() => localStorage.setItem("secondbrain.startpage", "home"));
  await holdWriter(peer);
  await observeTransactions(page);
  await observeTransactions(peer);
  try {
    const first = moduleCall(page, "readStartPage");
    const second = moduleCall(peer, "readStartPage");
    const set = moduleCall(page, "saveStartPage", "field-notebook");
    await transactions(page, 2);
    await transactions(peer, 1);
    await releaseWriter(peer);
    await Promise.all([first, second, set]);
    expect(await record(page)).toEqual({ version: 1, pageId: "field-notebook" });
    await page.goto("/");
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
  } finally { await releaseWriter(peer); await peer.close(); }
});

test("delayed root preference read cannot redirect newer navigation", async ({ page, context }) => {
  await page.goto("/wiki/home");
  const peer = await context.newPage();
  await peer.goto("/wiki/home");
  await record(peer, { version: 1, pageId: "field-notebook" });
  await holdWriter(peer);
  await observeTransactions(page);
  try {
    await page.evaluate(() => {
      history.pushState({}, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await transactions(page, 1);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true }).click();
    await expect(page.locator("main h1")).toHaveText("Find a thought.");
    await releaseWriter(peer);
    await record(page); // Native transaction barrier behind the held read.
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("main h1")).toHaveText("Find a thought.");
  } finally { await releaseWriter(peer); await peer.close(); }
});

test("delayed Set stores captured article without feedback on next article", async ({ page, context }) => {
  await page.goto("/wiki/home");
  const peer = await context.newPage();
  await peer.goto("/wiki/home");
  await holdWriter(peer);
  try {
    await page.getByRole("button", { name: "Set as start page" }).click();
    await expect(page.getByRole("button", { name: "Saving start page…", exact: true })).toBeDisabled();
    await page.locator('.prose a[data-wiki-target="field-notebook"]').first().click();
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
    await expect(page.locator(".prose")).toBeVisible();
    await releaseWriter(peer);
    expect(await record(page)).toEqual({ version: 1, pageId: "home" });
    await expect(page.locator(".notice")).toBeEmpty();
    await expect(page.getByRole("button", { name: "Set as start page" })).toBeEnabled();
    await expect(page).toHaveURL(/\/wiki\/field-notebook$/);
  } finally { await releaseWriter(peer); await peer.close(); }
});


async function denyLegacyGetter(page: Page) {
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() {
      throw new DOMException("Synthetic legacy getter denial", "SecurityError");
    }});
    window.addEventListener("synthetic-legacy-ready", () => {
      Object.defineProperty(window, "localStorage", descriptor);
    }, { once: true });
  });
}

test("denied legacy getter leaves migration absent and a recovered read imports", async ({ page }) => {
  await page.goto("/wiki/home");
  await page.evaluate(() => localStorage.setItem("secondbrain.startpage", "field-notebook"));
  await denyLegacyGetter(page);
  await expect(moduleCall(page, "readStartPage")).rejects.toThrow();
  expect(await record(page)).toBeUndefined();
  // Check presence independently: a stored undefined must not count as absence.
  expect(await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open("secondbrain.preferences.v1", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("preferences", "readonly");
      const key = tx.objectStore("preferences").getKey("start-page");
      let present = false;
      key.onsuccess = () => { present = key.result !== undefined; };
      tx.oncomplete = () => { db.close(); resolve(present); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }))).toBe(false);
  await page.evaluate(() => dispatchEvent(new Event("synthetic-legacy-ready")));
  expect(await moduleCall(page, "readStartPage")).toBe("field-notebook");
  expect(await record(page)).toEqual({ version: 1, pageId: "field-notebook" });
});

test("explicit records including empty ignore stale and denied legacy storage", async ({ page }) => {
  await page.goto("/wiki/home");
  await page.evaluate(() => localStorage.setItem("secondbrain.startpage", "home"));
  for (const pageId of ["field-notebook", ""]) {
    await record(page, { version: 1, pageId });
    expect(await moduleCall(page, "readStartPage")).toBe(pageId);
  }
  await denyLegacyGetter(page);
  for (const pageId of ["", "field-notebook"]) {
    await record(page, { version: 1, pageId });
    expect(await moduleCall(page, "readStartPage")).toBe(pageId);
    expect(await record(page)).toEqual({ version: 1, pageId });
  }
});

test("malformed authoritative values reject without reimport and explicit Set repairs", async ({ page }) => {
  await page.goto("/wiki/home");
  await page.evaluate(() => localStorage.setItem("secondbrain.startpage", "home"));
  // Include present-but-undefined, which native get() alone cannot distinguish
  // from a missing key, as well as invalid schema/version/page-ID records.
  for (const value of [undefined, null, { version: 2, pageId: "home" }, { version: 1, pageId: "bad/id" }]) {
    await page.evaluate(value => new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open("secondbrain.preferences.v1", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("preferences");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction("preferences", "readwrite");
        tx.objectStore("preferences").put(value, "start-page");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), value);
    await expect(moduleCall(page, "readStartPage")).rejects.toThrow(/malformed/);
    expect(await record(page)).toEqual(value);
    await moduleCall(page, "saveStartPage", "field-notebook");
    expect(await moduleCall(page, "readStartPage")).toBe("field-notebook");
    expect(await record(page)).toEqual({ version: 1, pageId: "field-notebook" });
  }
});

test("Set completion after same-article save updates the current toolbar and preserves a newer draft", async ({ page, context, request }) => {
  const id = `e2e-start-${randomUUID()}`;
  const markdown = "# Synthetic pending start\n\nAn invented article.";
  const created = await request.post(`/api/wiki/pages/${id}`, { data: {
    markdown, base_revision: null, request_id: randomUUID(),
  }});
  expect(created.ok()).toBe(true);
  const peer = await context.newPage();
  let held = false;
  try {
    await page.goto(`/wiki/${id}`);
    await peer.goto("/wiki/home");
    await holdWriter(peer);
    held = true;
    await page.getByRole("button", { name: "Set as start page" }).click();
    await expect(page.getByRole("button", { name: "Saving start page…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Edit page" }).click();
    const savedMarkdown = markdown + "\n\nA real synthetic saved revision.";
    await page.getByRole("textbox", { name: /Markdown/ }).fill(savedMarkdown);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".prose")).toContainText("A real synthetic saved revision.");
    await expect(page.getByRole("button", { name: "Saving start page…", exact: true })).toBeDisabled();
    const saved = await (await request.get(`/api/wiki/pages/${id}`)).json();
    expect(saved.markdown).toBe(savedMarkdown);
    await page.getByRole("button", { name: "Edit page" }).click();
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    const draft = savedMarkdown + "\n\nA newer unsaved draft.";
    await editor.fill(draft);
    await editor.focus();
    await editor.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(5, 19));
    const original = await editor.elementHandle();
    await releaseWriter(peer);
    held = false;
    await expect(page.getByRole("button", { name: "Set as start page", exact: true })).toBeEnabled();
    await expect(page.locator(".notice")).toHaveText("This is now your start page.");
    expect(await record(page)).toEqual({ version: 1, pageId: id });
    await expect(editor).toHaveValue(draft);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node, old) => node === old, original)).toBe(true);
    expect(await editor.evaluate(node => [(node as HTMLTextAreaElement).selectionStart,
      (node as HTMLTextAreaElement).selectionEnd])).toEqual([5, 19]);
    const latest = await (await request.get(`/api/wiki/pages/${id}`)).json();
    expect(latest.markdown).toBe(savedMarkdown);
    expect(latest.revision).toBe(saved.revision);
  } finally {
    if (held) await releaseWriter(peer);
    await peer.close();
    const latest = await request.get(`/api/wiki/pages/${id}`);
    expect(latest.ok()).toBe(true);
    const deleted = await request.delete(`/api/wiki/pages/${id}`, { data: {
      base_revision: (await latest.json()).revision,
      request_id: randomUUID(),
    }});
    expect(deleted.ok()).toBe(true);
  }
});
