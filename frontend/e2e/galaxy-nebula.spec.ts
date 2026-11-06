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

async function installApi(page: import("@playwright/test").Page, graph: {
  nodes: { id: string; title: string; galaxy?: { group: string; label: string; anchor: boolean } }[];
  edges: { source: string; target: string; type: string; rel?: string }[];
  revision: string; status: string; missing_targets: unknown[]; ambiguous_targets: unknown[];
} = fixtureGraph()) {
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

function syntheticGalaxy() {
  const nodes: { id: string; title: string; galaxy?: { group: string; label: string; anchor: boolean } }[] = [];
  const edges: { source: string; target: string; type: string; rel?: string }[] = [];
  const add = (id: string, title: string, group = "", label = "", anchor = false) => {
    nodes.push({ id, title, galaxy: group ? { group, label, anchor } : undefined });
  };
  const link = (source: string, target: string, rel?: string) => {
    edges.push({ source, target, type: "wikilink", ...(rel ? { rel } : {}) });
  };
  add("harbor-hub", "Harbor archive hub", "harbor", "Harbor archive", true);
  for (let pocket = 0; pocket < 8; pocket++) {
    const lead = `harbor-p${pocket}-lead`;
    add(lead, `Harbor pocket ${pocket + 1} lead`, "harbor", "Harbor archive", false);
    link("harbor-hub", lead, pocket === 0 ? "see-also" : undefined);
    link(lead, "harbor-hub");
    for (let i = 0; i < 40; i++) {
      const id = `harbor-p${pocket}-${String(i).padStart(2, "0")}`;
      add(id, `Harbor note ${pocket + 1}.${i + 1}`, "harbor", "Harbor archive", false);
      link(lead, id);
      if (i > 0) link(id, `harbor-p${pocket}-${String(i - 1).padStart(2, "0")}`);
    }
  }
  const curated = (group: string, label: string, count: number) => {
    const core = `${group}-core`;
    add(core, `${label} core`, group, label, true);
    for (let i = 0; i < count; i++) {
      const id = `${group}-${String(i).padStart(3, "0")}`;
      add(id, `${label} page ${i + 1}`, group, label, false);
      link(core, id);
      if (i > 0 && i % 3 !== 0) link(id, `${group}-${String(i - 1).padStart(3, "0")}`);
    }
    return core;
  };
  const garden = curated("garden", "Garden year", 80);
  const sky = curated("sky", "Sky desk", 60);
  const workshop = curated("workshop", "Workshop bench", 48);
  const atlas = curated("atlas", "Atlas crossroads", 36);
  const ledger = curated("ledger", "Ledger room", 80);
  link("harbor-hub", garden, "see-also");
  link(sky, "harbor-hub");
  link(workshop, garden);
  link(atlas, sky);
  link(atlas, workshop);
  link(ledger, "harbor-hub");
  for (let clump = 0; clump < 6; clump++) {
    const core = `fiber-c${clump}-core`;
    add(core, `Fiber community ${clump + 1}`);
    for (let i = 0; i < 22; i++) {
      const id = `fiber-c${clump}-${String(i).padStart(2, "0")}`;
      add(id, `Fiber page ${clump + 1}.${i + 1}`);
      link(core, id);
      link(id, core);
    }
    if (clump > 0) link(core, `fiber-c${clump - 1}-core`);
  }
  link("fiber-c0-core", "harbor-hub");
  link("fiber-c5-core", atlas);
  for (let i = 0; i < 40; i++) add(`isolate-${String(i).padStart(2, "0")}`, `Loose slip ${i + 1}`);
  return {
    nodes, edges, revision: "synthetic-galaxy-fixture", status: "fixture",
    missing_targets: [], ambiguous_targets: [],
  };
}

async function markFixture(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.querySelector("[data-fixture-caption]")?.remove();
    const note = document.createElement("p");
    note.dataset.fixtureCaption = "1";
    note.textContent = "Test fixture — synthetic graph, not a private wiki";
    note.style.cssText = "margin:0 0 10px;background:#fff;color:#17324f;border:1px solid #c5d7ea;border-radius:8px;padding:6px 10px;font:600 12px sans-serif";
    document.querySelector(".galaxy")?.prepend(note);
  });
}

async function gestureCost(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const host = document.querySelector(".galaxy-stage")!;
    const rect = host.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const quantile = (values: number[], q: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
    };
    const pan: number[] = [];
    host.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true, clientX: cx, clientY: cy, button: 0, buttons: 1 }));
    const started = performance.now();
    for (let i = 0; i < 160; i++) {
      const x = cx + Math.sin(i / 7) * 90;
      const y = cy + Math.cos(i / 5) * 60;
      const t = performance.now();
      host.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      pan.push(performance.now() - t);
    }
    host.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, clientX: cx, clientY: cy, button: 0 }));
    const zoom: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      host.dispatchEvent(new WheelEvent("wheel", { deltaY: i % 2 ? 90 : -90, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      zoom.push(performance.now() - t);
    }
    return {
      durationMs: performance.now() - started,
      panSamples: pan.length,
      zoomSamples: zoom.length,
      panMedianMs: quantile(pan, 0.5),
      panP95Ms: quantile(pan, 0.95),
      zoomMedianMs: quantile(zoom, 0.5),
      zoomP95Ms: quantile(zoom, 0.95),
    };
  });
}

test("synthetic contract graph stays a filled galaxy at realistic density", async ({ page }) => {
  test.setTimeout(90_000);
  const graph = syntheticGalaxy();
  expect(graph.nodes).toHaveLength(816);
  expect(graph.nodes.filter(node => !node.galaxy)).toHaveLength(138 + 40);
  expect(graph.nodes.filter(node => node.id.startsWith("harbor-"))).toHaveLength(329);
  await page.setViewportSize({ width: 1440, height: 900 });
  await installApi(page, graph);
  const started = Date.now();
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-star")).toHaveCount(816);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator(".galaxy-cluster")).toHaveCount(14);
  await expect(page.locator(".galaxy-cluster").filter({ hasText: "link topology" })).toHaveCount(8);
  await expect(page.locator(".galaxy-snapshot")).toContainText("40 unlinked");
  await expect(page.locator(".galaxy-bridge-index li").first()).toBeAttached();
  const radial = await page.locator('[data-node^="harbor-"]').evaluateAll(elements => {
    const points = elements.map(element => ({
      x: Number(element.getAttribute("data-x")),
      y: Number(element.getAttribute("data-y")),
      id: element.getAttribute("data-node"),
    }));
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const radii = points.map(point => ({ id: point.id, r: Math.hypot(point.x - cx, point.y - cy) }));
    const max = Math.max(...radii.map(point => point.r));
    const bins = [0, 0, 0, 0, 0];
    radii.forEach(point => bins[Math.min(4, Math.floor((point.r / max) * 5))] += 1);
    return { bins, hub: radii.find(point => point.id === "harbor-hub")!.r, max };
  });
  console.info(`[nebula-fixture] harbor radial bins ${JSON.stringify(radial)}`);
  await markFixture(page);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-fixture-overview-desktop.png" });
  expect(radial.bins[0], "the large group must keep stars in the middle").toBeGreaterThan(5);
  expect(radial.bins[4], "the large group must not fall back to a surrounding ring").toBeLessThan(radial.bins[1] + radial.bins[2]);
  expect(radial.hub).toBeLessThan(radial.max * 0.35);
  const loadMs = Date.now() - started;
  expect(loadMs).toBeLessThan(8000);
  await page.locator('.galaxy-star[data-node="harbor-hub"]').focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Harbor archive hub");
  await expect(page.locator(".galaxy-evidence")).toContainText("see-also");
  await markFixture(page);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-fixture-zoom-hub-desktop.png" });
  await page.getByRole("button", { name: "Neighborhood pages" }).click();
  await markFixture(page);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-fixture-dense-desktop.png" });
  const desktop = await gestureCost(page);
  expect(desktop.panSamples).toBe(160);
  expect(desktop.zoomSamples).toBe(40);
  expect(desktop.panP95Ms).toBeLessThan(80);
  expect(desktop.zoomP95Ms).toBeLessThan(80);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await markFixture(page);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-fixture-mobile-overview.png", fullPage: true });
  await page.locator('.galaxy-star[data-node="harbor-hub"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Harbor archive hub");
  await markFixture(page);
  await page.screenshot({ path: "/opt/cursor/artifacts/galaxy-integration/galaxy-fixture-mobile-details.png", fullPage: true });
  const narrow = await gestureCost(page);
  expect(narrow.panP95Ms).toBeLessThan(120);
  expect(narrow.zoomP95Ms).toBeLessThan(120);
  console.info(`[nebula-fixture] 816-node contract graph load ${loadMs}ms; desktop ${JSON.stringify(desktop)}; narrow ${JSON.stringify(narrow)}`);
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
