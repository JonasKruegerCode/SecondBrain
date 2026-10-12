import { test, expect } from "@playwright/test";
import { checkTallOverview } from "./galaxy-window";

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
});
