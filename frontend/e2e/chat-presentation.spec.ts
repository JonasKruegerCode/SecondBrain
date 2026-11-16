import { expect } from "@playwright/test";
import { test } from "./reading-test";
import { seedChats } from "./chat-storage";

const answer = `**A useful answer**

- Read the article
- Compare the sources

| Observation | Source | Interpretation |
| --- | --- | --- |
| A synthetic observation | A field note | A possible explanation |

[Open Home](/wiki/home) · [unsafe](javascript:alert(1))

![Untrusted image](https://invalid.example/remote-image.png)

<img src="https://invalid.example/raw.png" onerror="window.chatInjected=true">
<script>window.chatInjected=true</script>

\`<b>literal code</b>\``;

for (const width of [390, 1440]) {
  test(`chat Markdown stays inert, readable and keyboard-scrollable (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    let mediaRequests = 0;
    page.on("request", request => { if (request.url().includes("invalid.example")) mediaRequests++; });
    await page.goto("/chat");
    await seedChats(page, [{ id: "formatting", title: "Synthetic formatting fixture", updated: 1,
      messages: [{ role: "user", content: "A synthetic question" }, { role: "assistant", content: answer }] }]);
    await page.reload();
    const rendered = page.locator(".chat-answer");
    await expect(rendered.locator("strong")).toHaveText("A useful answer");
    await expect(rendered.locator("li")).toHaveCount(2);
    await expect(rendered.locator("th")).toHaveCount(3);
    await expect(rendered.locator("code")).toHaveText("<b>literal code</b>");
    await expect(rendered.locator("img,script,iframe,[onerror],a[href^='javascript:']")).toHaveCount(0);
    expect(await page.evaluate(() => "chatInjected" in window)).toBe(false);
    expect(mediaRequests).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const table = rendered.getByRole("region");
    await table.focus();
    await expect(table).toBeFocused();
    if (width === 390) {
      expect(await table.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => table.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
    await page.screenshot({ path: info.outputPath(`chat-markdown-${width}.png`), fullPage: true });
    await rendered.getByRole("link", { name: "Open Home" }).click();
    await expect(page.locator(".prose")).toBeVisible();
  });
}

test("chat Enter submits once, Shift+Enter and IME confirmation keep the draft", async ({ page }) => {
  // A synthetic provider response tests browser interaction, not model quality.
  let calls = 0;
  let sent: any;
  await page.route("**/api/wiki/chat", route => {
    calls++;
    sent = route.request().postDataJSON();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      answer: "**Synthetic reply**", sources: [], activity: [],
    }) });
  });
  await page.goto("/chat");
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("First line");
  await input.press("Shift+Enter");
  await input.pressSequentially("Second line");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  expect(calls).toBe(0);
  await expect(input).toHaveValue("First line\nSecond line");
  await input.press("Enter");
  await expect(page.locator(".chat-answer strong")).toHaveText("Synthetic reply");
  expect(calls).toBe(1);
  expect(sent.messages.at(-1).content).toBe("First line\nSecond line");
  await expect(input).toHaveValue("");
});
