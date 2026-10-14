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

for (const retryMode of ["unchanged", "edited", "restored", "rejected-then-restored"] as const) {
test(`a timed-out save preserves its ${retryMode} draft without another publication`, async ({ page, request }, testInfo) => {
  const fixture = await create(request, "# Save timeout fixture\nBefore.");
  await page.goto(`/wiki/${fixture.id}`);
  await page.clock.install();
  const payloads: { request_id: string; base_revision: string; markdown: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const published = new Promise<void>(resolve => { captured = resolve; });
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
  try {
    await page.getByRole("button", { name: "Edit page" }).click();
    const draft = "# Save timeout fixture\nA synthetic saved change.";
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    await editor.fill(draft);
    await page.getByRole("button", { name: "Save changes" }).click();
    await published;
    const saved = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(saved.markdown).toBe(draft);
    await page.clock.fastForward(30_001);
    await expect(page.locator(".notice")).toContainText("timed out");
    await expect(page.locator(".notice")).toHaveClass(/error/);
    await expect(editor).toHaveValue(draft);
    await expect(editor).toBeEnabled();
    await expect(editor).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("save-timeout-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("save-timeout-mobile.png"), fullPage: true });
    release();
    if (retryMode === "edited") await editor.fill("# Save timeout fixture\nA further unsaved change.");
    if (retryMode === "restored") {
      await editor.fill("# Save timeout fixture\nA temporary correction.");
      await editor.fill(draft); // Same submitted bytes after ordinary input/undo.
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
  } finally { release(); }
});
}

