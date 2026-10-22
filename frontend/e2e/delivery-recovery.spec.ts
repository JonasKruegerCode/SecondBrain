import { expect } from "@playwright/test";
import { test } from "./reading-test";
import { startDeliveryFixture } from "./delivery-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("delivery fixture preserves its Python loader while isolating provider and Git settings", async () => {
  const keys = ["LD_LIBRARY_PATH", "OPENROUTER_API_KEY", "GIT_SSH_COMMAND", "SECOND_BRAIN_WIKI_VAULT"];
  const before = new Map(keys.map(key => [key, process.env[key]]));
  const loaderProbe = await mkdtemp(join(tmpdir(), "wiki-loader-probe-"));
  let fixture: Awaited<ReturnType<typeof startDeliveryFixture>> | undefined;
  try {
    const loaderPath = [loaderProbe, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    process.env.LD_LIBRARY_PATH = loaderPath;
    process.env.OPENROUTER_API_KEY = "synthetic-provider-must-not-reach-fixture";
    process.env.GIT_SSH_COMMAND = "synthetic-ssh-must-not-run";
    process.env.SECOND_BRAIN_WIKI_VAULT = "/synthetic-vault-must-not-be-opened";
    fixture = await startDeliveryFixture();
    expect(fixture.env.LD_LIBRARY_PATH).toBe(loaderPath);
    expect(fixture.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(fixture.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(fixture.env.SECOND_BRAIN_WIKI_VAULT).toBe(fixture.vault);
    expect((await fixture.deliver()).remote.state).toBe("current");
    expect(await fixture.head()).toBeTruthy();
  } finally {
    try { await fixture?.close(); }
    finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(loaderProbe, { recursive: true, force: true });
    }
  }
});

// Real isolated API + local Git transport behind an owned forwarding proxy.
// No status JSON is mocked, and no external provider or user vault is used.
for (const width of [390, 1440]) {
  test(`an independently changed Git target stays blocked until reviewed reconciliation (${width})`, async ({ page, request }, info) => {
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
      const recheck = async (state = "conflict — needs attention") => {
        const check = page.getByRole("button", { name: "Check sync status", exact: true });
        await check.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: " + state);
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
      // This is an explicit scripted operator review of both actual snapshots,
      // not an automatic merge/reconciliation feature in the product.
      const reviewedLocal = await get("/pages/delivery-page");
      const reviewedRemote = await fixture.remoteMarkdown();
      expect(reviewedLocal.markdown).toBe(secondMarkdown);
      expect(reviewedRemote).toBe(remoteMarkdown);
      const mergedMarkdown = reviewedLocal.markdown + "\n\n" + reviewedRemote.split("\n\n")[1].trim();
      const merged = await save(mergedMarkdown), mergedHead = await fixture.head();
      expect(mergedHead).not.toBe(secondHead);
      await assertBlocked(mergedMarkdown, merged.revision, mergedHead, 3);
      // Let Save's own status read finish while the target is still blocked.
      await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: conflict — needs attention");
      const staleLocal = await fixture.reconcileReviewedHeads(secondHead, externalHead);
      expect(staleLocal).toMatchObject({ exitCode: 1, body: { error: "revision_conflict" } });
      await assertBlocked(mergedMarkdown, merged.revision, mergedHead, 3);
      const staleRemote = await fixture.reconcileReviewedHeads(mergedHead, remoteBefore);
      expect(staleRemote).toMatchObject({ exitCode: 1, body: { error: "remote_conflict" } });
      await assertBlocked(mergedMarkdown, merged.revision, mergedHead, 3);
      const historyBeforeReview = await get("/pages/delivery-page/history");
      const reconciled = await fixture.reconcileReviewedHeads(mergedHead, externalHead);
      expect(reconciled).toMatchObject({ exitCode: 0, body: { remote: { state: "pending", last_published_content_revision: initialHead, last_verified_remote_revision: externalHead } } });
      expect((await get("/delivery-status")).remote.state).toBe("pending");
      expect(await fixture.head()).toBe(mergedHead);
      expect(await fixture.remoteHead()).toBe(externalHead);
      expect(await fixture.remoteMarkdown()).toBe(remoteMarkdown);
      expect(await get("/pages/delivery-page/history")).toEqual(historyBeforeReview);
      const recovered = await fixture.deliver(), publishedRemote = await fixture.remoteHead();
      expect(recovered.remote).toMatchObject({ state: "current", last_published_content_revision: mergedHead, last_verified_remote_revision: publishedRemote });
      expect(publishedRemote).not.toBe(externalHead);
      expect(await fixture.remoteParent()).toBe(externalHead);
      expect(await fixture.remoteMarkdown()).toBe(mergedMarkdown);
      expect(await get("/pages/delivery-page")).toMatchObject({ markdown: mergedMarkdown, revision: merged.revision });
      expect(await fixture.head()).toBe(mergedHead);
      expect(await get("/pages/delivery-page/history")).toEqual(historyBeforeReview);
      await expect(page.locator(".delivery-notice")).toContainText("Remote delivery: conflict — needs attention");
      await recheck("current (cached acknowledgement)");
      expect(browserWrites).toBe(3);
      expect(await fixture.head()).toBe(mergedHead);
      expect(await get("/pages/delivery-page/history")).toEqual(historyBeforeReview);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`delivery-reconciled-${width}.png`), fullPage: true });
      proof = { width, initial_head: initialHead, first_head: firstHead, saved_head: mergedHead, acknowledged_remote: remoteBefore, independent_remote: externalHead, published_remote: publishedRemote, state_before_review: "conflict", reconciled: reconciled.body.remote.state, recovered: recovered.remote.state, stale_local: staleLocal.body.error, stale_remote: staleRemote.body.error, blocked_browser_writes: 2, browser_writes: browserWrites, extra_content_commits: 0, external_model_calls: false };
      passed = true;
    } finally {
      await fixture.close({ retain: !passed });
      console.info("[git-reconcile-fixture] " + JSON.stringify({ ...proof, passed, cleanup_ok: true, inputs_retained: !passed }));
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
