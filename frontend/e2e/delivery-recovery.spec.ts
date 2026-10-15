import { expect } from "@playwright/test";
import { test } from "./reading-test";
import { startDeliveryFixture } from "./delivery-fixture";

// Real isolated API + local Git transport behind an owned forwarding proxy.
// No status JSON is mocked, and no external provider or user vault is used.
for (const width of [390, 1440]) {
  test(`an independently changed Git target stays blocked across local saves (${width})`, async ({ page, request }, info) => {
    const fixture = await startDeliveryFixture();
    let passed = false, browserWrites = 0;
    let proof: Record<string, unknown> = {};
    try {
      await page.setViewportSize({ width, height: 844 });
      const endpoint = fixture.origin + "/api/wiki/pages/delivery-page";
      page.on("request", outgoing => {
        if (outgoing.url() === endpoint && outgoing.method() !== "GET") browserWrites++;
      });
      const get = async (path: string) => {
        const response = await request.get(fixture.origin + "/api/wiki" + path);
        expect(response.ok()).toBe(true); return response.json();
      };
      const initialHead = await fixture.head(), remoteBefore = await fixture.remoteHead();
      const before = await get("/pages/delivery-page/history");
      const remoteMarkdown = "# Delivery page\n\nAn independent fictional amberharbor revision.\n";
      const externalHead = await fixture.advanceRemote(remoteMarkdown);
      expect(externalHead).not.toBe(remoteBefore);
      expect(await fixture.head()).toBe(initialHead);
      // GET status only reads the durable ledger: it must not imply a fresh
      // remote probe or silently adopt the external writer's new baseline.
      expect((await get("/delivery-status")).remote).toMatchObject({
        state: "current", last_verified_remote_revision: remoteBefore, cached_verification: true,
      });
      await page.goto(fixture.origin + "/wiki/delivery-page");
      await expect(page.locator("article h1")).toHaveText("Delivery page");
      const save = async (markdown: string) => {
        await page.getByRole("button", { name: "Edit page" }).click();
        await page.getByRole("textbox", { name: /Markdown/ }).fill(markdown);
        const savedResponse = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
        await page.getByRole("button", { name: "Save changes" }).click();
        const response = await savedResponse; expect(response.ok()).toBe(true);
        await expect(page.locator(".notice")).toContainText("Saved locally");
        return response.json();
      };
      const firstMarkdown = "# Delivery page\n\nLocal quartzbeacon revision. See [[linked-page|the lighthouse]].";
      const first = await save(firstMarkdown), firstHead = await fixture.head();
      expect(firstHead).not.toBe(initialHead);
      expect((await fixture.deliver()).remote.state).toBe("conflict");
      const assertBlocked = async (markdown: string, revision: string, head: string, writes: number) => {
        const status = await get("/delivery-status");
        expect(status.remote).toMatchObject({ state: "conflict", last_published_content_revision: initialHead, last_verified_remote_revision: remoteBefore });
        expect(await fixture.remoteHead()).toBe(externalHead);
        expect(await fixture.remoteMarkdown()).toBe(remoteMarkdown);
        expect(await fixture.head()).toBe(head);
        expect(await get("/pages/delivery-page")).toMatchObject({ markdown, revision });
        const history = (await get("/pages/delivery-page/history")).history;
        expect(history).toHaveLength(before.history.length + writes);
        expect(history.slice(writes)).toEqual(before.history);
        expect((await get("/search?q=quartzbeacon")).results.map((item: { id: string }) => item.id)).toContain("delivery-page");
        expect((await get("/graph")).edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: "delivery-page", target: "linked-page" })]));
        expect(browserWrites).toBe(writes);
      };
      const recheck = async () => {
        const check = page.getByRole("button", { name: "Check sync status", exact: true });
        await check.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: conflict — needs attention");
        await expect(check).toBeEnabled(); await expect(check).toBeFocused();
        expect((await check.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      };
      await recheck(); await assertBlocked(firstMarkdown, first.revision, firstHead, 1);
      const secondMarkdown = firstMarkdown + "\nA second local note remains editable while delivery is blocked.";
      const second = await save(secondMarkdown), secondHead = await fixture.head();
      expect(secondHead).not.toBe(firstHead);
      await assertBlocked(secondMarkdown, second.revision, secondHead, 2);
      // Retry is a real operator CLI invocation, not a fabricated conflict.
      // A blocked target must remain blocked rather than adopt or overwrite it.
      expect((await fixture.deliver()).remote.state).toBe("conflict");
      await recheck(); await assertBlocked(secondMarkdown, second.revision, secondHead, 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`delivery-conflict-${width}.png`), fullPage: true });
      proof = { width, initial_head: initialHead, first_head: firstHead, saved_head: secondHead, acknowledged_remote: remoteBefore, independent_remote: externalHead, state: "conflict", browser_writes: browserWrites, extra_content_commits: 0, remote_unchanged: true, external_model_calls: false };
      passed = true;
    } finally {
      await fixture.close({ retain: !passed });
      console.info("[git-conflict-fixture] " + JSON.stringify({ ...proof, passed, cleanup_ok: true, inputs_retained: !passed }));
    }
  });

  test(`a local save survives Git delivery failure and status can be reread after recovery (${width})`, async ({ page, request }, info) => {
    const fixture = await startDeliveryFixture();
    let passed = false, browserWrites = 0;
    let proof: Record<string, unknown> = {};
    let releaseStatus!: () => void, statusFetched!: () => void;
    const statusGate = new Promise<void>(resolve => { releaseStatus = resolve; });
    const heldStatus = new Promise<void>(resolve => { statusFetched = resolve; });
    try {
      await page.setViewportSize({ width, height: 844 });
      const endpoint = fixture.origin + "/api/wiki/pages/delivery-page";
      page.on("request", outgoing => {
        if (outgoing.url() === endpoint && outgoing.method() !== "GET") browserWrites++;
      });
      const get = async (path: string) => {
        const response = await request.get(fixture.origin + "/api/wiki" + path);
        expect(response.ok()).toBe(true); return response.json();
      };
      const initialHead = await fixture.head(), remoteBefore = await fixture.remoteHead();
      const before = await get("/pages/delivery-page/history");
      await fixture.interruptRemote();
      await page.goto(fixture.origin + "/wiki/delivery-page");
      await expect(page.locator("article h1")).toHaveText("Delivery page");
      await page.getByRole("button", { name: "Edit page" }).click();
      const markdown = "# Delivery page\n\nA fictional quartzbeacon remains available during delivery failure. See [[linked-page|the lighthouse]].";
      await page.getByRole("textbox", { name: /Markdown/ }).fill(markdown);
      const savedResponse = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "POST");
      await page.getByRole("button", { name: "Save changes" }).click();
      const response = await savedResponse; expect(response.ok()).toBe(true);
      const saved = await response.json(), savedHead = await fixture.head();
      expect(savedHead).not.toBe(initialHead);
      await expect(page.locator(".notice")).toContainText("Saved locally");
      const failed = await fixture.deliver();
      expect(failed.remote.state).toBe("error");
      expect((await get("/delivery-status")).remote.state).toBe("error");
      expect(await fixture.remoteHead()).toBe(remoteBefore);
      expect(await fixture.remoteMarkdown()).not.toContain("quartzbeacon");
      const check = page.getByRole("button", { name: "Check sync status", exact: true });
      await check.focus(); await page.keyboard.press("Enter");
      await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: needs attention");
      await expect(check).toBeEnabled();
      await expect(check).toBeFocused();
      const assertLocal = async () => {
        expect(await get("/pages/delivery-page")).toMatchObject({ markdown, revision: saved.revision });
        const current = await get("/pages/delivery-page/history");
        expect(current.history).toHaveLength(before.history.length + 1);
        expect(current.history.slice(1)).toEqual(before.history);
        expect((await get("/search?q=quartzbeacon")).results.map((item: { id: string }) => item.id)).toContain("delivery-page");
        expect((await get("/graph")).edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: "delivery-page", target: "linked-page" })]));
        expect(await fixture.head()).toBe(savedHead);
      };
      await assertLocal();
      await page.screenshot({ path: info.outputPath(`delivery-failed-${width}.png`), fullPage: true });
      await fixture.restoreRemote();
      const recovered = await fixture.deliver(), remoteAfter = await fixture.remoteHead();
      expect(recovered.remote.state).toBe("current");
      expect(recovered.remote.last_published_content_revision).toBe(savedHead);
      expect(recovered.remote.last_verified_remote_revision).toBe(remoteAfter);
      expect(remoteAfter).not.toBe(remoteBefore);
      expect(await fixture.remoteMarkdown()).toContain(markdown);
      // Backend recovery alone leaves the old browser error visible. A read-only
      // recheck must expose the new acknowledgement without another content write.
      await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: needs attention");
      await check.focus(); await page.keyboard.press("Enter");
      await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: current (cached acknowledgement)");
      await expect(check).toBeEnabled();
      await expect(check).toBeFocused();
      await assertLocal();
      expect(browserWrites).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await check.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: info.outputPath(`delivery-recovered-${width}.png`), fullPage: true });
      // Rechecking is also safe with an unsaved draft: preserve the native node,
      // selection and deliberate editor focus while the actual status is read.
      await page.getByRole("button", { name: "Edit page" }).click();
      const editor = page.getByRole("textbox", { name: /Markdown/ });
      await editor.fill(markdown + "\nUnsaved independent note.");
      const identity = await editor.elementHandle();
      const freshCheck = page.getByRole("button", { name: "Check sync status", exact: true });
      await page.route("**/api/wiki/delivery-status", async route => {
        const actual = await route.fetch(); expect(actual.ok()).toBe(true);
        statusFetched(); await statusGate; await route.fulfill({ response: actual });
      });
      const statusRead = page.waitForResponse(r => r.url().endsWith("/api/wiki/delivery-status"));
      await freshCheck.focus(); await page.keyboard.press("Enter"); await heldStatus;
      await editor.focus();
      await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(4, 19));
      releaseStatus(); await statusRead;
      await expect(freshCheck).toBeEnabled();
      await expect(editor).toBeFocused();
      expect(await identity!.evaluate(element => element === document.querySelector("#editor"))).toBe(true);
      expect(await editor.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([4, 19]);
      await expect(editor).toHaveValue(markdown + "\nUnsaved independent note.");
      await assertLocal(); expect(browserWrites).toBe(1);
      proof = { width, initial_head: initialHead, saved_head: savedHead, remote_before: remoteBefore, remote_after: remoteAfter, remote_failure: failed.remote.state, recovered: recovered.remote.state, browser_writes: browserWrites, extra_content_commits: 0, external_model_calls: false };
      passed = true;
    } finally {
      releaseStatus();
      await fixture.close({ retain: !passed });
      console.info("[git-delivery-fixture] " + JSON.stringify({ ...proof, passed, cleanup_ok: true, inputs_retained: !passed }));
    }
  });
}
