import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  for (const identity of ["Unicode", "leading-hyphen"]) {
  test(`${identity} page identities survive navigation and editing at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const token = randomUUID();
    const source = identity === "Unicode" ? `café-海-${token}` : `-synthetic-${token}`;
    const target = identity === "Unicode" ? `étoile-δ-${token}` : `--companion-${token}`;
    const title = "Synthetic Unicode atlas 海";
    const body = [
      `# ${title}`, "",
      "Fictional multilingual fixture: Café / Cafe\u0301 / 😀 / مرحبا / 海.", "",
      `[[${target}#Bearings 海|Follow the companion]]`, "",
    ].join("\n");
    const companion = `# Synthetic companion Δ\n\n## Bearings 海\n\nFictional companion with [[${source}|Return to the atlas]].\n`;
    const updated = body + "\nSaved from the browser: Ω / 🌊 / résumé / Cafe\u0301.\n";
    const endpoint = (id: string) => `/api/wiki/pages/${encodeURIComponent(id)}`;
    const created: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, markdown] of [[source, body], [target, companion]]) {
        const response = await request.post(endpoint(id), { data: {
          markdown, base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBeTruthy();
        created.push(id);
      }
      await page.goto(`/wiki/${encodeURIComponent(source)}`);
      await expect(page.locator("article h1")).toHaveText(title);
      const follow = page.locator(".prose").getByRole("link", { name: "Follow the companion", exact: true });
      await expect(follow).toHaveAttribute("href", `/wiki/${encodeURIComponent(target)}#${encodeURIComponent("Bearings 海")}`);
      await follow.click();
      await expect(page.locator("article h1")).toHaveText("Synthetic companion Δ");
      await expect(page.locator(".prose h2")).toBeFocused();
      expect(decodeURIComponent(new URL(page.url()).pathname.slice(6))).toBe(target);
      await page.goBack();
      await expect(page.locator("article h1")).toHaveText(title);

      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(body);
      await page.locator("#editor").fill(updated);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".prose")).toContainText("Saved from the browser:");
      expect((await (await request.get(endpoint(source))).json()).markdown).toBe(updated);
      await page.reload();
      await expect(page.locator("article h1")).toHaveText(title);
      expect(await page.locator(".prose").textContent()).toContain("Cafe\u0301");
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(updated);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      const history = await (await request.get(endpoint(source) + "/history")).json();
      expect(history.history).toHaveLength(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`unicode-article-${width}.png`), fullPage: true });

      await page.getByRole("link", { name: "Search", exact: true }).click();
      await page.getByRole("textbox", { name: "Search pages", exact: true }).fill(source);
      await page.getByRole("button", { name: "Search →", exact: true }).click();
      const card = page.locator(".grid a").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      await expect(card).toHaveAttribute("href", `/wiki/${encodeURIComponent(source)}`);
      await card.click();
      await expect(page.locator("article h1")).toHaveText(title);
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
      await expect(page.locator(".galaxy-selected-heading code")).toHaveText(source);
      const graph = await (await request.get("/api/wiki/graph")).json();
      expect(graph.edges.filter((edge: { source: string; target: string }) =>
        [source, target].includes(edge.source) && [source, target].includes(edge.target),
      ).map((edge: { source: string; target: string }) => [edge.source, edge.target]).sort())
        .toEqual([[source, target], [target, source]].sort());
      await expect(page.locator(".galaxy-evidence li")).toHaveCount(2);
      await page.screenshot({ path: testInfo.outputPath(`unicode-galaxy-${width}.png`), fullPage: true });
      await page.locator(".galaxy-selected-heading").getByRole("link", { name: "Open article ↗", exact: true }).click();
      await expect(page.locator("article h1")).toHaveText(title);
      expect((await (await request.get(endpoint(source))).json()).markdown).toBe(updated);
      if (identity === "leading-hyphen") {
        // Saved rendering fixture only: no fabricated provider response.
        await page.evaluate(({ source, title }) => localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify([{
          id: "synthetic-hyphen-source", title: "Synthetic saved source", updated: 1,
          messages: [{ role: "user", content: "Synthetic saved question." },
            { role: "assistant", content: "Synthetic saved display fixture.", sources: [{ id: source, title, evidence: "read" }] }],
        }])), { source, title });
        await page.goto("/chat");
        await expect(page.locator(".chat-message")).toHaveCount(2);
        await page.reload();
        await expect(page.locator(".chat-message")).toHaveCount(2);
        const citation = page.locator(".chat-sources a");
        await expect(citation).toHaveAttribute("href", `/wiki/${encodeURIComponent(source)}`);
        await page.screenshot({ path: testInfo.outputPath(`hyphen-chat-source-${width}.png`), fullPage: true });
        await citation.click();
        await expect(page.locator("article h1")).toHaveText(title);
      }
      expect(errors).toEqual([]);
    } finally {
      for (const id of created.reverse()) {
        const current = await request.get(endpoint(id));
        expect(current.ok()).toBeTruthy();
        const deleted = await request.delete(endpoint(id), { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBeTruthy();
      }
    }
  });
  }
}
