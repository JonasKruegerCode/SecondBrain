import { test, expect } from "@playwright/test";
import { checkTallOverview } from "./galaxy-window";
import { randomUUID } from "node:crypto";

test.skip(process.env.PLAYWRIGHT_TALL !== "1", "Run against a real 320-page, 24-group scale vault.");

test("tall real vault retains all cores and bridges in a readable map window", async ({ page, request }, testInfo) => {
  const response = await request.get("/api/wiki/graph");
  expect(response.ok()).toBe(true);
  const graph = await response.json();
  expect(graph.nodes).toHaveLength(320);
  expect(graph.edges).toHaveLength(664);
  expect(graph.missing_targets).toEqual([]);
  expect(graph.ambiguous_targets).toEqual([]);
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await expect(page.locator(".galaxy-cluster")).toHaveCount(24);
  await page.getByRole("button", { name: "Map view", exact: true }).click();
  await expect(page.locator(".galaxy-star")).toHaveCount(24);
  await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(24);
  await checkTallOverview(page, testInfo);
  await expect(page.locator(".galaxy-star")).toHaveCount(24);
  await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(24);
  const coreResponse = await request.get("/api/wiki/pages/scale-0000");
  const movedResponse = await request.get("/api/wiki/pages/scale-0024");
  expect(coreResponse.ok() && movedResponse.ok()).toBe(true);
  const core = await coreResponse.json(), moved = await movedResponse.json();
  let movedRevision: string | undefined, coreDeleted = false;
  try {
    await page.locator('.galaxy-star[data-node="scale-0000"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "scale-0000");
    const regrouped = await request.post("/api/wiki/pages/scale-0024", { data: {
      markdown: moved.markdown.replace("galaxy_group: synthetic-1\n", "galaxy_group: synthetic-2\n").replace("galaxy_label: Synthetic constellation 1\n", "galaxy_label: Synthetic constellation 2\n"),
      base_revision: moved.revision, request_id: randomUUID(),
    } });
    expect(regrouped.ok()).toBe(true);
    movedRevision = (await regrouped.json()).revision;
    const deleted = await request.delete("/api/wiki/pages/scale-0000", { data: { base_revision: core.revision, request_id: randomUUID() } });
    expect(deleted.ok()).toBe(true);
    coreDeleted = true;
    // The displayed snapshot is intentionally unchanged until refresh. Its
    // old article link must report deletion, never open a different page.
    await expect(page.locator(".galaxy-revision")).toContainText(graph.revision.slice(0, 8));
    await page.getByRole("link", { name: "Open article" }).click();
    await expect(page).toHaveURL(/\/wiki\/scale-0000$/);
    await expect(page.locator("main h1")).toHaveText("This page is missing.");
    await page.getByRole("link", { name: "Galaxy", exact: true }).click();
    const refreshed = await request.get("/api/wiki/graph");
    expect(refreshed.ok()).toBe(true);
    const next = await refreshed.json();
    expect(next.nodes).toHaveLength(319);
    expect(next.edges).toHaveLength(658);
    expect(next.missing_targets).toHaveLength(3);
    expect(next.nodes.find((node: { id: string }) => node.id === "scale-0024").galaxy.group).toBe("synthetic-2");
    await expect(page.locator(".galaxy-revision")).toContainText(next.revision.slice(0, 8));
    await expect(page.locator(".galaxy-stage")).toBeHidden();
    await page.getByRole("button", { name: "Map view", exact: true }).click();
    await expect(page.locator(".galaxy-star")).toHaveCount(24);
    await expect(page.locator('.galaxy-star[data-node="scale-0000"]')).toHaveCount(0);
    await expect(page.locator('.galaxy-star[data-node="scale-0048"]')).toHaveClass(/is-core/);
    await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(23);
    await page.screenshot({ path: testInfo.outputPath("tall-mutated-map.png"), fullPage: true });
    await page.locator('.galaxy-star[data-node="scale-0048"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "scale-0048");
    await page.getByRole("link", { name: "Open article" }).click();
    await expect(page).toHaveURL(/\/wiki\/scale-0048$/);
    await expect(page.locator("article h1")).toHaveText("Synthetic observation 49");
    await page.getByRole("link", { name: "Galaxy", exact: true }).click();
    await page.getByRole("button", { name: /^Synthetic constellation 1 / }).click();
    await expect(page.locator(".galaxy-page")).toHaveCount(12);
    await expect(page.locator('.galaxy-page[data-node="scale-0024"]')).toHaveCount(0);
    await page.getByRole("button", { name: "All constellations" }).click();
    await page.getByRole("button", { name: /^Synthetic constellation 2 / }).click();
    await expect(page.locator(".galaxy-page")).toHaveCount(15);
    await page.locator('.galaxy-page[data-node="scale-0024"]').click();
    await expect(page.locator(".galaxy-evidence")).not.toContainText("scale-0000");
    await expect(page.locator(".galaxy-problems")).toContainText("scale-0000");
    await page.getByRole("link", { name: "Open article" }).click();
    await expect(page).toHaveURL(/\/wiki\/scale-0024$/);
    await expect(page.locator("article h1")).toHaveText("Synthetic observation 25");
    await page.screenshot({ path: testInfo.outputPath("tall-regrouped-article.png"), fullPage: true });
  } finally {
    const repairs: { id: string; markdown: string; base_revision: string | null }[] = [];
    if (coreDeleted) repairs.push({ id: "scale-0000", markdown: core.markdown, base_revision: null });
    if (movedRevision) repairs.push({ id: "scale-0024", markdown: moved.markdown, base_revision: movedRevision });
    const failures: string[] = [];
    // Attempt every owned repair even if another one fails; report the
    // failures after cleanup instead of abandoning the remaining mutation.
    for (const { id, ...data } of repairs) {
      try {
        const restored = await request.post(`/api/wiki/pages/${id}`, { data: { ...data, request_id: randomUUID() } });
        if (!restored.ok()) failures.push(`${id}: HTTP ${restored.status()}`);
      } catch { failures.push(`${id}: restoration request failed`); }
    }
    expect(failures, "restore every mutated synthetic page").toEqual([]);
    const restored = await request.get("/api/wiki/graph");
    expect(restored.ok()).toBe(true);
    const restoredGraph = await restored.json();
    expect(restoredGraph.nodes).toEqual(graph.nodes);
    expect(restoredGraph.edges).toEqual(graph.edges);
    expect(restoredGraph.missing_targets).toEqual([]);
  }
});
