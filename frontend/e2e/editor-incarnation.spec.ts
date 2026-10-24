import { expect, type APIResponse, type Page, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

async function stored(response: APIResponse | Response) {
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function saveFrom(page: Page, id: string) {
  const response = page.waitForResponse(value =>
    value.url().endsWith(`/api/wiki/pages/${id}`) && value.request().method() === "POST");
  await page.getByRole("button", { name: "Save changes" }).click();
  return response;
}

// Observe capture boundaries without moving focus or scrolling. A full-page
// image alone cannot establish viewport visibility or the focused element.
async function captureState(page: Page) {
  return page.evaluate(() => {
    const skip = document.querySelector<HTMLAnchorElement>(".skip-link")!;
    const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
    const rect = skip.getBoundingClientRect();
    const active = document.activeElement;
    const outline = getComputedStyle(editor);
    const viewport = visualViewport;
    return {
      active: active ? { tag: active.tagName, id: active.id, class: active.className } : null,
      skip: { focused: active === skip, focus_visible: skip.matches(":focus-visible"),
        top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        transform: getComputedStyle(skip).transform },
      editor: { focused: active === editor, focus_visible: editor.matches(":focus-visible"),
        outline: { style: outline.outlineStyle, width: outline.outlineWidth, color: outline.outlineColor } },
      scroll: { x: scrollX, y: scrollY },
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      visual_viewport: viewport ? { width: viewport.width, height: viewport.height,
        offset_left: viewport.offsetLeft, offset_top: viewport.offsetTop, scale: viewport.scale } : null,
    };
  });
}

for (const width of [390, 1440]) {
  test(`a stale editor cannot overwrite a byteidentical recreated page (${width})`, async ({ page, context, request }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `editor-incarnation-${randomUUID()}`;
    const markdown = "# Observatory notebook\nAn independently invented observation.\n\n[[home|Wiki home]]";
    const original = await stored(await request.post(`/api/wiki/pages/${id}`, {
      data: { markdown, base_revision: null, request_id: randomUUID() },
    }));
    let other: Page | undefined;
    try {
      other = await context.newPage();
      await other.setViewportSize({ width, height: 1000 });
      await page.goto(`/wiki/${id}`);
      await page.getByRole("button", { name: "Edit page" }).click();
      const editor = page.locator("#editor");
      const identity = await editor.elementHandle();
      await editor.press("ControlOrMeta+End");
      await editor.pressSequentially("\nA local unpublished draft.");
      const draft = await editor.inputValue();
      const selection = await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]);
      const visit = await page.evaluate(() => ({ url: location.href, state: history.state, length: history.length }));

      expect((await request.delete(`/api/wiki/pages/${id}`, {
        data: { base_revision: original.revision, request_id: randomUUID() },
      })).ok()).toBeTruthy();
      const recreated = await stored(await request.post(`/api/wiki/pages/${id}`, {
        data: { markdown, base_revision: null, request_id: randomUUID() },
      }));
      expect(recreated.markdown).toBe(original.markdown);
      expect(recreated.revision).not.toBe(original.revision);
      const historyBefore = (await stored(await request.get(`/api/wiki/pages/${id}/history`))).history;

      // Attempt the stale write BEFORE another edit changes these identical
      // bytes. A content-hash-only implementation must fail this oracle.
      const first = await saveFrom(page, id);
      expect(first.status()).toBe(409);
      expect((await first.json()).current_revision).toBe(recreated.revision);
      const firstPayload = first.request().postDataJSON();
      expect(firstPayload).toMatchObject({ markdown: draft, base_revision: original.revision });
      await expect(page.locator(".notice.error")).toContainText("Your draft is preserved");
      await expect(editor).toHaveValue(draft);
      await expect(editor).toBeEditable();
      expect(await identity!.evaluate(node => node === document.querySelector("#editor"))).toBe(true);
      expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual(selection);
      expect(await stored(await request.get(`/api/wiki/pages/${id}`))).toMatchObject({ markdown, revision: recreated.revision });
      expect((await stored(await request.get(`/api/wiki/pages/${id}/history`))).history).toEqual(historyBefore);
      const beforeViewport = await captureState(page);
      await page.screenshot({ path: info.outputPath(`recreated-conflict-viewport-before-${width}.png`) });
      const beforeFullpage = await captureState(page);
      await page.screenshot({ path: info.outputPath(`recreated-conflict-${width}.png`), fullPage: true });
      const afterFullpage = await captureState(page);
      await page.screenshot({ path: info.outputPath(`recreated-conflict-viewport-after-${width}.png`) });
      const afterViewport = await captureState(page);
      console.info("[editor-capture] " + JSON.stringify({ width, beforeViewport,
        beforeFullpage, afterFullpage, afterViewport }));
      for (const state of [beforeViewport, beforeFullpage, afterFullpage, afterViewport]) {
        expect(state.skip.focused).toBe(false);
        expect(state.skip.bottom).toBeLessThanOrEqual(0);
      }
      expect(afterFullpage).toEqual(beforeFullpage);
      expect(afterViewport).toEqual(beforeViewport);

      await other.goto(`/wiki/${id}`);
      await other.getByRole("button", { name: "Edit page" }).click();
      const foreign = markdown + "\nA current observation saved in the second tab.";
      await other.locator("#editor").fill(foreign);
      const foreignResponse = await saveFrom(other, id);
      expect(foreignResponse.ok()).toBeTruthy();
      expect(foreignResponse.request().postDataJSON().base_revision).toBe(recreated.revision);
      const published = await foreignResponse.json();
      await expect(other.locator(".notice")).toContainText("Saved locally");
      expect(published.markdown).toBe(foreign);

      const second = await saveFrom(page, id);
      expect(second.status()).toBe(409);
      expect((await second.json()).current_revision).toBe(published.revision);
      expect(second.request().postDataJSON()).toMatchObject({ markdown: draft, base_revision: original.revision });
      await expect(page.locator(".notice.error")).toContainText("Conflict");
      await expect(editor).toHaveValue(draft);
      expect(await identity!.evaluate(node => node === document.querySelector("#editor"))).toBe(true);

      page.once("dialog", dialog => dialog.dismiss());
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).toHaveValue(draft);
      expect(await identity!.evaluate(node => node === document.querySelector("#editor"))).toBe(true);
      expect(await stored(await request.get(`/api/wiki/pages/${id}`))).toMatchObject({ markdown: foreign, revision: published.revision });
      page.once("dialog", dialog => dialog.accept());
      const freshRead = page.waitForResponse(value =>
        value.url().endsWith(`/api/wiki/pages/${id}`) && value.request().method() === "GET");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await stored(await freshRead)).revision).toBe(published.revision);
      await expect(page.locator("#editor")).toHaveCount(0);
      await expect(page.locator(".prose")).toContainText("A current observation saved in the second tab.");
      await expect(page.locator(".revision")).toContainText(published.revision.slice(0, 8));
      expect(await page.evaluate(() => ({ url: location.href, state: history.state, length: history.length }))).toEqual(visit);

      await page.getByRole("button", { name: "Edit page" }).click();
      await expect(page.locator("#editor")).toHaveValue(foreign);
      const finalMarkdown = foreign + "\nA reviewed follow-up from the refreshed first tab.";
      await page.locator("#editor").fill(finalMarkdown);
      const finalResponse = await saveFrom(page, id);
      expect(finalResponse.ok()).toBeTruthy();
      expect(finalResponse.request().postDataJSON().base_revision).toBe(published.revision);
      const final = await finalResponse.json();
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await expect(page.locator(".prose")).toContainText("A reviewed follow-up");
      expect(await stored(await request.get(`/api/wiki/pages/${id}`))).toMatchObject({ markdown: finalMarkdown, revision: final.revision });
      expect((await stored(await request.get(`/api/wiki/pages/${id}/history`))).history).toHaveLength(historyBefore.length + 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`recreated-recovered-${width}.png`), fullPage: true });
      console.info("[editor-incarnation] " + JSON.stringify({ width, identical_recreation: true,
        stale_base: original.revision, recreated_revision: recreated.revision,
        first_conflict: first.status(), second_conflict: second.status(),
        foreign_revision: published.revision, final_revision: final.revision,
        history_before: historyBefore.length, history_after: historyBefore.length + 2,
      }));
    } finally {
      await other?.close();
      const current = await request.get(`/api/wiki/pages/${id}`);
      expect(current.ok(), "owned incarnation fixture remains readable for cleanup").toBeTruthy();
      expect((await request.delete(`/api/wiki/pages/${id}`, {
        data: { base_revision: (await current.json()).revision, request_id: randomUUID() },
      })).ok()).toBeTruthy();
    }
  });
}
