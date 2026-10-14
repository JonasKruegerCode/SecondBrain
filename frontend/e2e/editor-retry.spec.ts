import { expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

// Both engines exercise these same real Git-backed writes. WebKit inherits
// the worker-blocked reading profile so the held response is observable.
async function create(request: APIRequestContext, markdown: string) {
  const id = `editor-retry-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: null, request_id: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return { id, ...(await response.json()) };
}

for (const retryMode of ["unchanged", "edited", "restored", "rejected-then-restored", "keyboard-restored", "pre-save-restored"] as const) {
test(`a timed-out save preserves its ${retryMode} draft without another publication`, async ({ page, request }, testInfo) => {
  const fixture = await create(request, "# Save timeout fixture\nBefore.");
  const payloads: { request_id: string; base_revision: string; markdown: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const published = new Promise<void>(resolve => { captured = resolve; });
  try {
    await page.goto(`/wiki/${fixture.id}`);
    await page.clock.install();
    await page.route(`**/api/wiki/pages/${fixture.id}`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    payloads.push(route.request().postDataJSON());
    if (payloads.length > 1) { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {}); // The client may already have aborted.
  });
    await page.getByRole("button", { name: "Edit page" }).click();
    const initialDraft = "# Save timeout fixture\nA synthetic saved change.";
    const suffix = " Keyboard edit before saving.";
    const draft = retryMode === "pre-save-restored" ? initialDraft + suffix : initialDraft;
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    await editor.fill(initialDraft);
    const originalEditor = await editor.elementHandle();
    if (retryMode === "pre-save-restored") {
      await editor.press("ControlOrMeta+End");
      await editor.pressSequentially(suffix);
      await editor.evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(2, 8, "backward"));
    }
    await page.getByRole("button", { name: "Save changes" }).click();
    await published;
    if (retryMode === "pre-save-restored") {
      await expect(editor).toBeEnabled();
      await expect(page.getByRole("button", { name: "Saving" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      await editor.press("Backspace");
      await expect(editor).toHaveValue(draft); // A pending save cannot alter its draft.
      await page.getByRole("button", { name: "Set as start page" }).click();
    }
    const pendingSameEditor = await editor.evaluate((e, original) => e === original, originalEditor);
    const saved = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(saved.markdown).toBe(draft);
    await page.clock.fastForward(30_001);
    await expect(page.locator(".notice")).toContainText("timed out");
    await expect(page.locator(".notice")).toHaveClass(/error/);
    await expect(editor).toHaveValue(draft);
    await expect(editor).toBeEnabled();
    if (retryMode !== "pre-save-restored") await expect(editor).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("save-timeout-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("save-timeout-mobile.png"), fullPage: true });
    release();
    if (retryMode === "pre-save-restored") {
      const selection = await editor.evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd, e.selectionDirection]);
      const sameEditor = await editor.evaluate((e, original) => e === original, originalEditor);
      const chosenFocusRetained = await page.getByRole("button", { name: "Set as start page" }).evaluate(e => document.activeElement === e);
      await editor.press("ControlOrMeta+z");
      const undone = await editor.inputValue();
      expect({ pendingSameEditor, sameEditor, chosenFocusRetained, selection, undone }).toEqual({
        pendingSameEditor: true, sameEditor: true, chosenFocusRetained: true, selection: [2, 8, "backward"], undone: initialDraft,
      });
      await editor.press("ControlOrMeta+Shift+z");
      await expect(editor).toHaveValue(draft);
      expect(payloads).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath("save-preexisting-undo-mobile.png"), fullPage: true });
    }
    if (retryMode === "edited") await editor.fill("# Save timeout fixture\nA further unsaved change.");
    if (retryMode === "restored") {
      await editor.fill("# Save timeout fixture\nA temporary correction.");
      await editor.fill(draft); // Restore the same submitted bytes through input.
    }
    if (retryMode === "keyboard-restored") {
      // Exercise the engine's textarea undo stack, not a programmatic fill.
      // These edits are made after timeout; pre-save-restored covers older edits.
      const suffix = " Temporary keyboard correction.";
      await editor.press("ControlOrMeta+End");
      await editor.pressSequentially(suffix);
      await expect(editor).toHaveValue(draft + suffix);
      await editor.press("ControlOrMeta+z");
      await expect(editor).toHaveValue(draft);
      await editor.press("ControlOrMeta+Shift+z");
      await expect(editor).toHaveValue(draft + suffix);
      await editor.press("ControlOrMeta+z");
      await expect(editor).toHaveValue(draft);
      await expect(editor).toBeFocused();
      expect(payloads).toHaveLength(1); // Undo/redo alone never publishes.
      await page.screenshot({ path: testInfo.outputPath("save-keyboard-undo-mobile.png"), fullPage: true });
    }
    if (retryMode === "rejected-then-restored") {
      const correction = "# Save timeout fixture\nA rejected correction.";
      await editor.fill(correction);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.locator(".notice")).toContainText("Conflict");
      await expect(editor).toHaveValue(correction);
      expect(payloads).toHaveLength(2);
      expect(payloads[1].request_id).not.toBe(payloads[0].request_id);
      await editor.fill(draft);
    }
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".notice")).toContainText(retryMode !== "edited" ? "Saved locally" : "Conflict");
    if (retryMode !== "edited") await expect(page.locator(".notice")).not.toHaveClass(/error/);
    expect(payloads).toHaveLength(retryMode === "rejected-then-restored" ? 3 : 2);
    if (retryMode !== "edited") expect(payloads.at(-1)).toEqual(payloads[0]);
    else {
      expect(payloads[1].request_id).not.toBe(payloads[0].request_id);
      expect(payloads[1].base_revision).toBe(payloads[0].base_revision);
      await expect(editor).toHaveValue("# Save timeout fixture\nA further unsaved change.");
      await expect(editor).toBeFocused();
    }
    const retry = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(retry.revision).toBe(saved.revision);
    const history = await (await request.get(`/api/wiki/pages/${fixture.id}/history`)).json();
    expect(history.history).toHaveLength(2); // Creation plus the one actual edit.
    expect(retry.markdown).toBe(draft);
    if (retryMode !== "edited") await expect(page.locator(".prose")).toContainText("A synthetic saved change.");
    if (retryMode.endsWith("restored")) await page.screenshot({ path: testInfo.outputPath("save-restored-receipt-mobile.png"), fullPage: true });
  } finally {
    release();
    // This shared file can run before the pristine demo graph. Remove only
    // this test's owned page, using its current revision after any real save.
    const current = await request.get(`/api/wiki/pages/${fixture.id}`);
    expect(current.ok(), "owned editor retry fixture is readable for cleanup").toBeTruthy();
    const cleanup = await request.delete(`/api/wiki/pages/${fixture.id}`, {
      data: { base_revision: (await current.json()).revision, request_id: randomUUID() },
    });
    expect(cleanup.ok(), "owned editor retry fixture cleanup").toBeTruthy();
  }
});
}

test("a real conflict retains the editor selection and pre-save undo history", async ({ page, request }, testInfo) => {
  const initialDraft = "# Conflict undo fixture\nOriginal text.";
  const fixture = await create(request, initialDraft);
  try {
    await page.goto(`/wiki/${fixture.id}`);
    await page.getByRole("button", { name: "Edit page" }).click();
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    const originalEditor = await editor.elementHandle();
    const suffix = " A keyboard correction.";
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially(suffix);
    const draft = initialDraft + suffix;
    await expect(editor).toHaveValue(draft);
    await editor.evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(3, 10, "backward"));
    await page.getByRole("button", { name: "Set as start page" }).click();
    const foreignMarkdown = "# Conflict undo fixture\nA newer agent edit.";
    const foreign = await request.post(`/api/wiki/pages/${fixture.id}`, {
      data: { markdown: foreignMarkdown, base_revision: fixture.revision, request_id: randomUUID() },
    });
    expect(foreign.ok()).toBeTruthy();
    const foreignSave = await foreign.json();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".notice")).toContainText("Conflict");
    await expect(editor).toHaveValue(draft);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((e, original) => e === original, originalEditor)).toBe(true);
    expect(await editor.evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd, e.selectionDirection])).toEqual([3, 10, "backward"]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("save-conflict-selection-mobile.png"), fullPage: true });
    await editor.press("ControlOrMeta+z");
    await expect(editor).toHaveValue(initialDraft);
    await editor.press("ControlOrMeta+Shift+z");
    await expect(editor).toHaveValue(draft);
    const stored = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(stored.markdown).toBe(foreignMarkdown);
    expect(stored.revision).toBe(foreignSave.revision);
    expect((await (await request.get(`/api/wiki/pages/${fixture.id}/history`)).json()).history).toHaveLength(2);
  } finally {
    const current = await request.get(`/api/wiki/pages/${fixture.id}`);
    expect(current.ok()).toBeTruthy();
    expect((await request.delete(`/api/wiki/pages/${fixture.id}`, {
      data: { base_revision: (await current.json()).revision, request_id: randomUUID() },
    })).ok()).toBeTruthy();
  }
});
