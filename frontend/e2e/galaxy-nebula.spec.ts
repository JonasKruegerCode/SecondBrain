import { expect, test } from "@playwright/test";

const pages = [
  ["tide-clock", "Tide clock", "sky", true],
  ["star-compass", "Star compass", "sky", false],
  ["harbor-lights", "Harbor lights", "sky", false],
  ["moon-calendar", "Moon calendar", "sky", false],
  ["night-survey", "Night survey", "sky", false],
  ["field-notebook", "Field notebook", "archive", true],
  ["source-slip", "Source slip", "archive", false],
  ["observation", "Observation method", "archive", false],
  ["interpretation", "Interpretation note", "archive", false],
  ["harvest-calendar", "Harvest calendar", "garden", true],
  ["seed-ledger", "Seed ledger", "garden", false],
  ["frost-notes", "Frost notes", "garden", false],
  ["sharpening-notes", "Sharpening notes", "", false],
  ["workbench", "Workbench", "", false],
  ["tool-chest", "Tool chest", "", false],
  ["oil-cloth", "Oil and cloth", "", false],
  ["loose-sketch", "Loose sketch", "", false],
  ["unnamed-slip", "Unnamed slip", "", false],
] as const;

const labels: Record<string, string> = { sky: "Sky & navigation", archive: "Archive practice", garden: "Garden year" };

function fixtureGraph(extra = 0) {
  const nodes: { id: string; title: string; galaxy?: { group: string; label: string; anchor: boolean } }[] = pages.map(([id, title, group, anchor]) => ({
    id, title,
    galaxy: group ? { group, label: labels[group], anchor } : undefined,
  }));
  const edges = [
    ["tide-clock", "star-compass"], ["tide-clock", "harbor-lights"], ["tide-clock", "moon-calendar"], ["tide-clock", "night-survey"],
    ["star-compass", "harbor-lights"], ["moon-calendar", "night-survey"],
    ["field-notebook", "source-slip"], ["field-notebook", "observation"], ["field-notebook", "interpretation"], ["source-slip", "interpretation"],
    ["harvest-calendar", "seed-ledger"], ["harvest-calendar", "frost-notes"], ["seed-ledger", "frost-notes"],
    ["sharpening-notes", "workbench"], ["sharpening-notes", "tool-chest"], ["sharpening-notes", "oil-cloth"], ["workbench", "tool-chest"],
    ["field-notebook", "tide-clock"], ["moon-calendar", "harvest-calendar"], ["source-slip", "seed-ledger"],
  ].map(([source, target]) => ({ source, target, type: "wikilink", rel: source === "field-notebook" && target === "tide-clock" ? "see-also" : undefined }));
  for (let i = 0; i < extra; i++) {
    const id = `density-${String(i).padStart(3, "0")}`;
    nodes.push({ id, title: `Density page ${i + 1}`, galaxy: { group: "archive", label: labels.archive, anchor: false } });
    edges.push({ source: i % 5 === 0 ? "field-notebook" : `density-${String(Math.max(0, i - 1)).padStart(3, "0")}`, target: id, type: "wikilink", rel: undefined });
  }
  return {
    nodes, edges, revision: "fixture-rev", status: "fixture",
    missing_targets: [], ambiguous_targets: [],
  };
}

async function installApi(page: import("@playwright/test").Page, graph = fixtureGraph()) {
  await page.route("**/api/wiki/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/wiki/graph") return route.fulfill({ json: graph });
    if (url.pathname === "/api/wiki/pages") {
      return route.fulfill({ json: { pages: graph.nodes.map(node => ({ id: node.id, title: node.title, excerpt: "Fixture page.", revision: "fixture-rev" })) } });
    }
    if (url.pathname.startsWith("/api/wiki/pages/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/wiki/pages/".length));
      const node = graph.nodes.find(item => item.id === id);
      if (!node) return route.fulfill({ status: 404, json: { detail: "missing" } });
      return route.fulfill({ json: { id, title: node.title, revision: "fixture-rev", markdown: `# ${node.title}\n\nA fixture article.` } });
    }
    return route.fulfill({ status: 404, json: { detail: "unused in this fixture" } });
  });
}

test("nebula galaxy sits in the light app and keeps real links", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installApi(page);
  await page.goto("/");
  await expect(page.locator("header")).toBeVisible();
  await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/home-desktop.png", fullPage: false });
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await expect(page.locator(".galaxy h1")).toHaveText("Follow a connection.");
  const header = (await page.locator("header").boundingBox())!;
  const stage = page.locator(".galaxy-stage");
  await expect(stage.locator("canvas")).toBeVisible();
  const stageBox = (await stage.boundingBox())!;
  expect(stageBox.y).toBeGreaterThan(header.y + header.height - 8);
  await expect(page.locator(".galaxy-star")).toHaveCount(pages.length);
  await expect(page.locator(".galaxy-star.is-core")).toHaveCount(4);
  const tide = page.locator('.galaxy-star[data-node="tide-clock"]');
  await expect(tide).toHaveAttribute("aria-label", /Tide clock/);
  await tide.click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Tide clock");
  await expect(page.locator(".galaxy-sidebar")).toContainText("explicit neighbor");
  await expect(page.locator(".galaxy-evidence")).toContainText("see-also");
  const before = await tide.evaluate(element => element.getBoundingClientRect().top);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const after = await tide.evaluate(element => element.getBoundingClientRect().top);
  expect(after).not.toBe(before);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-zoom-desktop.png" });
  await page.getByRole("link", { name: "Open article" }).click();
  await expect(page).toHaveURL(/\/wiki\/tide-clock$/);
  await expect(page.locator("article h1")).toHaveText("Tide clock");
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/article-desktop.png" });
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-overview-desktop.png" });
  void info;
});

test("nebula galaxy stays usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto("/galaxy?page=field-notebook");
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-mobile.png", fullPage: true });
  const stage = page.locator(".galaxy-stage");
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Field notebook");
});

test("search, empty snapshot and workspace error stay explicit", async ({ page }) => {
  await installApi(page);
  await page.goto("/galaxy");
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("loose");
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await expect(page.locator('.galaxy-star[data-node="tide-clock"]')).toHaveClass(/is-dimmed/);
  await expect(page.locator('.galaxy-star[data-node="loose-sketch"]')).not.toHaveClass(/is-dimmed/);

  await page.unroute("**/api/wiki/**");
  await installApi(page, { nodes: [], edges: [], revision: "empty", status: "empty", missing_targets: [], ambiguous_targets: [] });
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-empty")).toContainText("A quiet sky");

  await page.unroute("**/api/wiki/**");
  await page.route("**/api/wiki/graph", route => route.fulfill({ status: 503, json: { detail: "fixture unavailable" } }));
  await page.goto("/galaxy");
  await expect(page.locator("h1")).toContainText("Couldn’t open the workspace");
});

test("a few hundred stars stay interactive", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installApi(page, fixtureGraph(220));
  const started = Date.now();
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-star")).toHaveCount(pages.length + 220);
  const loadMs = Date.now() - started;
  expect(loadMs).toBeLessThan(8000);
  const paintMs = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('[data-action="zoom-in"]')!;
    const start = performance.now();
    for (let i = 0; i < 12; i++) {
      button.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    }
    return (performance.now() - start) / 12;
  });
  expect(paintMs).toBeLessThan(80);
  console.info(`[nebula-fixture] load ${loadMs}ms, paint ${paintMs.toFixed(1)}ms/frame for ${pages.length + 220} stars`);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-density-desktop.png" });
});

test("reduced motion still draws the field without a drift loop", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await installApi(page);
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  await expect(page.locator('.galaxy-star[data-node="tide-clock"]')).toBeVisible();
  await context.close();
});
