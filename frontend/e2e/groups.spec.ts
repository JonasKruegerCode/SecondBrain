import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

// Real graph contents throughout. Removing only the optional groups field
// exercises old-server fallback parity, not fabricated graph facts.
test("server groups match galaxy fallback and refresh after real curation", async ({ page, request }, info) => {
  const prefix = `groups-${randomUUID()}`;
  const ids = Array.from({ length: 10 }, (_, i) => `${prefix}-${i}`);
  const nodes: { id: string; revision: string }[] = [];
  try {
    for (const [i, id] of ids.entries()) {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: {
        markdown: `# Synthetic record ${i}\n\n${i < 9 ? `[[${ids[i+1]}]]` : "An isolated observation."}`,
        base_revision: null, request_id: randomUUID(),
      } });
      expect(response.ok()).toBe(true);
      nodes.push(await response.json());
    }
    const response = await request.get("/api/wiki/groups");
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    const graph = await (await request.get("/api/wiki/graph")).json();
    expect(graph.groups).toEqual(snapshot.groups);
    expect(graph.revision).toBe(snapshot.revision);
    const mapping = snapshot.groups.flatMap((group: any) => group.members);
    expect(new Set(mapping)).toEqual(new Set(snapshot.nodes.map((node: any) => node.id)));
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-cluster")).toHaveCount(snapshot.groups.filter((g: any) => !g.isolated).length);
    const labels = await page.locator(".galaxy-cluster").allTextContents();
    const cores = await page.locator(".galaxy-star").evaluateAll(stars => stars.map(s => s.getAttribute("data-node")));
    await page.route("**/api/wiki/graph", async route => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.groups;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.locator(".galaxy-cluster")).toHaveCount(labels.length);
    expect(await page.locator(".galaxy-cluster").allTextContents()).toEqual(labels);
    expect(await page.locator(".galaxy-star").evaluateAll(stars => stars.map(s => s.getAttribute("data-node")))).toEqual(cores);
    await page.unroute("**/api/wiki/graph");
    const changed = await request.post(`/api/wiki/pages/${ids[0]}`, { data: {
      markdown: `---\ngalaxy_group: ${prefix}\ngalaxy_label: Synthetic curated records\ngalaxy_anchor: true\n---\n# Synthetic record 0\n[[${ids[1]}]]`,
      base_revision: nodes[0].revision, request_id: randomUUID(),
    } });
    expect(changed.ok()).toBe(true);
    await page.getByRole("link", { name: "Refresh snapshot" }).click();
    const group = page.locator(".galaxy-cluster").filter({ hasText: "Synthetic curated records" });
    await expect(group).toBeVisible();
    await group.click();
    await expect(page.locator(".galaxy-page")).toHaveCount(1);
    await expect(page.locator(".galaxy-page")).toHaveAttribute("data-node", ids[0]);
    const latest = await (await request.get("/api/wiki/groups")).json();
    expect(latest.revision).not.toBe(snapshot.revision);
    expect(latest.groups.find((g: any) => g.group === prefix)).toMatchObject({
      core: ids[0], members: [ids[0]], source: "frontmatter",
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.locator(".galaxy-page")).toBeVisible();
    await page.screenshot({ path: info.outputPath("shared-curated-group-mobile.png"), fullPage: true });
  } finally {
    for (const id of ids) {
      const current = await request.get(`/api/wiki/pages/${id}`);
      if (current.ok()) await request.delete(`/api/wiki/pages/${id}`, { data: {
        base_revision: (await current.json()).revision, request_id: randomUUID(),
      } });
    }
  }
});
