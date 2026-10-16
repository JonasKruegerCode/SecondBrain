import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  test(`code and comment headings do not become article identity (${width})`, async ({ page, request }, info) => {
    const key = randomUUID(), id = `title-${key}`, source = `title-source-${key}`;
    const title = `Compass entry ${key}`, example = `Code example ${key}`, hidden = `Hidden annotation ${key}`;
    const markdown = `\`\`\`markdown\n# ${example}\n\`\`\`\n\n<!--\n# ${hidden}\n-->\n\n# ${title}\n\nA fictional compass demonstration.\n`;
    const owned: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [pageId, body] of [
        [id, markdown],
        [source, `# Compass index\n\nOpen [[${title}]]; [[${example}]] is only an example.`],
      ]) {
        const created = await request.post(`/api/wiki/pages/${pageId}`, {
          data: { markdown: body, base_revision: null, request_id: randomUUID() },
        });
        expect(created.ok()).toBeTruthy();
        owned.push(pageId);
      }
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/wiki/${source}`);
      const actualLink = page.locator(".prose").getByRole("link", { name: title, exact: true });
      await expect(actualLink).toHaveAttribute("href", `/wiki/${id}`);
      await actualLink.click();
      await expect(page.locator("article > h1")).toHaveText(title);
      await expect(page.locator(".prose pre")).toHaveText(`# ${example}`);
      await expect(page.locator(".prose")).not.toContainText(hidden);
      await expect(page).toHaveTitle(`${title} · Secondbrain`);
      await page.screenshot({ path: info.outputPath(`title-identity-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Edit page" }).click();
      await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await expect(page.locator("article > h1")).toHaveText(title);
      await expect(page.locator(".prose")).not.toContainText(hidden);
      const stored = await request.get(`/api/wiki/pages/${id}`);
      expect(await stored.json()).toMatchObject({ title, markdown });
      expect((await (await request.get(`/api/wiki/pages/${id}/history`)).json()).history).toHaveLength(1);
      const graph = await (await request.get("/api/wiki/graph")).json();
      expect(graph.edges.filter((edge: { source: string }) => edge.source === source))
        .toEqual([{ source, target: id, type: "wikilink" }]);
      expect(graph.missing_targets.filter((edge: { source: string }) => edge.source === source))
        .toEqual([{ source, target: example }]);
      await page.getByRole("link", { name: "Explore connections", exact: true }).click();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
      await page.screenshot({ path: info.outputPath(`title-galaxy-${width}.png`), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      for (const pageId of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${pageId}`);
        expect(current.ok()).toBeTruthy();
        const removed = await request.delete(`/api/wiki/pages/${pageId}`, {
          data: { base_revision: (await current.json()).revision, request_id: randomUUID() },
        });
        expect(removed.ok()).toBeTruthy();
      }
    }
  });
}
