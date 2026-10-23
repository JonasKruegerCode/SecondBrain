import { openAllPages } from "./navigation";
import { installWikiChatStorage, failWikiChatWrites } from "./wiki-chat-storage";
import { test, expect, APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { checkTallOverview } from "./galaxy-window";
import { traceFirstInstall, readFirstInstallTrace } from "./pwa-install-trace";

test.beforeEach(async ({ page }) => { await installWikiChatStorage(page); });

// The separate WebKit worker slice uses these actual lifecycle tests. Reading
// tests in other files retain their routing-compatible worker-blocked profile.
test.use({ serviceWorkers: "allow" });
test.beforeEach(async ({ browser, serviceWorkers, page }, info) => {
  if (info.title === "PWA metadata registers an online-only worker without private caches") {
    await traceFirstInstall(page);
  }
  if (info.title.startsWith("PWA")) {
    console.info("[pwa-worker-browser] " + JSON.stringify({
      engine: browser.browserType().name(), service_workers: serviceWorkers,
    }));
  }
});
test.afterEach(async ({ page }, info) => {
  if (info.title === "PWA metadata registers an online-only worker without private caches") {
    console.info("[pwa-first-install-trace] " + JSON.stringify(await readFirstInstallTrace(page)));
  }
});

test.describe("galaxy touch navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("choosing a constellation brings its map into view", async ({ page }, testInfo) => {
    await page.goto("/galaxy");
    const cluster = page.locator(".galaxy-cluster").filter({ hasText: "Sky & navigation" });
    await cluster.tap();
    await expect(page.locator(".galaxy-breadcrumb")).toContainText("Sky & navigation");
    await page.screenshot({ path: testInfo.outputPath("touch-constellation.png") });
    await expect(page.locator(".galaxy-stage")).toBeInViewport({ ratio: .8 });
  });

  test("tapping a star brings its article and evidence into view", async ({ page }, testInfo) => {
    await page.goto("/galaxy");
    const star = page.locator(".galaxy-star.is-core").first();
    const id = await star.getAttribute("data-node");
    await star.tap();
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id!);
    await page.screenshot({ path: testInfo.outputPath("touch-page-evidence.png") });
    await expect(page.locator(".galaxy-selected-heading")).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".galaxy-evidence")).toBeInViewport();
    const neighbor = page.locator(".galaxy-evidence button[data-node]").last();
    const neighborId = await neighbor.getAttribute("data-node");
    await neighbor.scrollIntoViewIfNeeded();
    expect(await page.locator(".galaxy-sidebar-content").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await neighbor.tap();
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", neighborId!);
    await expect(page.locator(".galaxy-selected-heading")).toBeInViewport({ ratio: 1 });
    expect(await page.locator(".galaxy-sidebar-content").evaluate(el => el.scrollTop)).toBe(0);
    await page.locator(".galaxy-selected-heading .galaxy-article").tap();
    await expect(page).toHaveURL(new RegExp(`/wiki/${neighborId}$`));
  });

  test("list navigation keeps the map hidden and reveals selected pages", async ({ page }) => {
    await page.goto("/galaxy");
    await page.getByRole("button", { name: "List view", exact: true }).tap();
    await page.locator(".galaxy-cluster").filter({ hasText: "Sky & navigation" }).tap();
    await expect(page.locator(".galaxy-stage")).toBeHidden();
    await page.locator(".galaxy-page").last().tap();
    await expect(page.locator(".galaxy-stage")).toBeHidden();
    await expect(page.locator(".galaxy-selected-heading")).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeInViewport();
  });

  test("focused map keeps labels and spaced touch targets usable after resize and zoom", async ({ page }, testInfo) => {
    await page.goto("/galaxy");
    await page.locator(".galaxy-cluster").filter({ hasText: "Sky & navigation" }).tap();
    const metrics = () => page.locator(".galaxy-stage svg").evaluate(svg => {
      const core = svg.querySelector<SVGGraphicsElement>(".galaxy-star.is-core")!;
      const unit = core.getScreenCTM()!.a;
      const map = svg.getBoundingClientRect();
      return {
        hit: Number(core.querySelector(".galaxy-hit")!.getAttribute("r")) * 2 * unit,
        label: parseFloat(getComputedStyle(core.querySelector("text")!).fontSize) * unit,
        centersVisible: [...svg.querySelectorAll<SVGGraphicsElement>(".galaxy-star")].every(star => {
          const point = new DOMPoint(0, 0).matrixTransform(star.getScreenCTM()!);
          return point.x >= map.left + 8 && point.x <= map.right - 8 && point.y >= map.top + 8 && point.y <= map.bottom - 8;
        }),
      };
    });
    for (const width of [390, 320, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(async () => (await metrics()).label).toBeGreaterThanOrEqual(11.99);
      expect((await metrics()).hit).toBeGreaterThanOrEqual(43.99);
      expect((await metrics()).centersVisible).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath("touch-focused-fit.png") });
    await page.getByRole("button", { name: "Zoom in", exact: true }).tap();
    await expect.poll(async () => (await metrics()).label).toBeGreaterThanOrEqual(11.99);
    expect((await metrics()).hit).toBeGreaterThanOrEqual(43.99);
    await page.getByRole("button", { name: "Reset", exact: true }).tap();
    expect((await metrics()).centersVisible).toBe(true);
    const id = await page.locator(".galaxy-star.is-core").getAttribute("data-node");
    await page.locator(".galaxy-star.is-core").tap();
    await page.locator(".galaxy-selected-heading .galaxy-article").tap();
    await expect(page).toHaveURL(new RegExp(`/wiki/${id}$`));
  });

  test("overview labels stay readable and separate through resize and zoom", async ({ page }, testInfo) => {
    await page.goto("/galaxy");
    const metrics = () => page.locator(".galaxy-stage svg").evaluate(svg => {
      const unit = (svg as SVGSVGElement).getScreenCTM()!.a;
      const labels = [...svg.querySelectorAll<SVGTextElement>(".galaxy-neighborhood text, .galaxy-bridge-count")];
      const titles = [...svg.querySelectorAll<SVGTextElement>(".galaxy-neighborhood text:not(.galaxy-count)")];
      const counts = [...svg.querySelectorAll<SVGTextElement>(".galaxy-count")];
      const bounds = svg.getBoundingClientRect();
      const rects = titles.map(el => el.getBoundingClientRect());
      const visibleLabels = labels.filter(el => getComputedStyle(el).visibility !== "hidden").map(el => el.getBoundingClientRect());
      const dots = [...svg.querySelectorAll(".galaxy-dot")].map(el => el.getBoundingClientRect());
      const bridges = [...svg.querySelectorAll(".galaxy-bridge-count")].filter(el => getComputedStyle(el).visibility !== "hidden").map(el => el.getBoundingClientRect());
      return {
        smallest: Math.min(...labels.map(el => parseFloat(getComputedStyle(el).fontSize) * unit)),
        titlesInside: rects.every(r => r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom),
        separated: rects.every((r, i) => counts[i].getBoundingClientRect().top >= r.bottom + 1),
        distinct: rects.every((r, i) => rects.slice(i + 1).every(b => r.right <= b.left || b.right <= r.left || r.bottom <= b.top || b.bottom <= r.top)),
        bridgesClear: visibleLabels.every((r, i) => visibleLabels.slice(i + 1).every(b => r.right <= b.left || b.right <= r.left || r.bottom <= b.top || b.bottom <= r.top)),
        starsClear: bridges.every(r => dots.every(b => r.right <= b.left || b.right <= r.left || r.bottom <= b.top || b.bottom <= r.top)),
      };
    });
    for (const width of [390, 320, 1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // A larger viewport initially scales the previous fonts up, so a minimum
      // size alone passes before ResizeObserver has refitted the new columns.
      await expect.poll(async () => {
        const measured = await metrics();
        return Math.abs(measured.smallest - 11) < .01 && measured.titlesInside && measured.separated && measured.distinct && measured.bridgesClear && measured.starsClear;
      }).toBe(true);
      const measured = await metrics();
      expect(measured.titlesInside).toBe(true);
      expect(measured.separated).toBe(true);
      expect(measured.distinct).toBe(true);
      expect(measured.bridgesClear).toBe(true);
      expect(measured.starsClear).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`overview-readable-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Zoom in", exact: true }).tap();
    expect((await metrics()).smallest).toBeGreaterThanOrEqual(9.99);
    expect((await metrics()).separated).toBe(true);
    await page.getByRole("button", { name: "Reset", exact: true }).tap();
    await page.locator(".galaxy-cluster").filter({ hasText: "Sky & navigation" }).tap();
    await page.getByRole("button", { name: "All constellations" }).tap();
    await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(6);
    expect((await metrics()).smallest).toBeGreaterThanOrEqual(9.99);
    const id = await page.locator(".galaxy-star.is-core").first().getAttribute("data-node");
    await page.locator(`.galaxy-star[data-node="${id}"]`).focus();
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator(`.galaxy-star[data-node="${id}"]`)).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id!);
  });

  test("many real constellations keep readable labels and reachable distant cores", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const group = `tall-${randomUUID()}`;
    const ids = Array.from({ length: 20 }, (_, i) => `${group}-${i}`);
    const saved: { id: string; revision: string }[] = [];
    try {
      for (const [index, id] of ids.entries()) {
        const response = await request.post(`/api/wiki/pages/${id}`, { data: {
          markdown: `---\ngalaxy_group: ${id}\ngalaxy_label: Synthetic constellation ${index + 1}\ngalaxy_anchor: true\n---\n# Synthetic core ${index + 1}\n\n[[${ids[(index + 1) % ids.length]}]]`,
          base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true);
        saved.push({ id, revision: (await response.json()).revision });
      }
      await page.goto("/galaxy");
      await expect(page.locator(".galaxy-neighborhood")).toHaveCount(24);
      await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(26);
      await checkTallOverview(page, testInfo);
      await expect(page.locator(".galaxy-neighborhood")).toHaveCount(24);
      await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(26);

      // Change the actual snapshot while its old map is open. A new page
      // keeps the first group alive when its original core is deleted.
      const fallback = await create(request, `---\ngalaxy_group: ${ids[0]}\ngalaxy_label: Synthetic constellation 1\n---\n# Synthetic replacement core\n\n[[${ids[0]}]] and [[${ids[1]}]].`);
      saved.push(fallback);
      const regrouped = await request.post(`/api/wiki/pages/${ids[2]}`, { data: {
        markdown: `---\ngalaxy_group: ${ids[1]}\ngalaxy_label: Synthetic constellation 2\n---\n# Regrouped synthetic page\n\n[[${ids[3]}]]`,
        base_revision: saved[2].revision, request_id: randomUUID(),
      } });
      expect(regrouped.ok()).toBe(true);
      saved[2].revision = (await regrouped.json()).revision;
      const removed = await request.delete(`/api/wiki/pages/${ids[0]}`, { data: { base_revision: saved[0].revision, request_id: randomUUID() } });
      expect(removed.ok()).toBe(true);
      saved.shift();
      await expect(page.locator(".galaxy-neighborhood")).toHaveCount(24);
      const revisionBefore = await page.locator(".galaxy-revision").textContent();
      await page.getByRole("link", { name: "Refresh snapshot" }).click();
      await expect(page.locator(".galaxy-neighborhood")).toHaveCount(23);
      await expect(page.locator(".galaxy-revision")).not.toHaveText(revisionBefore!);
      await expect(page.locator(`.galaxy-star[data-node="${ids[0]}"]`)).toHaveCount(0);
      await expect(page.locator(`.galaxy-star[data-node="${fallback.id}"]`)).toHaveClass(/is-core/);
      await expect(page.locator(".galaxy-status")).toContainText("2 unresolved targets");
      await page.getByRole("button", { name: /^Synthetic constellation 2 / }).click();
      await expect(page.locator(".galaxy-star")).toHaveCount(2);
      await page.locator(`.galaxy-page[data-node="${ids[2]}"]`).click();
      await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Regrouped synthetic page");
      await page.getByRole("link", { name: "Open article" }).click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${ids[2]}$`));
      await expect(page.locator("article h1")).toHaveText("Regrouped synthetic page");
      await page.getByRole("link", { name: "Galaxy", exact: true }).click();
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await page.getByRole("button", { name: /^Synthetic constellation 1 / }).click();
      await expect(page.locator(".galaxy-stage")).toBeHidden();
      await page.locator(`.galaxy-page[data-node="${fallback.id}"]`).click();
      await expect(page.locator(".galaxy-evidence")).not.toContainText(ids[0]);
      await expect(page.locator(".galaxy-problems")).toContainText(ids[0]);
      await page.getByRole("link", { name: "Open article" }).click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${fallback.id}$`));
      await expect(page.locator("article h1")).toHaveText("Synthetic replacement core");
      await page.screenshot({ path: testInfo.outputPath("tall-mutated-article.png"), fullPage: true });
    } finally {
      for (const item of saved) {
        const response = await request.delete(`/api/wiki/pages/${item.id}`, { data: { base_revision: item.revision, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
      }
    }
  });

  test("long overview labels fit without losing their full names", async ({ page, request }, testInfo) => {
    const label = "Fictional constellation with a deliberately long title ✨ and stable identity";
    const item = await create(request, `---\ngalaxy_group: long-${randomUUID()}\ngalaxy_label: ${label}\n---\n# Long-name core\n[[home]]`);
    try {
      await page.goto("/galaxy");
      const neighborhood = page.locator(".galaxy-neighborhood").filter({ has: page.locator("title", { hasText: label }) });
      const title = neighborhood.locator("text:not(.galaxy-count)");
      await expect(title).toContainText("…");
      await expect(neighborhood.locator("title")).toContainText(label);
      const box = (await title.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(155);
      await page.screenshot({ path: testInfo.outputPath("overview-long-name.png"), fullPage: true });
      await page.locator(".galaxy-cluster").filter({ hasText: label }).tap();
      await expect(page.locator(".galaxy-breadcrumb")).toContainText(label);
      await page.locator(".galaxy-page").tap();
      await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", item.id);
    } finally {
      await request.delete(`/api/wiki/pages/${item.id}`, { data: { base_revision: item.revision, request_id: randomUUID() } });
    }
  });

  test("dense constellations keep distinct targets and unlinked pages stay reachable", async ({ page, request }, testInfo) => {
    // Real Git publications for setup and cleanup dominate this bounded fixture.
    test.setTimeout(180_000);
    const group = `density-${randomUUID()}`;
    const ids = Array.from({ length: 128 }, (_, i) => `${group}-${i}`);
    const saved: { id: string; revision: string }[] = [];
    try {
      for (const [i, id] of ids.entries()) {
        const response = await request.post(`/api/wiki/pages/${id}`, { data: {
          markdown: `---\ngalaxy_group: ${group}\ngalaxy_label: Dense synthetic constellation\ngalaxy_anchor: ${i === 0}\n---\n# Dense page ${i + 1}\n[[${ids[(i + 1) % ids.length]}]]`,
          base_revision: null, request_id: randomUUID(),
        } });
        expect(response.ok()).toBe(true);
        saved.push({ id, revision: (await response.json()).revision });
      }
      await page.goto("/galaxy");
      await page.locator(".galaxy-cluster").filter({ hasText: "Dense synthetic constellation" }).tap();
      await expect(page.locator(".galaxy-star")).toHaveCount(128);
      const targets = () => page.locator(".galaxy-star").evaluateAll(elements => elements.map(element => {
        const star = element as SVGGraphicsElement, matrix = star.getScreenCTM()!;
        const center = new DOMPoint(0, 0).matrixTransform(matrix);
        return { id: star.getAttribute("data-node")!, x: center.x, y: center.y, r: Number(star.querySelector(".galaxy-hit")!.getAttribute("r")) * matrix.a };
      }));
      const distinct = async () => {
        const points = await targets();
        let clearance = Infinity, pair = [points[0], points[1]];
        for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
          const gap = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) - points[i].r - points[j].r;
          if (gap < clearance) { clearance = gap; pair = [points[i], points[j]]; }
        }
        expect(clearance, "dense hit circles must not intercept their neighbors").toBeGreaterThan(0);
        return pair;
      };
      await page.screenshot({ path: testInfo.outputPath("dense-128.png") });
      const pair = await distinct();
      for (const target of pair) {
        await page.locator(`.galaxy-star[data-node="${target.id}"]`).tap();
        await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", target.id);
      }
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in", exact: true }).tap();
      await distinct();
      await page.getByRole("button", { name: "All constellations" }).tap();
      for (let i = 0; i < 40; i++) {
        const item = await create(request, `# Unlinked synthetic page ${i + 1}\nAn independent fictional note.`);
        saved.push(item);
      }
      await page.reload();
      const last = saved.at(-1)!;
      const star = page.locator(`.galaxy-star[data-node="${last.id}"]`);
      await star.focus();
      await expect(star).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", last.id);
      await expect(page.locator(".galaxy-evidence li")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("unlinked-selection.png") });
      await page.locator(".galaxy-selected-heading .galaxy-article").tap();
      await expect(page).toHaveURL(new RegExp(`/wiki/${last.id}$`));
    } finally {
      for (const item of saved.reverse()) {
        const response = await request.delete(`/api/wiki/pages/${item.id}`, { data: { base_revision: item.revision, request_id: randomUUID() } });
        expect(response.ok(), "synthetic density fixture cleanup").toBe(true);
      }
    }
  });
});

async function create(request: APIRequestContext, markdown: string) {
  const id = `e2e-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: null, request_id: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return { id, ...(await response.json()) };
}

async function update(
  request: APIRequestContext,
  id: string,
  markdown: string,
  revision: string,
) {
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: revision, request_id: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

function contrastRatio(foreground: string, background: string) {
  const rgb = (value: string) => {
    if (value.startsWith("#")) {
      const hex = value.slice(1);
      return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    }
    return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  };
  const luminance = (value: string) => {
    const channels = rgb(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function pwaUpdateProxy() {
  let release = 1;
  let failWorker = false;
  let failedWorkerRequests = 0;
  let saveGate: { reached: () => void; resume: Promise<void>; body: boolean } | undefined;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url || "/";
      if (path.startsWith("/service-worker.js") && failWorker) {
        failWorker = false;
        failedWorkerRequests++;
        response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Synthetic worker script temporarily unavailable.");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(`http://127.0.0.1:5173${path}`, {
        method: request.method,
        headers: {
          accept: request.headers.accept || "*/*",
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
        },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      if (path.startsWith("/service-worker.js")) {
        body = Buffer.from(
          body
            .toString()
            + `\n/* Synthetic update-probe release ${release}. */\n`,
        );
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/javascript");
        response.setHeader("Service-Worker-Allowed", "/");
      } else {
        upstream.headers.forEach((value, key) => {
          if (!["content-encoding", "content-length", "transfer-encoding"].includes(key)) {
            response.setHeader(key, value);
          }
        });
      }
      if (request.method === "POST" && path.startsWith("/api/wiki/pages/") && saveGate) {
        const gate = saveGate;
        saveGate = undefined;
        if (gate.body) {
          response.writeHead(upstream.status);
          response.flushHeaders();
        }
        gate.reached();
        await gate.resume;
      }
      if (!response.headersSent) response.writeHead(upstream.status);
      response.end(body);
    } catch {
      response.writeHead(502);
      response.end("PWA test proxy failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bump: () => release++,
    failNextWorkerUpdate: () => { failWorker = true; },
    failedWorkerRequests: () => failedWorkerRequests,
    holdNextSave: (body = false) => {
      let reached!: () => void;
      let resume!: () => void;
      const arrived = new Promise<void>(resolve => { reached = resolve; });
      const pending = new Promise<void>(resolve => { resume = resolve; });
      saveGate = { reached, resume: pending, body };
      return { arrived, release: resume };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("demo galaxy summarizes bridges without dropping its pages or internal links", async ({ page }, testInfo) => {
  const bridges = [
    "12 explicit links between Archive practice and Atlas crossroads",
    "11 explicit links between Archive practice and Shore observations",
    "15 explicit links between Archive practice and Sky & navigation",
    "9 explicit links between Atlas crossroads and Shore observations",
    "8 explicit links between Atlas crossroads and Sky & navigation",
    "4 explicit links between Shore observations and Sky & navigation",
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    // Demo table aliases must be real rendered links, not phantom graph edges
    // synthesized by treating the alias separator as another GFM column.
    for (const [id, columns, links] of [["lantern-festival", 3, 6], ["harvest-calendar", 3, 3]] as const) {
      await page.goto(`/wiki/${id}`);
      await expect(page.locator(".prose table thead th")).toHaveCount(columns);
      await expect(page.locator(".prose table tbody td")).toHaveCount(9);
      await expect(page.locator(".prose table a[data-wiki-target]")).toHaveCount(links);
      await expect(page.locator(".prose table a[href^='/resolve']")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`demo-table-${id}-${width}.png`), fullPage: true });
    }
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-star")).toHaveCount(12);
    await expect(page.locator(".galaxy-edge:not(.is-bridge)")).toHaveCount(22);
    await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(6);
    expect((await page.locator(".galaxy-aggregate-link title").allTextContents()).sort()).toEqual([...bridges].sort());
    await expect(page.locator(".galaxy-mapnote")).toContainText("Combined links between constellations");
    await page.screenshot({ path: testInfo.outputPath(`demo-galaxy-bridges-${width}.png`), fullPage: true });
  }
});

test("home opens a wiki page, resolves an alias, and survives back and reload", async ({
  page,
}) => {
  await page.goto("/?overview=1");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: /Open Lantern Bay field atlas/ })
    .click();
  await expect(page).toHaveURL(/\/wiki\/home$/);
  await expect(page.locator("article h1")).toHaveCount(1);
  await page
    .getByRole("link", { name: "night sky survey", exact: true })
    .click();
  await expect(page).toHaveURL(/\/wiki\/night-sky-survey$/);
  await page.reload();
  await expect(page.locator("article h1")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/wiki\/home$/);
  await expect(
    page.getByRole("link", { name: "night sky survey", exact: true }),
  ).toBeVisible();
});

test("home card previews are readable plain-text summaries", async ({ page }) => {
  await page.goto("/?overview=1");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();

  const notebook = page.locator(".card", { hasText: "Field notebook" }).locator("p");
  await expect(notebook).toContainText("Question:");
  await expect(notebook).not.toContainText("**");

  const calendar = page
    .locator(".card", { hasText: "Harvest calendar" })
    .locator("p");
  await expect(calendar).toContainText("Record · What it can tell us");
  await expect(calendar).not.toContainText("|");
});

test("small muted text keeps AA contrast on light wiki surfaces", async ({ page }) => {
  const checks = [
    ["header nav a:not(.active)", "#f6f7f2"],
    [".workspace", "#f6f7f2"],
    [".intro p", "#f6f7f2"],
    [".section-heading > span", "#f6f7f2"],
    [".card-meta", "#ffffff"],
    [".card p", "#ffffff"],
    [".card-foot", "#ffffff"],
    ["footer", "#f6f7f2"],
  ] as const;

  await page.goto("/?overview=1");
  for (const [selector, background] of checks) {
    const foreground = await page.locator(selector).first().evaluate(
      (element) => getComputedStyle(element).color,
    );
    expect(contrastRatio(foreground, background), selector).toBeGreaterThanOrEqual(4.5);
  }

  await page.goto("/wiki/home");
  const links = page.locator(".prose a");
  await expect(links.first()).toBeVisible();
  expect(await links.count()).toBeGreaterThan(0);
  for (const link of await links.all()) {
    const colors = await link.evaluate(element => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
    // Measure the actual tinted link surface, rather than the article's white.
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
  }

  await page.goto("/chat");
  for (const selector of [".chat-history-heading", ".chat-heading p", ".chat-empty"]) {
    const foreground = await page.locator(selector).evaluate(
      (element) => getComputedStyle(element).color,
    );
    expect(contrastRatio(foreground, "#ffffff"), selector).toBeGreaterThanOrEqual(4.5);
  }
});

test("mobile chat opens at its heading without forcing composer focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");

  await expect(page.getByRole("heading", { name: "Ask, then follow the evidence." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).not.toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);

  await page.getByRole("button", { name: "New", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= -1 && rect.bottom <= innerHeight + 1;
  })).toBe(true);
});

test("saved chat labels and evidence controls remain readable and touchable", async ({ page }, testInfo) => {
  // A synthetic local history tests rendering only; it is not a generated model answer.
  await page.goto("/?overview=1");
  await page.evaluate(async () => {
    await window.__wikiChatWrite([{
      id: "synthetic-accessibility-history",
      title: "Reading the demo wiki",
      updated: 1,
      messages: [
        { role: "user", content: "Where can I start exploring the demo wiki?" },
        {
          role: "assistant",
          content: "This saved rendering fixture links to the demo Home article.",
          sources: [{ id: "home", title: "Home", evidence: "read" }],
          activity: ["Read the synthetic Home article."],
        },
      ],
    }]);
  });
  let chatRequests = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/wiki/chat") chatRequests++;
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/chat");
    await expect(page.locator(".chat-message")).toHaveCount(2);
    for (const selector of [".user .chat-role", ".assistant .chat-role", ".chat-message summary", ".chat-sources > span", ".chat-sources a", ".chat-sources small"]) {
      const colors = await page.locator(selector).evaluate(element => {
        const style = getComputedStyle(element);
        const surface = element.closest("a") || element.closest(".chat-message")!;
        const background = getComputedStyle(surface).backgroundColor;
        const channels = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
        const foregroundRgb = channels(style.color);
        const backgroundRgb = channels(background);
        const opacity = Number(style.opacity);
        let opaqueAncestors = true;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (Number(getComputedStyle(parent).opacity) !== 1) opaqueAncestors = false;
        }
        return {
          foreground: `rgb(${foregroundRgb.slice(0, 3).map((channel, i) => channel * opacity + backgroundRgb[i] * (1 - opacity)).join(",")})`,
          background,
          opaque: (foregroundRgb.length === 3 || foregroundRgb[3] === 1) &&
            (backgroundRgb.length === 3 || backgroundRgb[3] === 1) && opaqueAncestors,
          fontSize: parseFloat(style.fontSize),
        };
      });
      // Fail rather than mismeasure if a later theme introduces extra alpha layers.
      expect(colors.opaque, `${width}px ${selector} opaque color surfaces`).toBe(true);
      expect.soft(contrastRatio(colors.foreground, colors.background), `${width}px ${selector} contrast`).toBeGreaterThanOrEqual(4.5);
      if (selector.endsWith(".chat-role")) expect.soft(colors.fontSize).toBeGreaterThanOrEqual(10);
    }
    for (const selector of ['[data-action="new"]', '[data-action="delete"]', ".chat-message summary", ".chat-sources a"]) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds, selector).not.toBeNull();
      expect.soft(bounds!.width, `${width}px ${selector} width`).toBeGreaterThanOrEqual(44);
      expect.soft(bounds!.height, `${width}px ${selector} height`).toBeGreaterThanOrEqual(44);
      await page.locator(selector).click({ trial: true });
    }
    const actions = page.locator(".chat-message summary");
    await actions.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-message details")).toHaveAttribute("open", "");
    await expect(page.getByText("Read the synthetic Home article.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`saved-chat-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Home read", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator(".prose")).toBeVisible();
  }
  expect(chatRequests).toBe(0);
});

test("keyboard users can skip navigation and identify the active view", async ({
  page,
}) => {
  await page.goto("/?overview=1");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(primary.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/");
  await expect(primary.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await primary.getByRole("link", { name: "Search" }).click();
  await expect(primary.getByRole("link", { name: "Search" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page).toHaveTitle("Search · Secondbrain");
  await expect(
    page.getByRole("status").filter({ hasText: "Search view loaded." }),
  ).toHaveCount(1);

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const brand = page.locator("a.brand");
    const visibleLabel = (await brand.innerText()).replace("✳", "").replace(/\s+/g, " ").trim();
    const escapedLabel = visibleLabel.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
    await expect(brand).toHaveAccessibleName(new RegExp("^" + escapedLabel, "i"));
    await expect(brand).toHaveAttribute("href", "/");
    await brand.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
  }

});

test(
  "editor rerenders restore useful keyboard focus",
  async ({ page, request }) => {
    const fixture = await create(request, "# Keyboard editor\nOriginal.");
    await page.goto(`/wiki/${fixture.id}`);
    const edit = page.getByRole("button", { name: "Edit page" });
    await edit.focus();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    await expect(editor).toBeFocused();
    await editor.fill("# Keyboard editor\nUnsaved keyboard draft.");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("button", { name: "Edit page" }),
    ).toBeFocused();
  },
);

test("search finds a unique real page and opens its direct route", async ({
  page,
  request,
}) => {
  const term = `search-${randomUUID()}`;
  const fixture = await create(request, `# Search fixture\n${term}`);
  await page.goto("/search");
  await page.getByRole("textbox", { name: "Search pages" }).fill(term);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: /Search fixture/ }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await expect(page.locator(".prose")).toContainText(term);
});

async function observeSearchBodyCompletion(page: Page) {
  // Observe body completion after the UI promise chain, without changing response data.
  await page.addInitScript(() => {
    const parse = Response.prototype.json;
    (window as any).__settledSearchBodies = 0;
    Response.prototype.json = async function () {
      const body = await parse.call(this);
      if (this.url && new URL(this.url).pathname === "/api/wiki/search") {
        setTimeout(() => { (window as any).__settledSearchBodies++; }, 0);
      }
      return body;
    };
  });
}

for (const older of ["failure", "success"] as const) {
  test(`latest submitted search survives an older ${older}`, async ({ page, request }, testInfo) => {
    await observeSearchBodyCompletion(page);
    const firstTerm = `queued-${randomUUID()}`;
    const secondTerm = `current-${randomUUID()}`;
    const first = await create(request, `# Earlier search fixture\n${firstTerm}`);
    const second = await create(request, `# Current search fixture\n${secondTerm}`);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let captured!: () => void;
    const arrived = new Promise<void>(resolve => { captured = resolve; });
    let firstRequest = true;
    await page.route("**/api/wiki/search?**", async route => {
      if (new URL(route.request().url()).searchParams.get("q") !== firstTerm || !firstRequest) {
        await route.continue();
        return;
      }
      firstRequest = false;
      const response = await route.fetch(); // Capture the actual older service snapshot.
      expect((await response.json()).results[0].id).toBe(first.id);
      captured();
      await gate;
      if (older === "failure") {
        // Explicit transport/UI failure injection, not an observed backend outage.
        await route.fulfill({ status: 503, json: { message: "Delayed synthetic search outage." } });
      } else await route.fulfill({ response });
    });
    const submit = async (query: string) => {
      await page.getByRole("textbox", { name: "Search pages" }).fill(query);
      await page.getByRole("button", { name: "Search", exact: false }).click();
    };
    try {
      await page.goto("/search");
      await submit(firstTerm);
      await arrived;
      if (older === "success") {
        await update(request, first.id, `# Updated search fixture\n${firstTerm}`, first.revision);
      }
      await submit(secondTerm);
      await expect(page.locator(`#results a[href="/wiki/${second.id}"]`)).toBeVisible();
      if (older === "success") {
        // A -> B -> A has the same input value but a newer content snapshot.
        await submit(firstTerm);
        await expect(page.locator("#results .card h3")).toHaveText("Updated search fixture");
      }
      release();
      await page.waitForFunction(count => (window as any).__settledSearchBodies === count, older === "success" ? 3 : 2);
      await expect(page.locator("#results .card h3")).toHaveText(older === "success" ? "Updated search fixture" : "Current search fixture");
      await expect(page.locator("#results .error")).toHaveCount(0);
      await expect(page.locator("#search-status")).toHaveText(`1 result for “${older === "success" ? firstTerm : secondTerm}”.`);
      await expect(page.locator("#results")).toHaveAttribute("aria-busy", "false");
      await expect(page).toHaveURL(new RegExp(`/search\\?q=${older === "success" ? firstTerm : secondTerm}$`));
      if (older === "failure") {
        let unavailable = true;
        await page.route(`**/api/wiki/search?q=${secondTerm}`, async route => {
          if (unavailable) {
            unavailable = false;
            await route.fulfill({ status: 503, json: { message: "Current synthetic search outage." } });
          } else await route.continue();
        });
        await submit(secondTerm);
        await expect(page.locator("#results .error")).toHaveText("Current synthetic search outage.");
        await submit(secondTerm);
        await expect(page.locator("#results .card h3")).toHaveText("Current search fixture");
        await expect(page.locator("#results .error")).toHaveCount(0);
      }
      if (older === "success") {
        await page.screenshot({ path: testInfo.outputPath("search-latest-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: testInfo.outputPath("search-latest-mobile.png"), fullPage: true });
      }
      const target = older === "success" ? first.id : second.id;
      await page.locator(`#results a[href="/wiki/${target}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${target}$`));
    } finally {
      release();
    }
  });
}

test("submitted search finishes while the next query remains an unsubmitted draft", async ({ page, request }) => {
  await observeSearchBodyCompletion(page);
  const term = `submitted-${randomUUID()}`;
  const fixture = await create(request, `# Submitted search fixture\n${term}`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const arrived = new Promise<void>(resolve => { captured = resolve; });
  let searches = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/wiki/search") searches++;
  });
  await page.route(`**/api/wiki/search?q=${term}`, async route => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/search");
    const input = page.getByRole("textbox", { name: "Search pages" });
    await input.fill(term);
    await page.getByRole("button", { name: "Search" }).click();
    await arrived;
    await input.fill("Unsubmitted next query");
    release();
    await page.waitForFunction(() => (window as any).__settledSearchBodies === 1);
    await expect(page.locator("#results .card h3")).toHaveText("Submitted search fixture");
    await expect(input).toHaveValue("Unsubmitted next query");
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${term}$`));
    expect(searches).toBe(1);
    await page.locator(`#results a[href="/wiki/${fixture.id}"]`).click();
    await expect(page.locator("article h1")).toHaveText("Submitted search fixture");
  } finally {
    release();
  }
});

test("editor saves Markdown and reads current delivery status", async ({
  page,
  request,
}) => {
  const fixture = await create(request, "# Editable fixture\nBefore.");
  await page.goto(`/wiki/${fixture.id}`);
  await page.getByRole("button", { name: "Edit page" }).click();
  await page
    .getByRole("textbox", { name: /Markdown/ })
    .fill("# Editable fixture\nAfter the edit.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toContainText("Saved");
  await expect(page.locator("article h1")).toBeFocused();
  const deliveryStatus = await request.get("/api/wiki/delivery-status");
  const configured = (await deliveryStatus.json()).remote.state !== "not_configured";
  await expect(page.locator(".delivery-notice")).toContainText(
    configured ? "Remote delivery: current (cached acknowledgement)" : "Remote delivery: not configured",
    { timeout: 15000 },
  );
  await expect(page.locator(".prose")).toContainText("After the edit.");
  const saved = await (
    await request.get(`/api/wiki/pages/${fixture.id}`)
  ).json();
  expect(saved.revision).not.toBe(fixture.revision);
  expect(saved.markdown).toContain("After the edit.");
  await page.reload();
  await expect(page.locator(".prose")).toContainText("After the edit.");
});

test("a stalled save body times out after successful headers and replays the real receipt", async ({ page, request }, testInfo) => {
  const started = process.hrtime.bigint();
  const checkpoint = (phase: string) => console.info("[save-body-phase] " + JSON.stringify({
    phase, elapsed_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
  }));
  checkpoint("test entered after fixture setup");
  const fixture = await create(request, "# Save body fixture\nBefore.");
  checkpoint("fixture page created");
  const proxy = await pwaUpdateProxy();
  checkpoint("owned proxy listening");
  let gate: ReturnType<typeof proxy.holdNextSave> | undefined;
  let phase = "opening the proxied article";
  try {
    await page.goto(`${proxy.origin}/wiki/${fixture.id}`);
    await expect(page.locator("article h1")).toHaveText("Save body fixture");
    await page.clock.install();
    await page.getByRole("button", { name: "Edit page" }).click();
    const draft = "# Save body fixture\nSynthetic change behind held body.";
    await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
    gate = proxy.holdNextSave(true);
    const headers = page.waitForResponse(response => response.request().method() === "POST" &&
      response.url().endsWith(`/api/wiki/pages/${fixture.id}`));
    phase = "waiting for the committed save to reach the body gate";
    checkpoint(phase);
    await page.getByRole("button", { name: "Save changes" }).click();
    let arrived = false;
    void gate.arrived.then(() => { arrived = true; });
    await test.step("Receive the committed save at the body gate", async () => {
      await expect.poll(() => arrived, { message: "The real save never reached the body-stall gate", timeout: 10_000 }).toBeTruthy();
    });
    phase = "waiting for successful headers before the held response body";
    checkpoint(phase);
    expect((await headers).status()).toBe(200); // Browser received real successful headers, not the body.
    const saved = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(saved.markdown).toBe(draft);
    phase = "advancing the body deadline and waiting for the recoverable error";
    checkpoint(phase);
    await page.clock.fastForward(30_001);
    checkpoint("browser clock advanced");
    await expect(page.locator(".notice")).toContainText("save response timed out");
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toBeEnabled();
    gate.release();
    phase = "replaying the identical real save receipt";
    checkpoint(phase);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".notice")).toContainText("Saved locally");
    const recovered = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(recovered.revision).toBe(saved.revision);
    const history = await (await request.get(`/api/wiki/pages/${fixture.id}/history`)).json();
    expect(history.history).toHaveLength(2);
    checkpoint("save and receipt assertions completed");
  } finally {
    // These synthetic checkpoints stay in browser.log when the runner can only
    // report a whole-test timeout, including a stall during proxy teardown.
    console.info(`[save-body] status=${testInfo.status}; last phase=${phase}; entering cleanup`);
    checkpoint("entering cleanup; status is provisional until runner teardown ends");
    gate?.release();
    await test.step("Close the browser context before its owned body-stall proxy", async () => {
      // Page closure leaves context-owned workers/connections alive. Close the
      // whole owned context before waiting for the proxy's active connections.
      await page.context().close();
      checkpoint("owned browser context closed");
      await proxy.close();
      checkpoint("owned proxy closed");
    });
    console.info("[save-body] cleanup completed");
    checkpoint("test body returning; request and context fixtures still belong to runner");
  }
});

test("a timed-out search leaves a retryable error and accepts a fresh real response", async ({ page, request }) => {
  const term = `timeout${randomUUID().replace(/-/g, "")}`;
  const fixture = await create(request, `# Search timeout fixture\n${term}`);
  await page.goto("/search");
  await expect(page.getByRole("heading", { name: "Find a thought." })).toBeVisible();
  await page.clock.install();
  let searches = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const responseReady = new Promise<void>(resolve => { captured = resolve; });
  await page.route("**/api/wiki/search?**", async route => {
    if (++searches > 1) { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole("textbox", { name: "Search pages" }).fill(term);
    await page.getByRole("button", { name: "Search" }).click();
    await responseReady;
    await page.clock.fastForward(30_001);
    await expect(page.locator("#results .error")).toContainText("Request timed out");
    await expect(page.getByRole("textbox", { name: "Search pages" })).toHaveValue(term);
    release();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator(`#results a[href="/wiki/${fixture.id}"]`)).toBeVisible();
    await expect(page.locator("#results .error")).toHaveCount(0);
    expect(searches).toBe(2);
  } finally { release(); }
});

test("chat has a longer bounded response deadline and preserves a retryable question", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.locator("#chat-input")).toBeVisible();
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const responseReady = new Promise<void>(resolve => { captured = resolve; });
  let calls = 0;
  await page.route("**/api/wiki/chat", async route => {
    if (++calls > 1) { await route.continue(); return; }
    const response = await route.fetch(); // Real unconfigured-provider error, never a fake answer.
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.locator("#chat-input").fill("What can this synthetic wiki support?");
    await page.getByRole("button", { name: "Send", exact: false }).click();
    await responseReady;
    await page.clock.fastForward(30_001);
    await expect(page.locator("#chat-input")).toBeDisabled();
    await expect(page.locator(".chat-error")).toHaveCount(0);
    await page.clock.fastForward(90_000);
    await expect(page.locator(".chat-error")).toContainText("Request timed out");
    await expect(page.locator("#chat-input")).toBeEnabled();
    await expect(page.locator(".chat-message.user")).toContainText("What can this synthetic wiki support?");
    await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
    release();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".chat-error")).toContainText("not configured");
    expect(calls).toBe(2);
    await expect(page.locator(".chat-message.user")).toHaveCount(1);
  } finally { release(); }
});

test("concurrent revision conflict preserves the editor draft", async ({
  page,
  request,
}) => {
  const fixture = await create(request, "# Conflict fixture\nInitial.");
  await page.goto(`/wiki/${fixture.id}`);
  await page.getByRole("button", { name: "Edit page" }).click();
  const editor = page.getByRole("textbox", { name: /Markdown/ });
  await editor.fill("# Conflict fixture\nMy unsaved draft.");
  await update(
    request,
    fixture.id,
    "# Conflict fixture\nAnother writer.",
    fixture.revision,
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toContainText("Conflict");
  await expect(editor).toHaveValue("# Conflict fixture\nMy unsaved draft.");
  await expect(editor).toBeFocused();
  const saved = await (
    await request.get(`/api/wiki/pages/${fixture.id}`)
  ).json();
  expect(saved.markdown).toContain("Another writer.");
});

test("start page persists, overview stays reachable, and deletion falls back", async ({
  page,
  request,
}) => {
  const fixture = await create(
    request,
    "# My starting point\nA unique synthetic page.",
  );
  await page.goto(`/wiki/${fixture.id}`);
  await page.getByRole("button", { name: "Set as start page" }).click();
  await expect(page.locator(".notice")).toHaveText("This is now your start page.");
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await page.reload();
  await expect(page.locator("article h1")).toHaveText("My starting point");
  await page.getByRole("link", { name: "All pages" }).click();
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  const removed = await request.delete(`/api/wiki/pages/${fixture.id}`, {
    data: { base_revision: fixture.revision, request_id: randomUUID() },
  });
  expect(removed.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page).toHaveURL(/\/wiki\/home$/);
  await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
  await expect(page.locator(".notice")).toContainText("no longer exists");
  expect(await page.evaluate(async () => {
    const modulePath = "/src/start-preference.ts";
    const module = await import(modulePath);
    return module.readStartPage();
  })).toBe(fixture.id);

});

test("safe renderer strips active HTML and resolves wikilinks only outside code", async ({
  page,
  request,
}) => {
  const target = await create(
    request,
    "# Safe target\nSynthetic link destination.",
  );
  const fixture = await create(
    request,
    `# Renderer fixture\n\n[[${target.id}|Alias destination]]\n\n\`[[inline-code]]\`\n\n\`\`\`md\n[[fenced-code]]\n\`\`\`\n\n<script>window.__wikiXss=1</script>\n<img src="data:image/svg+xml,bad" onerror="window.__wikiXss=2" alt="unsafe">\n<a href="javascript:window.__wikiXss=3">unsafe link</a>`,
  );
  await page.goto(`/wiki/${fixture.id}`);
  await expect(
    page.getByRole("link", { name: "Alias destination" }),
  ).toHaveAttribute("href", `/wiki/${target.id}`);
  await expect(page.locator(".prose code")).toContainText([
    "[[inline-code]]",
    "[[fenced-code]]",
  ]);
  await expect(page.locator('.prose a[href^="/wiki/"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__wikiXss)).toBeUndefined();
  expect(
    await page
      .locator(".prose")
      .evaluate((el) =>
        [...el.querySelectorAll("*")].every((node) =>
          [...node.attributes].every((attr) => !/^on/i.test(attr.name)),
        ),
      ),
  ).toBeTruthy();
  await expect(page.locator(".prose script")).toHaveCount(0);
  await expect(page.locator(".prose img")).not.toHaveAttribute("src");
});


test("mobile direct page and missing link state remain readable", async ({
  page,
  request,
}) => {
  const fixture = await create(
    request,
    "# Mobile fixture\n[[missing-e2e-page|A missing thought]]",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wiki/${fixture.id}`);
  await expect(page.locator("article h1")).toHaveText("Mobile fixture");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await expect(page.locator(".missing-link")).toHaveText("A missing thought");
  await expect(page.locator(".missing-link")).not.toHaveAttribute("href");
  await page.goto("/wiki/missing-e2e-page");
  await expect(page.getByRole("heading", { name: "This page is missing." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/wiki\/home$/);
  await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
  await expect(page.locator("article h1")).toBeFocused();
  await page.getByRole("link", { name: "All pages" }).click();
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
});

test("retrying an unavailable article retains its URL, fragment and visit", async ({ page, request }, info) => {
  const fixture = await create(request, "# Recovery fixture\n\n## Evidence\n\nA synthetic recoverable article.");
  await page.setViewportSize({ width: 390, height: 844 });
  // A one-shot transport abort; recovery reads the actual unchanged service.
  await page.route(`**/api/wiki/pages/${fixture.id}`, route => route.abort("failed"), { times: 1 });
  await page.goto(`/wiki/${fixture.id}?context=reading#section-1`);
  await expect(page.getByRole("heading", { name: "Couldn’t open the workspace." })).toBeVisible();
  await expect(page.locator("main")).toContainText("Check your connection and try again.");
  await page.screenshot({ path: info.outputPath("article-network-recovery-390.png"), fullPage: true });
  const failedUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Try again" }).press("Enter");
  await expect(page.locator("article h1")).toHaveText("Recovery fixture");
  await expect(page.locator(".prose")).toContainText("A synthetic recoverable article.");
  await expect(page.locator("#section-1")).toBeFocused();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveClass("active");
  await expect(page.getByRole("link", { name: "Home", exact: true })).not.toHaveAttribute("aria-current", "page");
  expect(page.url()).toBe(failedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const direction of ["back", "forward"] as const) {
  test(`rejecting browser ${direction} preserves the complete article history`, async ({ page, request }) => {
    const last = await create(request, "# Last history article\nSynthetic final destination.");
    const middle = await create(request, `# Middle history article\nOriginal.\n\n[[${last.id}|Next article]]`);
    const first = await create(request, `# First history article\n[[${middle.id}|Next article]]`);
    await page.goto(`/wiki/${first.id}`);
    await page.getByRole("link", { name: "Next article", exact: true }).click();
    await expect(page.locator("article h1")).toHaveText("Middle history article");
    await page.getByRole("link", { name: "Next article", exact: true }).click();
    await expect(page.locator("article h1")).toHaveText("Last history article");
    await page.goBack();
    await expect(page.locator("article h1")).toHaveText("Middle history article");
    const length = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "Edit page" }).click();
    const draft = "# Middle history article\nUnsaved synthetic draft.";
    await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
    const dialog = page.waitForEvent("dialog");
    await page.evaluate(direction => history[direction](), direction);
    await (await dialog).dismiss();
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
    expect(await page.evaluate(() => history.length)).toBe(length);
    const discard = page.waitForEvent("dialog");
    const click = page.getByRole("button", { name: "Cancel", exact: true }).click();
    await (await discard).accept();
    await click;
    await expect(page.getByRole("button", { name: "Edit page" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/wiki/${first.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${last.id}$`));
    await expect(page.locator("article h1")).toHaveText("Last history article");
    expect(await page.evaluate(() => history.length)).toBe(length);
  });
}

test("blocked traversal preserves history while a real save acknowledgement is pending", async ({ page, request }, testInfo) => {
  const last = await create(request, "# Save history last\nSynthetic destination.");
  const middle = await create(request, `# Save history middle\nOriginal.\n\n[[${last.id}|Next article]]`);
  const first = await create(request, `# Save history first\n[[${middle.id}|Next article]]`);
  await page.goto(`/wiki/${first.id}`);
  await page.getByRole("link", { name: "Next article", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Save history middle");
  await page.getByRole("link", { name: "Next article", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Save history last");
  await page.goBack();
  await expect(page.locator("article h1")).toHaveText("Save history middle");
  const length = await page.evaluate(() => history.length);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const published = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/wiki/pages/${middle.id}`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "Edit page" }).click();
    await page.getByRole("textbox", { name: /Markdown/ }).fill("# Save history middle\nSaved synthetic content.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await published;
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    expect(await page.evaluate(() => history.length)).toBe(length);
    const pendingEditor = page.getByRole("textbox", { name: /Markdown/ });
    await expect(pendingEditor).not.toBeEditable();
    await pendingEditor.press("ControlOrMeta+End");
    await pendingEditor.press("x");
    await expect(pendingEditor).toHaveValue("# Save history middle\nSaved synthetic content.");
    await page.screenshot({ path: testInfo.outputPath("history-pending-save-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("history-pending-save-mobile.png"), fullPage: true });
    release();
    await expect(page.locator(".notice")).toContainText("Saved locally");
    await expect(page.locator("article h1")).toHaveText("Save history middle");
    await expect(page.locator(".prose")).toContainText("Saved synthetic content.");
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/wiki/${first.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    await expect(page.locator(".prose")).toContainText("Saved synthetic content.");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${last.id}$`));
    expect(await page.evaluate(() => history.length)).toBe(length);
  } finally { release(); }
});

test("bare fragment links keep tracked history and preserve an editor during traversal", async ({ page, request }) => {
  const fixture = await create(request, "# Fragment history\n[Jump to notes](#Notes)\n\n## Notes\nSynthetic notes.");
  await page.goto(`/wiki/${fixture.id}`);
  const length = await page.evaluate(() => history.length);
  await page.getByRole("link", { name: "Jump to notes", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}#Notes$`));
  await expect(page.locator("#section-1")).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.getByRole("link", { name: "Jump to notes", exact: true }).click();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.getByRole("button", { name: "Edit page" }).click();
  const draft = "# Fragment history\nUnsaved synthetic notes.";
  await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}#Notes$`));
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
});

test("canceling browser back keeps the unsaved editor draft and URL", async ({
  page,
  request,
}) => {
  const fixture = await create(request, "# Back navigation fixture\nOriginal.");
  await page.goto("/?overview=1");
  await page.locator(`a[href="/wiki/${fixture.id}"]`).click();
  await page.getByRole("button", { name: "Edit page" }).click();
  await page
    .getByRole("textbox", { name: /Markdown/ })
    .fill("# Back navigation fixture\nKeep this draft.");
  const dialogPromise = page.waitForEvent("dialog");
  await page.evaluate(() => history.back());
  await (await dialogPromise).dismiss();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(
    "# Back navigation fixture\nKeep this draft.",
  );
});

for (const width of [390, 1440]) {
  for (const traversal of ["rapid double Back", "Back during correction", "double Back then Forward", "jump Back two entries"] as const) {
    test(`canceled ${traversal} preserves every native history entry (${width})`, async ({ page, request }, info) => {
      const owned: { id: string; revision: string }[] = [];
      let dismissed = 0;
      const dismiss = async (dialog: import("@playwright/test").Dialog) => { dismissed++; await dialog.dismiss(); };
      try {
        await page.setViewportSize({ width, height: 844 });
        const c = await create(request, "# Native history C\nSynthetic final article."); owned.push(c);
        const b = await create(request, `# Native history B\n[[${c.id}|Next history article]]`); owned.push(b);
        const a = await create(request, `# Native history A\n[[${b.id}|Next history article]]`); owned.push(a);
        await page.goto("/?overview=1");
        const snapshot = () => page.evaluate(() => ({ url: location.pathname + location.search + location.hash, state: history.state, length: history.length }));
        const home = await snapshot();
        await page.locator(`a[href="/wiki/${a.id}"]`).click();
        await expect(page.locator("article h1")).toHaveText("Native history A"); const visitA = await snapshot();
        await page.getByRole("link", { name: "Next history article", exact: true }).click();
        await expect(page.locator("article h1")).toHaveText("Native history B"); const visitB = await snapshot();
        await page.getByRole("link", { name: "Next history article", exact: true }).click();
        await expect(page.locator("article h1")).toHaveText("Native history C"); const visitC = await snapshot();
        await page.getByRole("button", { name: "Edit page" }).click();
        const draft = "# Native history C\nKeep this exact unsaved draft.";
        await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
        page.on("dialog", dismiss);
        // Exercise native browser traversal queues without replacing History methods.
        await page.evaluate(mode => {
          if (mode === "Back during correction") {
            // Registered after the app listener, so the first cancellation
            // has already requested recovery when this listener runs.
            addEventListener("popstate", () => history.back(), { once: true }); history.back();
          } else if (mode === "jump Back two entries") history.go(-2);
          else { history.back(); history.back(); if (mode === "double Back then Forward") history.forward(); }
        }, traversal);
        await expect.poll(() => dismissed).toBeGreaterThan(0);
        await expect.poll(snapshot).toEqual(visitC);
        await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
        // A one-second fallback must not replace a prior entry while making
        // only the URL appear recovered. Retain the original visit identity.
        await page.waitForTimeout(1250);
        expect(await snapshot()).toEqual(visitC);
        await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
        if (traversal === "rapid double Back") await page.screenshot({ path: info.outputPath(`native-history-draft-${width}.png`) });
        page.off("dialog", dismiss); page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(page.locator("#editor")).toHaveCount(0);
        await expect(page.locator("article h1")).toHaveText("Native history C");
        for (const visit of [visitB, visitA, home]) {
          await page.goBack(); await expect.poll(snapshot).toEqual({ ...visit, length: visitC.length });
          if (visit === home) await expect(page.locator(`a[href="/wiki/${a.id}"]`)).toBeVisible();
          else await expect(page.locator("article h1")).toBeVisible();
        }
        for (const visit of [visitA, visitB, visitC]) {
          await page.goForward(); await expect.poll(snapshot).toEqual({ ...visit, length: visitC.length });
          await expect(page.locator("article h1")).toBeVisible();
        }
        await expect(page.locator("article h1")).toHaveText("Native history C");
        await expect(page.locator(".prose")).toHaveText("Synthetic final article.");
      } finally {
        page.off("dialog", dismiss);
        for (const item of owned.reverse()) {
          const response = await request.delete(`/api/wiki/pages/${item.id}`, { data: { base_revision: item.revision, request_id: randomUUID() } });
          expect(response.ok(), "native history fixture cleanup").toBe(true);
        }
      }
    });
  }
}

test("real demo table stays readable and keyboard-scrollable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/wiki/night-sky-survey");
  const region = page.getByRole("region", {
    name: "Table; scroll horizontally to read all columns",
  });
  await expect(region).toBeVisible();
  const session = region.getByRole("columnheader", {
    name: "Session",
    exact: true,
  });
  await expect(session).toBeVisible();
  const geometry = await region.evaluate((el) => ({
    width: el.clientWidth,
    content: el.scrollWidth,
  }));
  expect(geometry.content).toBeGreaterThan(geometry.width);
  expect(
    await session.evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(120);
  expect(
    await session.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    }),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await region.focus();
  await expect(region).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => region.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect
    .poll(() => region.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBeTruthy();
});

test("article contents links focus unique sections and history preserves an editor draft", async ({ page, request }) => {
  const fixture = await create(request, "# Synthetic article\n\n## First section\n\nA short note.\n\n### Detail\n\nMore notes.\n\n## First section\n\nAnother note.\n");
  await page.goto(`/wiki/${fixture.id}`);
  const contents = page.getByRole("navigation", { name: "On this page" });
  await expect(contents.getByRole("link")).toHaveCount(3);
  await contents.getByRole("link", { name: "First section", exact: true }).last().click();
  await expect(page.locator("#section-3")).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(contents).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Edit page" }).click();
  const editor = page.locator("#editor");
  await editor.fill("# Synthetic article\n\nUnsaved synthetic draft.");
  await page.getByText("Local Git history", { exact: true }).click();
  await expect(page.locator(".history-list li")).toHaveCount(1);
  const historyResponse = await request.get(`/api/wiki/pages/${fixture.id}/history`);
  const historyData = await historyResponse.json();
  await expect(page.locator(".history-list code")).toHaveText(historyData.history[0].commit.slice(0, 8));
  await expect(editor).toHaveValue("# Synthetic article\n\nUnsaved synthetic draft.");
});

test("history errors can be retried without leaving the page", async ({ page, request }) => {
  const fixture = await create(request, "# Synthetic history\n\nNo sections here.");
  let attempts = 0;
  await page.route(`**/api/wiki/pages/${fixture.id}/history`, async route => {
    if (++attempts === 1) await route.fulfill({ status: 503, json: { message: "History temporarily unavailable." } });
    else await route.continue();
  });
  await page.goto(`/wiki/${fixture.id}`);
  await expect(page.getByRole("navigation", { name: "On this page" })).toHaveCount(0);
  const history = page.getByText("Local Git history", { exact: true });
  await history.click();
  await expect(page.locator(".history-content")).toContainText("Close and reopen history to retry.");
  await history.click();
  await history.click();
  await expect(page.locator(".history-list li")).toHaveCount(1);
});

test("title links resolve IDs, preserve sections and show missing targets", async ({ page, request }) => {
  const title = `Reference ${randomUUID()}`;
  const target = await create(request, `# ${title}\n\n## Fine detail\n\nA synthetic reference.`);
  const source = await create(request, `# Link source\n\n[[${title}#Fine detail|Title reference]] and [[${target.id}|Stable reference]]. [[nonexistent-${randomUUID()}|Missing reference]].\n\n## Local detail\n\n[[#Local detail|Within this article]]`);
  await page.goto(`/wiki/${source.id}`);
  const titleLink = page.getByRole("link", { name: "Title reference", exact: true });
  await expect(titleLink).toHaveAttribute("href", new RegExp(`/wiki/${target.id}#Fine%20detail$`));
  await expect(page.locator(".missing-link")).toHaveText("Missing reference");
  await expect(page.locator(".missing-link")).not.toHaveAttribute("href");
  await page.getByRole("link", { name: "Within this article", exact: true }).click();
  await expect(page.locator("#section-1")).toBeFocused();
  await titleLink.click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${target.id}#Fine%20detail$`));
  await expect(page.locator("#section-1")).toBeFocused();
  await page.reload();
  await expect(page.locator("#section-1")).toBeFocused();
  await page.goBack();
  await expect(page.getByRole("link", { name: "Stable reference", exact: true })).toBeVisible();
});

test("nested-list wikilinks stay aligned between the article and graph", async ({
  page,
  request,
}) => {
  const target = await create(request, "# Nested target\n\nA synthetic destination.");
  const source = await create(
    request,
    `# Nested source\n\n- References\n    - [[${target.id}|Nested target]]`,
  );

  await page.goto(`/wiki/${source.id}`);
  await expect(
    page.getByRole("link", { name: "Nested target", exact: true }),
  ).toHaveAttribute("href", `/wiki/${target.id}`);

  const graph = await (await request.get("/api/wiki/graph")).json();
  expect(graph.edges).toContainEqual({
    source: source.id,
    target: target.id,
    type: "wikilink",
  });
});

test("ambiguous titles offer explicit choices and refresh after deletion", async ({ page, request }) => {
  const title = `Duplicate ${randomUUID()}`;
  const a = await create(request, `# ${title}\n\n## Details\n\nFirst synthetic candidate.`);
  const b = await create(request, `# ${title}\n\n## Details\n\nSecond synthetic candidate.`);
  const source = await create(request, `# Ambiguous source\n\n[[${title}#Details|Shared reference]]`);
  await page.goto(`/wiki/${source.id}`);
  const link = page.getByRole("link", { name: "Shared reference", exact: true });
  await expect(link).toHaveClass(/ambiguous-link/);
  await link.click();
  await expect(page.getByRole("heading", { name: "Choose a page." })).toBeVisible();
  const choices = page.locator(".card");
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toHaveAttribute("href", /#Details$/);
  await choices.filter({ hasText: title }).first().click();
  await expect(page.locator("#section-1")).toBeFocused();
  const response = await request.delete(`/api/wiki/pages/${a.id}`, { data: {
    base_revision: a.revision, request_id: randomUUID(),
  }});
  expect(response.ok()).toBeTruthy();
  await page.goto(`/wiki/${source.id}`);
  await expect(page.getByRole("link", { name: "Shared reference", exact: true })).toHaveAttribute("href", `/wiki/${b.id}#Details`);
});

test("late real page response cannot replace a newer article or edit target", async ({ page, request }) => {
  const a = await create(request, `# Delayed article ${randomUUID()}\nOld route.`);
  const title = `Current article ${randomUUID()}`;
  const b = await create(request, `# ${title}\nCurrent route.`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/wiki/pages/${a.id}`, async route => { await gate; await route.continue(); });
  await page.goto(`/wiki/${a.id}`);
  await openAllPages(page);
  await page.locator(".card").filter({ hasText: title }).click();
  await expect(page.locator("article h1")).toHaveText(title);
  const staleResponse = page.waitForResponse(response => response.url().endsWith(`/api/wiki/pages/${a.id}`));
  release();
  await staleResponse;
  await page.getByRole("button", { name: "Edit page" }).click();
  await expect(page.locator("#editor")).toHaveValue(b.markdown);
});

test("galaxy snapshot refresh reflects real save, link and delete operations", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const title = `New star ${randomUUID()}`;
  await page.goto("/galaxy");
  const previous = await page.locator(".galaxy-revision").innerText();
  const target = await create(request, `# ${title}\n\nAn isolated synthetic star.`);
  const source = await create(request, `# Star source ${randomUUID()}\n\n[[${target.id}]]`);
  await expect(page.locator(".galaxy-revision")).toHaveText(previous);
  await page.getByRole("link", { name: "Refresh snapshot" }).click();
  await expect(page.locator(".galaxy-revision")).not.toHaveText(previous);
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(target.id);
  await page.locator(".galaxy-page").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
  await expect(page.locator(".galaxy-evidence")).toContainText("Explicit wikilink");
  const response = await request.delete(`/api/wiki/pages/${target.id}`, { data: {
    base_revision: target.revision, request_id: randomUUID(),
  }});
  expect(response.ok()).toBeTruthy();
  await page.getByRole("link", { name: "Refresh snapshot" }).click();
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(target.id);
  await expect(page.locator(".galaxy-sidebar-content")).toContainText("No title or page ID matches.");
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(source.id);
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-problems")).toContainText(target.id);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".galaxy-stage")).toBeHidden();
});

test("demo frontmatter curates named constellations but stays out of article prose", async ({ page }) => {
  await page.goto("/wiki/night-sky-survey");
  await expect(page.locator(".prose")).not.toContainText("galaxy_group");
  await page.getByRole("button", { name: "Edit page" }).click();
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(/galaxy_group: sky-navigation/);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/galaxy");
  await expect(page.getByRole("heading", { name: "Choose a constellation" })).toBeVisible();
  const groups = page.locator(".galaxy-cluster");
  await expect(groups.filter({ hasText: "curated" })).toHaveCount(4);
  const sky = groups.filter({ hasText: "Sky & navigation" });
  await expect(sky).toContainText("3 pages · curated");
  await sky.click();
  await expect(page.locator(".galaxy-sidebar-content")).toContainText(
    "Curated in Markdown frontmatter",
  );
  await expect(page.locator(".galaxy-sidebar-content .galaxy-page")).toHaveCount(3);
});

test("large synthetic graph opens a usable list without constructing SVG", async ({ page }) => {
  const nodes = Array.from({ length: 251 }, (_, index) => ({
    id: `scale-${String(index).padStart(3, "0")}`,
    title: `Scale page ${index}`,
  }));
  await page.route("**/api/wiki/graph", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      nodes,
      edges: [],
      revision: "synthetic-scale-fixture",
      status: "current",
      missing_targets: [],
      ambiguous_targets: [],
    }),
  }));
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-scale-note")).toContainText("Large snapshot");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await expect(page.locator(".galaxy-stage svg")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("Scale page 250");
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Scale page 250");
});

for (const width of [1440, 390]) {
  test(`stopping a chat reply aborts transport and retains a retryable question (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    let release!: () => void;
    let reached!: () => void;
    let finished!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { reached = resolve; });
    const delivered = new Promise<void>(resolve => { finished = resolve; });
    let calls = 0;
    const question = "Synthetic cancellation question.";
    const lateAnswer = "Synthetic answer from the stopped request.";
    await page.route("**/api/wiki/chat", async route => {
      if (++calls === 1) {
        reached();
        await gate;
        await route.fulfill({ json: { answer: lateAnswer, sources: [], activity: [] } });
        finished();
      } else await route.fulfill({ json: { answer: "Synthetic retry answer.", sources: [], activity: [] } });
    });
    try {
      await page.goto("/chat");
      await page.getByLabel("Message").fill(question);
      await page.getByRole("button", { name: "Send" }).click();
      await held;
      const stop = page.getByRole("button", { name: "Stop reply", exact: true });
      await stop.scrollIntoViewIfNeeded();
      await expect(stop).toBeVisible();
      expect((await stop.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath(`chat-stop-${width}.png`) });
      await stop.focus();
      const aborted = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/wiki/chat");
      await page.keyboard.press("Enter");
      await aborted;
      await expect(page.locator(".chat-error")).toContainText("Reply stopped. Your question is still here");
      await expect(page.locator(".chat-thinking")).toHaveCount(0);
      await expect(page.getByLabel("Message")).toBeEnabled();
      await expect(page.getByLabel("Message")).toBeFocused();
      release();
      await delivered;
      await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
      await expect(page.locator(".chat-message.user p")).toHaveText(question);
      expect(await page.evaluate(async () => JSON.stringify(await window.__wikiChatRead()))).not.toContain(lateAnswer);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic retry answer.");
      await expect(page.locator(".chat-message.user")).toHaveCount(1);
      await page.reload();
      await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic retry answer.");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally { release(); }
  });
}

test("leaving chat aborts an unfinished reply and does not revive it on return", async ({ page }) => {
  let reached!: () => void;
  let release!: () => void;
  let finished!: () => void;
  const held = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delivered = new Promise<void>(resolve => { finished = resolve; });
  await page.route("**/api/wiki/chat", async route => {
    reached();
    await gate;
    await route.fulfill({ json: { answer: "Synthetic obsolete answer.", sources: [], activity: [] } });
    finished();
  });
  try {
    await page.goto("/chat");
    await page.getByLabel("Message").fill("Synthetic navigation question.");
    await page.getByRole("button", { name: "Send" }).click();
    await held;
    const aborted = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/wiki/chat");
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await aborted;
    release();
    await delivered;
    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.locator(".chat-message.user")).toContainText("Synthetic navigation question.");
    await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  } finally { release(); }
});

test("demo tour preserves an unanswered real chat question across reload and navigation", async ({ page, request }, testInfo) => {
  // Use the actual unconfigured API in the isolated demo, without a scripted answer.
  const before = await (await request.get("/api/wiki/graph")).json();
  const calls: unknown[] = [];
  page.on("request", call => {
    if (new URL(call.url()).pathname === "/api/wiki/chat" && call.method() === "POST")
      calls.push(call.postDataJSON());
  });
  await page.goto("/wiki/home");
  await page.getByRole("button", { name: "Set as start page" }).click();
  await expect(page.locator(".notice")).toHaveText("This is now your start page.");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Lantern Bay field atlas", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Mira Quill", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/mira-quill$/);
  await expect(page.locator("article h1")).toContainText("fictional archivist");
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("Mira Quill");
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-selected-heading h2")).toContainText("Mira Quill");
  await page.getByRole("link", { name: /Open article/ }).click();
  await expect(page).toHaveURL(/\/wiki\/mira-quill$/);
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  const question = "What does Mira record when a recollection cannot establish a date?";
  await page.getByLabel("Message").fill(question);
  const first = page.waitForResponse(response => response.url().endsWith("/api/wiki/chat"));
  await page.getByRole("button", { name: "Send" }).click();
  expect((await first).status()).toBe(503);
  await expect(page.getByRole("alert")).toContainText("not configured");
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.locator(".chat-message.user")).toHaveText(/cannot establish a date/);
  expect(calls).toHaveLength(1); // Restoring a question never starts a paid call.
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.locator(".chat-history-list button").filter({ hasText: question.slice(0, 54) }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  const retry = page.waitForResponse(response => response.url().endsWith("/api/wiki/chat"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect((await retry).status()).toBe(503);
  expect(calls).toEqual([calls[0], calls[0]]);
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("not configured");
  await page.screenshot({ path: testInfo.outputPath("unanswered-chat-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const retryTarget = (await page.getByRole("button", { name: "Retry", exact: true }).boundingBox())!;
  expect(retryTarget.height).toBeGreaterThanOrEqual(44);
  expect(retryTarget.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("unanswered-chat-mobile.png"), fullPage: true });
  const after = await (await request.get("/api/wiki/graph")).json();
  expect(after.revision).toBe(before.revision);
});

test("read-only chat keeps multi-turn context and conversations in this browser", async ({ page }) => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  await page.route("**/api/wiki/chat", async route => {
    requests.push(route.request().postDataJSON());
    const followUp = requests.length > 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        answer: followUp
          ? "The follow-up connects the atlas to the night sky survey."
          : "The atlas begins at Lantern Bay.",
        activity: followUp ? ["Read “Night sky survey”."] : ["Read “Lantern Bay field atlas”."],
        sources: [
          followUp
            ? { id: "night-sky-survey", title: "Night sky survey", evidence: "read" }
            : { id: "home", title: "Lantern Bay field atlas", evidence: "read" },
        ],
        limits: { tool_calls: 1, max_tool_calls: 8 },
      }),
    });
  });

  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Ask, then follow the evidence." })).toBeVisible();
  await page.getByLabel("Message").fill("Where does the atlas begin?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Lantern Bay");
  await expect(page.getByLabel("Message")).toHaveValue("");
  await expect(page.locator(".chat-history-list button.active small")).toHaveText("2 messages");
  await expect(page.getByRole("link", { name: /Lantern Bay field atlas/ })).toBeVisible();

  await page.getByLabel("Message").fill("What does that connect to?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
  expect(requests[1].messages.map(message => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);

  await page.reload();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
});

for (const scenario of ["long-answer", "many-turns", "multibyte", "escaped-text"] as const) {
test(`chat bounds follow-up context without changing saved text (${scenario})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario === "multibyte" || scenario === "escaped-text" ? 390 : 1440, height: 900 });
  await page.goto("/?overview=1");
  await page.evaluate(async kind => {
    const text = kind === "multibyte" ? "界".repeat(3500)
      : kind === "escaped-text" ? "\u0001".repeat(3500) : "Synthetic context. ".repeat(190);
    const messages = kind === "long-answer"
      ? [{ role: "user", content: "A synthetic earlier question." },
         { role: "assistant", content: "Long synthetic reply. ".repeat(300) }]
      : Array.from({ length: kind === "many-turns" ? 6 : 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: text }));
    await window.__wikiChatWrite([{
      id: "synthetic-context", title: "Synthetic context probe", updated: 1, messages,
    }]);
  }, scenario);
  let captured: { role: string; content: string }[] = [];
  await page.route("**/api/wiki/chat", async route => {
    const body = route.request().postData()!;
    captured = JSON.parse(body).messages;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(25000);
    expect(captured.length).toBeLessThanOrEqual(12);
    expect(captured.every(message => message.content.length <= 4000)).toBeTruthy();
    expect(captured.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(20000);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      answer: "Synthetic bounded follow-up answer.", sources: [], activity: [],
    }) });
  });
  await page.goto("/chat");
  const before = await page.evaluate(async () => (await window.__wikiChatRead())[0].messages);
  await page.getByLabel("Message").fill("Keep this exact newest synthetic question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic bounded follow-up answer.");
  expect(captured.at(-1)).toEqual({ role: "user", content: "Keep this exact newest synthetic question." });
  expect(captured[0].role).toBe("user");
  await expect(page.locator(".chat-context-notice")).toContainText("saved messages are unchanged");
  const after = await page.evaluate(async () => (await window.__wikiChatRead())[0].messages);
  expect(after.slice(0, before.length)).toEqual(before);
  await page.locator(".chat-context-notice").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`chat-context-${scenario}.png`) });
  await page.reload();
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Synthetic bounded follow-up answer.");
});
}

test("chat preserves independent tab conversations and does not resurrect a deleted one", async ({ page, context }) => {
  const other = await context.newPage();
  for (const tab of [page, other]) {
    await tab.route("**/api/wiki/chat", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic tab answer.", sources: [], activity: [] }),
    }));
  }

  await page.goto("/chat");
  await other.goto("/chat");
  await page.getByLabel("Message").fill("Question from the first tab.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic tab answer.");
  await other.getByLabel("Message").fill("Question from the second tab.");
  await other.getByRole("button", { name: "Send" }).click();
  await expect(other.locator(".chat-message.assistant")).toContainText("Synthetic tab answer.");

  const storedQuestions = () => page.evaluate(async () =>
    (await window.__wikiChatRead())
      .flatMap((conversation: { messages: Array<{ role: string; content: string }> }) => conversation.messages)
      .filter((message: { role: string }) => message.role === "user")
      .map((message: { content: string }) => message.content),
  );
  await expect.poll(storedQuestions).toEqual([
    "Question from the second tab.",
    "Question from the first tab.",
  ]);

  await page.getByRole("button", { name: "Delete conversation" }).click();
  await other.getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(storedQuestions).toEqual(["Question from the second tab."]);
  await other.close();
});

for (const width of [1440, 390]) {
test(`chat deletion in another tab survives a follow-up and an in-flight answer (${width}px)`, async ({ page, context }, testInfo) => {
  await page.route("**/api/wiki/chat", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ answer: "Synthetic initial answer.", sources: [], activity: [] }) }));
  await page.goto("/chat");
  await page.getByLabel("Message").fill("Question to be deleted.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic initial answer.");
  const deletedId = await page.evaluate(async () => (await window.__wikiChatRead())[0].id);
  const stale = await context.newPage();
  await stale.setViewportSize({ width, height: 844 });
  let submitted: { messages: Array<{ role: string; content: string }> } | undefined;
  await stale.route("**/api/wiki/chat", route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic fresh answer.", sources: [], activity: [] }) });
  });
  await stale.goto("/chat");
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await stale.getByLabel("Message").fill("Follow-up after deletion.");
  await stale.getByRole("button", { name: "Send" }).click();
  await expect(stale.locator(".chat-message.assistant").last()).toContainText("Synthetic fresh answer.");
  expect(await page.evaluate(async id => (await window.__wikiChatRead()).some((item: { id: string }) => item.id === id), deletedId)).toBeFalsy();
  expect(submitted?.messages).toEqual([{ role: "user", content: "Follow-up after deletion." }]);
  await expect(stale.locator(".chat-conversation-notice")).toContainText("started a new conversation");
  expect(await stale.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await stale.screenshot({ path: testInfo.outputPath("chat-deleted-tab.png"), fullPage: true });

  await page.reload();
  await expect(page.locator(".chat-message.user")).toContainText("Follow-up after deletion.");
  const inFlightId = await page.evaluate(async () => (await window.__wikiChatRead())[0].id);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await stale.unroute("**/api/wiki/chat");
  await stale.route("**/api/wiki/chat", async route => {
    await hold;
    await route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic delayed answer.", sources: [], activity: [] }) });
  });
  const requested = stale.waitForRequest("**/api/wiki/chat");
  await stale.getByLabel("Message").fill("Question whose answer arrives after deletion.");
  await stale.getByRole("button", { name: "Send" }).click();
  await requested;
  await page.getByRole("button", { name: "Delete conversation" }).click();
  release();
  await expect(stale.locator(".chat-thinking")).toHaveCount(0);
  await expect(stale.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(stale.locator(".chat-conversation-notice")).toContainText("deleted in another tab");
  expect(await page.evaluate(async id => (await window.__wikiChatRead()).some((item: { id: string }) => item.id === id), inFlightId)).toBeFalsy();
  await expect(stale.getByLabel("Message")).toBeEnabled();
  await stale.close();
});
}

for (const failureAfterDeletion of [false, true]) {
test(`chat retry respects another tab's deletion (${failureAfterDeletion ? "late failure" : "earlier failure"})`, async ({ page, context }) => {
  let calls = 0;
  let arrived!: () => void;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/wiki/chat", async route => {
    calls++;
    arrived();
    if (failureAfterDeletion) await held;
    if (calls === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ error: "chat_unavailable", message: "Synthetic provider unavailable." }) });
    else await route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ answer: "This stale request should not be sent.", sources: [], activity: [] }) });
  });
  await page.goto("/chat");
  await page.getByLabel("Message").fill("Synthetic question deleted before retry.");
  await page.getByRole("button", { name: "Send" }).click();
  await requested;
  if (!failureAfterDeletion) await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/chat");
  await other.getByRole("button", { name: "Delete conversation" }).click();
  if (failureAfterDeletion) release();
  else await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(page.locator(".chat-conversation-notice")).toContainText("deleted in another tab");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message")).toBeEnabled();
  expect(calls).toBe(1); // A retry must not resend the deleted transcript.
  await other.close();
});
}

test("PWA metadata registers an online-only worker without private caches", async ({
  page,
  request,
  context,
  browser,
}) => {
  await page.addInitScript(() => {
    const key = "pwa-first-install-documents";
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || "0") + 1));
  });
  await page.goto("/?overview=1");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any maskable" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any maskable" }),
    ]),
  );

  if (browser.browserType().name() === "chromium") {
    const session = await context.newCDPSession(page);
    const appManifest = await session.send("Page.getAppManifest");
    expect(appManifest.errors).toEqual([]);
    const installability = await session.send("Page.getInstallabilityErrors");
    expect(installability.installabilityErrors).toEqual([]);
  }
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await new Promise<void>(resolve => {
      if (navigator.serviceWorker.controller) return resolve();
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
        once: true,
      });
    });
    return {
      scope: registration.scope,
      script: registration.active?.scriptURL,
      controlled: Boolean(navigator.serviceWorker.controller),
      caches: await caches.keys(),
    };
  });
  expect(worker.scope).toBe("http://127.0.0.1:5173/");
  expect(worker.script).toMatch(/\/service-worker\.js$/);
  expect(worker.caches).toEqual([]);
  expect(worker.controlled).toBe(true);
  console.info("[pwa-worker-ready] " + JSON.stringify(worker));
  expect(await page.evaluate(() => sessionStorage.getItem("pwa-first-install-documents"))).toBe("1");

  const serviceWorker = await (await request.get("/service-worker.js")).text();
  expect(serviceWorker).toContain("SKIP_WAITING");
  expect(serviceWorker).not.toContain('addEventListener("fetch"');
  expect(serviceWorker).not.toContain("caches.");

  await context.setOffline(true);
  await expect(page.locator('.pwa-notice[data-kind="offline"]')).toContainText(
    "wiki and chat need a connection",
  );
  await context.setOffline(false);
  console.info("[pwa-first-install-before-online-assert] " +
    JSON.stringify(await readFirstInstallTrace(page, "before-online-assert")));
  await expect(page.locator(".pwa-notice")).toBeHidden();
});

for (const width of [390, 1440]) {
  test(`PWA background update failures remain recoverable (${width})`, async ({ page, context }, info) => {
    const proxy = await pwaUpdateProxy();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.name));
    await page.setViewportSize({ width, height: 844 });
    try {
      await page.goto(`${proxy.origin}/?overview=1`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const nativeUpdate = ServiceWorkerRegistration.prototype.update;
        const probe = { armed: "", calls: [] as string[],
          outcomes: [] as { stage: string; status: string; name?: string }[], unhandled: [] as string[],
          restore: () => { ServiceWorkerRegistration.prototype.update = nativeUpdate; } };
        (window as unknown as { pwaUpdateProbe: typeof probe }).pwaUpdateProbe = probe;
        window.addEventListener("unhandledrejection", event => probe.unhandled.push(event.reason?.name || typeof event.reason));
        ServiceWorkerRegistration.prototype.update = function () {
          if (!probe.armed || this.scope !== registration.scope) return nativeUpdate.call(this);
          const stage = probe.armed;
          probe.armed = "";
          probe.calls.push(stage);
          // Observe the native operation and return its forwarding promise to
          // the app. A detached rethrowing branch would invent an extra error.
          return nativeUpdate.call(this).then(value => {
            probe.outcomes.push({ stage, status: "fulfilled" });
            return value;
          }, reason => {
            probe.outcomes.push({ stage, status: "rejected", name: reason?.name || typeof reason });
            throw reason;
          });
        };
      });
      const trigger = async (stage: string) => {
        expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
        await page.evaluate(stage => {
          const probe = (window as unknown as { pwaUpdateProbe: { armed: string } }).pwaUpdateProbe;
          probe.armed = stage;
          // Synthetic visibility event; actual browser registration.update().
          document.dispatchEvent(new Event("visibilitychange"));
        }, stage);
      };
      // A real HTTP 503 from the local server makes the native worker update
      // reject deterministically; offline emulation alone did not establish it.
      proxy.failNextWorkerUpdate();
      await trigger("failed-fetch");
      await page.waitForFunction(() => (window as unknown as { pwaUpdateProbe: { outcomes: { stage: string; status: string }[] } })
        .pwaUpdateProbe.outcomes.some(x => x.stage === "failed-fetch" && x.status === "rejected"));
      // Let native rejection notification pass a task boundary before checking
      // the app-owned promise, without awaiting or catching it in this test.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
      const offline = await page.evaluate(() => {
        const { calls, outcomes, unhandled } = (window as unknown as { pwaUpdateProbe: {
          calls: string[]; outcomes: { stage: string; status: string; name?: string }[]; unhandled: string[];
        } }).pwaUpdateProbe;
        return { calls, outcomes, unhandled };
      });
      expect(proxy.failedWorkerRequests()).toBe(1);
      console.info(`[pwa-update-failure] ${JSON.stringify({ width, ...offline, pageErrors, syntheticVisibility: true, scriptedWorker503: 1 })}`);
      expect.soft(offline.unhandled, "Native background update failure must be handled").toEqual([]);
      expect.soft(pageErrors, "Native background update failure must not reach pageerror").toEqual([]);
      await context.setOffline(true);
      await expect(page.locator('.pwa-notice[data-kind="offline"]')).toBeVisible();
      await page.screenshot({ path: info.outputPath(`pwa-update-offline-${width}.png`) });
      await context.setOffline(false);
      await expect(page.locator('.pwa-notice[data-kind="offline"]')).toHaveCount(0);
      await trigger("online");
      await page.waitForFunction(() => (window as unknown as { pwaUpdateProbe: { outcomes: { stage: string; status: string }[] } })
        .pwaUpdateProbe.outcomes.some(x => x.stage === "online" && x.status === "fulfilled"));
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true }).click();
      await page.getByRole("textbox", { name: "Search pages", exact: true }).fill("night sky");
      await page.getByRole("textbox", { name: "Search pages", exact: true }).press("Enter");
      await expect(page.locator("#results")).toContainText("Night sky survey");
      expect(await page.evaluate(() => (window as unknown as { pwaUpdateProbe: { unhandled: string[] } }).pwaUpdateProbe.unhandled)).toEqual(offline.unhandled);
      expect(pageErrors.length).toBe(offline.unhandled.length);
      await page.screenshot({ path: info.outputPath(`pwa-update-recovered-${width}.png`) });
      console.info(`[pwa-update-recovered] ${JSON.stringify({ width, nativeUpdateFulfilled: true, realSearch: true })}`);
    } finally {
      await context.setOffline(false).catch(() => {});
      if (!page.isClosed()) {
        await page.evaluate(() => (window as unknown as { pwaUpdateProbe?: { restore: () => void } }).pwaUpdateProbe?.restore()).catch(() => {});
        await page.close();
      }
      // Worker-owned connections can outlive their page. Dispose the owned
      // context before waiting for the local server to close.
      await context.close();
      await proxy.close();
      console.info(`[pwa-update-cleanup] ${JSON.stringify({ width, pageClosed: page.isClosed() })}`);
    }
  });
}

test("PWA offers and applies a waiting worker update", async ({ page, context }, info) => {
  const proxy = await pwaUpdateProxy();
  try {
    await page.goto(`${proxy.origin}/?overview=1`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    proxy.bump();
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    const update = page.locator('.pwa-notice[data-kind="update"]');
    await expect(update).toContainText("new version");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("worker-update-ready-390.png") });
    await Promise.all([
      page.waitForEvent("load"),
      update.getByRole("button", { name: "Update now" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".pwa-notice")).toBeHidden();
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
  } finally {
    // The context owns worker connections too; page closure alone can leave
    // the local proxy waiting until fixture teardown after the test timeout.
    await context.close();
    await proxy.close();
  }
});


async function offerPwaUpdate(page: Page, proxy: Awaited<ReturnType<typeof pwaUpdateProxy>>) {
  proxy.bump();
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await expect(page.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
}

test("article backlinks show only actual incoming sources and refresh after edits", async ({ page, request }, testInfo) => {
  const target = await create(request, "# Incoming link destination\nA synthetic article.");
  const source = await create(request, `# An incoming source\n[[${target.id}|Destination]] and [[${target.id}#Details]].`);
  const distant = await create(request, `# An indirect source\n[[${source.id}]].`);
  await create(request, `# Code is not a backlink\n\n\`[[${target.id}]]\``);
  await page.goto(`/wiki/${target.id}`);
  const panel = page.locator(".page-backlinks");
  await panel.locator("summary").click();
  await expect(panel.getByRole("link", { name: source.title, exact: true })).toHaveCount(1);
  await expect(panel.getByRole("link", { name: distant.title, exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Explicit links");
  await page.screenshot({ path: testInfo.outputPath("article-backlinks-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await panel.getByRole("link", { name: source.title, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("article-backlinks-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await panel.getByRole("link", { name: source.title, exact: true }).click();
  await expect(page.locator("article h1")).toHaveText(source.title);
  await page.goBack();
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks a")).toHaveCount(1);
  await update(request, source.id, "# An incoming source\nThe link has been removed.", source.revision);
  await page.getByRole("button", { name: "Refresh links" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-backlinks")).toContainText("No other pages link here yet.");
  await expect(page.getByRole("button", { name: "Refresh links" })).toBeFocused();
});

test("late backlink response cannot replace a newer article and read failures can retry", async ({ page, request }) => {
  const old = await create(request, "# Previous backlink article\nSynthetic old route.");
  const current = await create(request, "# Current backlink article\nSynthetic current route.");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/wiki/pages/${old.id}/backlinks`, async route => { await gate; await route.continue(); });
  await page.goto(`/wiki/${old.id}`);
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks")).toContainText("Loading incoming links");
  await openAllPages(page);
  await page.locator(".card").filter({ hasText: current.title }).click();
  const delayed = page.waitForResponse(response => response.url().endsWith(`/pages/${old.id}/backlinks`));
  release();
  await delayed;
  await expect(page.locator("article h1")).toHaveText(current.title);
  await expect(page.locator(".page-backlinks")).toContainText("Open to see pages");
  let failOnce = true;
  await page.route(`**/api/wiki/pages/${current.id}/backlinks`, async route => {
    if (failOnce) { failOnce = false; await route.abort(); } else await route.continue();
  });
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks")).toContainText("Couldn’t load incoming links");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".page-backlinks")).toContainText("No other pages link here yet.");
  await update(request, current.id, "# Current backlink article\nChanged after this read.", current.revision);
  await page.getByRole("button", { name: "Refresh links" }).click();
  await expect(page.locator(".page-backlinks")).toContainText("This article has changed");
  const reload = page.getByRole("button", { name: "Reload article", exact: true });
  await expect(reload).toBeFocused();
  let failReload = true;
  await page.route(`**/api/wiki/pages/${current.id}`, async route => {
    if (failReload) { failReload = false; await route.abort(); } else await route.continue();
  });
  await reload.press("Enter");
  await expect(page.locator(".page-backlinks")).toContainText("Couldn’t reload this article");
  await expect(reload).toBeFocused();
  await reload.press("Enter");
  await expect(page.locator(".prose")).toContainText("Changed after this read.");
  await expect(page.locator("article h1")).toBeFocused();
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks")).toContainText("No other pages link here yet.");
});

test("chat ignores malformed saved records and keeps a valid bounded conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?overview=1");
  await page.evaluate(async () => {
    const valid = { id: "synthetic-valid", title: "Synthetic saved question", updated: 1,
      messages: Array.from({ length: 26 }, () => ({ role: "user", content: "A retained synthetic question." })) };
    const invalid = [
      { ...valid, id: "bad-title", title: 42 },
      { ...valid, id: "bad-content", messages: [{ role: "user", content: null }] },
      { ...valid, id: "bad-source", messages: [{ role: "assistant", content: "Invalid source", sources: [{ id: null, title: "bad", evidence: "read" }] }] },
      { ...valid, id: "bad-activity", messages: [{ role: "assistant", content: "Invalid activity", activity: [42] }] },
      { ...valid, id: "bad-surrogate", messages: [{ role: "assistant", content: "Invalid source", sources: [{ id: "\ud800", title: "bad", evidence: "read" }] }] },
    ];
    await window.__wikiChatWrite([...invalid, valid]);
  });
  await page.goto("/chat");
  await expect(page.locator(".chat-message.user")).toHaveCount(24);
  await expect(page.locator(".chat-message.user").first()).toContainText("A retained synthetic question.");
  await expect(page.locator(".chat-history-list button")).toHaveCount(1);
  expect(errors).toEqual([]);
  for (let i = 0; i < 22; i++) await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-history-list button")).toHaveCount(20);
  expect(await page.evaluate(async () => (await window.__wikiChatRead()).length)).toBe(20);
});

test("new chat remains active at the limit even with future-dated saved conversations", async ({ page }) => {
  await page.goto("/?overview=1");
  await page.evaluate(async () => { await window.__wikiChatWrite(
    Array.from({ length: 20 }, (_, i) => ({ id: `synthetic-future-${i}`, title: `Earlier synthetic chat ${i}`, updated: Date.now() + 86400000,
      messages: [{ role: "user", content: "Earlier synthetic question." }] })),
  ); });
  let submitted: unknown;
  await page.route("**/api/wiki/chat", route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Synthetic new answer.", sources: [], activity: [] }) });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-message")).toHaveCount(0);
  await page.getByLabel("Message").fill("New synthetic question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic new answer.");
  expect(submitted).toEqual({ messages: [{ role: "user", content: "New synthetic question." }] });
  await expect(page.locator(".chat-history-list button")).toHaveCount(20);
  await page.reload();
  await expect(page.locator(".chat-message.user")).toHaveText(/New synthetic question/);
});

test("chat storage failure explains session-only answers and unsuccessful persisted deletion", async ({ page }, testInfo) => {
  await page.goto("/?overview=1");
  await page.evaluate(async () => {
    await window.__wikiChatWrite([{ id: "synthetic-storage", title: "Synthetic saved question", updated: 1,
      messages: [{ role: "user", content: "Previously saved synthetic question." }] }]);
  });
  // Scripted transport only: this checks local persistence, not model behavior.
  await page.route("**/api/wiki/chat", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ answer: "A synthetic session answer.", sources: [], activity: [] }) }));
  await page.goto("/chat");
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await failWikiChatWrites(page);
  await page.getByLabel("Message").fill("Synthetic follow-up.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("A synthetic session answer.");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("A synthetic session answer.");
  await expect(page.locator(".chat-storage-notice")).toContainText("only in this tab");
  await expect(page.getByLabel("Message")).toBeEnabled();
  const historyBox = (await page.locator(".chat-history").boundingBox())!;
  const titleBox = (await page.locator(".chat-history-list button").boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(historyBox.x + historyBox.width);
  expect((await page.locator(".chat-storage-notice").boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: testInfo.outputPath("chat-session-only-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".chat-storage-notice")).toBeVisible();
  expect((await page.locator(".chat-storage-notice").boundingBox())!.height).toBeGreaterThanOrEqual(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("chat-session-only-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(page.locator(".chat-storage-notice")).toContainText("previously saved");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  expect(await page.evaluate(async () => (await window.__wikiChatRead())[0].messages)).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-storage-notice")).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.__wikiChatRead()).some((item: { id: string }) => item.id === "synthetic-storage"))).toBeFalsy();
});

test("chat storage recovery retains unsaved conversations after article navigation", async ({ page }) => {
  await page.goto("/?overview=1");
  await page.evaluate(async () => {
    await window.__wikiChatWrite([{
      id: "saved-before-quota", title: "Saved before quota", updated: 1,
      messages: [{ role: "user", content: "Previously saved question." }],
    }]);
  });
  await page.route("**/api/wiki/chat", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ answer: "Synthetic answer during quota failure.", sources: [], activity: [] }) }));
  await page.goto("/chat");
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await failWikiChatWrites(page);
  await page.getByLabel("Message").fill("Unsaved follow-up in existing conversation.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer during quota failure.");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Message").fill("Unsaved independent conversation.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer during quota failure.");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-storage-notice")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-storage-notice")).toHaveCount(0);
  const stored = await page.evaluate(async () => (await window.__wikiChatRead()));
  expect(stored.find((item: { id: string }) => item.id === "saved-before-quota").messages).toHaveLength(3);
  expect(stored.some((item: { messages: Array<{ content: string }> }) =>
    item.messages.some(message => message.content === "Unsaved independent conversation."))).toBeTruthy();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-history-list button")).toHaveCount(3);
});

test("galaxy keyboard return restores its originating page and constellation", async ({ page }) => {
  await page.goto("/galaxy");
  const sky = page.locator(".galaxy-cluster").filter({ hasText: "Sky & navigation" });
  await sky.focus();
  await page.keyboard.press("Enter");
  const selected = page.locator(".galaxy-sidebar-content .galaxy-page").first();
  await expect(selected).toBeFocused();
  const id = await selected.getAttribute("data-node");
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeFocused();
  await page.getByRole("button", { name: "Neighborhood pages" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`.galaxy-sidebar-content .galaxy-page[data-node="${id}"]`)).toBeFocused();
  await page.getByRole("button", { name: "All constellations" }).focus();
  await page.keyboard.press("Enter");
  await expect(sky).toBeFocused();
});

for (const width of [1440, 390]) {
  test(`galaxy overview bundles real bridges and retains directional evidence (${width})`, async ({ page, request }, testInfo) => {
    const group = randomUUID();
    const pages: Awaited<ReturnType<typeof create>>[] = [];
    try {
    for (const title of ["Alpha core", "Alpha leaf", "Beta core", "Beta leaf"]) {
      pages.push(await create(request, `# ${title}\nSynthetic bridge fixture.`));
    }
    const [a, al, b, bl] = pages;
    const markdown = [
      `---\ngalaxy_group: alpha-${group}\ngalaxy_label: Bridge Alpha ${group}\ngalaxy_anchor: true\n---\n# Alpha core\n[[${al.id}]] [[${b.id}]] [[${bl.id}]]`,
      `---\ngalaxy_group: alpha-${group}\n---\n# Alpha leaf\n[[${b.id}]]`,
      `---\ngalaxy_group: beta-${group}\ngalaxy_label: Bridge Beta ${group}\ngalaxy_anchor: true\n---\n# Beta core\n[[${a.id}]]`,
      `---\ngalaxy_group: beta-${group}\n---\n# Beta leaf\n[[${al.id}]]`,
    ];
    for (let i = 0; i < pages.length; i++) await update(request, pages[i].id, markdown[i], pages[i].revision);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-star").first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`galaxy-bridge-overview-${width}.png`), fullPage: true });
    const title = page.locator(".galaxy-aggregate-link title").filter({ hasText: `Bridge Alpha ${group}` });
    await expect(title).toHaveCount(1);
    await expect(title).toHaveText(`5 explicit links between Bridge Alpha ${group} and Bridge Beta ${group}`);
    await page.locator(`.galaxy-star[data-node="${a.id}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Alpha core");
    await expect(page.locator(".galaxy-evidence li")).toHaveCount(4);
    await expect(page.locator(".galaxy-evidence li").filter({ hasText: "Beta core" })).toHaveCount(2);
    await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`galaxy-bridge-evidence-${width}.png`), fullPage: true });
    await page.locator(".galaxy-selected-heading .galaxy-article").click();
    await expect(page).toHaveURL(new RegExp(`/wiki/${a.id}$`));
    await expect(page.locator("article h1")).toHaveText("Alpha core");
    } finally {
      for (const fixture of [...pages].reverse()) {
        const fresh = await request.get(`/api/wiki/pages/${fixture.id}`);
        expect(fresh.ok()).toBeTruthy();
        expect((await request.delete(`/api/wiki/pages/${fixture.id}`, { data: {
          base_revision: (await fresh.json()).revision, request_id: randomUUID(),
        } })).ok()).toBeTruthy();
      }
    }
  });
}

for (const width of [1440, 390]) {
  test(`galaxy keeps keyboard stars visible after zoom (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy");
    const star = page.locator(".galaxy-star").first();
    await expect(star).toBeVisible();
    for (let step = 0; step < 6; step++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "List view", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`galaxy-keyboard-zoom-${width}.png`), fullPage: true });
    const visible = () => star.evaluate(element => {
      const node = element.getBoundingClientRect();
      const stage = element.closest(".galaxy-stage")!.getBoundingClientRect();
      const x = node.left + node.width / 2, y = node.top + node.height / 2;
      return x >= stage.left + 8 && x <= stage.right - 8 && y >= stage.top + 8 && y <= stage.bottom - 8;
    });
    expect(await visible(), "focused star must remain inside the clipped map").toBe(true);
    const map = (await page.locator(".galaxy-stage").boundingBox())!;
    await page.mouse.move(map.x + map.width - 12, map.y + 12);
    await page.mouse.down();
    await page.mouse.move(map.x + 12, map.y + map.height - 12, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString() || ""), "map dragging must not select SVG labels").toBe("");
    await page.getByRole("button", { name: "List view", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    expect(await visible(), "keyboard focus must also recover a panned map").toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`galaxy-keyboard-pan-${width}.png`), fullPage: true });
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/wiki\//);
    await expect(page.locator("article h1")).toBeVisible();
  });
}

for (const finish of ["save", "discard"] as const) {
  test(`PWA preserves a dirty tab when another tab updates, then permits ${finish} and reload`, async ({ page, context, request }, testInfo) => {
    const fixture = await create(request, "# PWA draft fixture\nOriginal synthetic content.");
    const draft = "# PWA draft fixture\nUnsaved synthetic draft.";
    const proxy = await pwaUpdateProxy();
    const other = await context.newPage();
    let unexpectedDialogs = 0;
    page.on("dialog", async dialog => {
      unexpectedDialogs++;
      await dialog.dismiss();
    });
    try {
      await page.goto(`${proxy.origin}/wiki/${fixture.id}`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await other.goto(`${proxy.origin}/?overview=1`);
      await other.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await page.getByRole("button", { name: "Edit page" }).click();
      await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
      await page.evaluate(() => {
        (window as any).__pwaDocumentMarker = "dirty-original-document";
        (window as any).__pwaControllerChanges = 0;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          (window as any).__pwaControllerChanges++;
        });
      });
      await offerPwaUpdate(page, proxy);
      const notice = page.locator('.pwa-notice[data-kind="update"]');
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await expect(notice).toContainText(/save.*discard/i);
      if (finish === "save") {
        await page.screenshot({ path: testInfo.outputPath("update-draft-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: testInfo.outputPath("update-draft-mobile.png"), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      }
      await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
      await Promise.all([
        other.waitForEvent("load"),
        other.getByRole("button", { name: "Update now" }).click(),
      ]);
      await page.waitForFunction(() => (window as any).__pwaControllerChanges === 1);
      await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
      expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBe("dirty-original-document");
      expect(unexpectedDialogs).toBe(0);
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      if (finish === "save") {
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.locator(".notice")).toContainText("Saved");
      } else {
        page.removeAllListeners("dialog");
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Cancel" }).click();
      }
      await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
      await Promise.all([
        page.waitForEvent("load"),
        notice.getByRole("button", { name: "Update now" }).click(),
      ]);
      await expect(page.locator(".prose")).toContainText(finish === "save" ? "Unsaved synthetic draft." : "Original synthetic content.");
      expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBeUndefined();
      await expect(page.locator('.pwa-notice[data-kind="update"]')).toBeHidden();
    } finally {
      await context.close();
      await proxy.close();
    }
  });
}


test("PWA protects an unsent Chat draft while reading another page", async ({ page, context }) => {
  const proxy = await pwaUpdateProxy();
  const other = await context.newPage();
  try {
    await page.goto(`${proxy.origin}/chat`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const draft = "A fictional question to finish after reading.";
    await input.fill(draft);
    await offerPwaUpdate(page, proxy);
    await page.getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("link", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/\/search$/);
    const notice = page.locator('.pwa-notice[data-kind="update"]');
    await expect(notice).toContainText("Send or clear your message drafts");
    await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
    await page.evaluate(() => {
      (window as any).__retainedDraftDocument = true;
      (window as any).__retainedDraftControllerChanges = 0;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        (window as any).__retainedDraftControllerChanges++;
      });
    });
    await other.goto(`${proxy.origin}/?overview=1`);
    await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
    await Promise.all([
      other.waitForEvent("load"),
      other.getByRole("button", { name: "Update now" }).click(),
    ]);
    await page.waitForFunction(() => (window as any).__retainedDraftControllerChanges === 1);
    expect(await page.evaluate(() => (window as any).__retainedDraftDocument)).toBe(true);
    await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
    await page.getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("link", { name: "Chat", exact: true }).click();
    await expect(input).toHaveValue(draft);
    await input.fill("");
    await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
  } finally {
    await other.close();
    await proxy.close();
  }
});

for (const finish of ["clear", "send", "stop"] as const) {
  test(`PWA protects a chat draft through ${finish} and another tab's update`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: finish === "clear" ? 1440 : 390, height: 1000 });
    const proxy = await pwaUpdateProxy();
    const other = await context.newPage();
    const question = "What does the fictional tide clock measure?";
    const answer = "Synthetic update test reply: the tide clock marks a navigation window.";
    let releaseReply!: () => void;
    let reachedReply!: () => void;
    let deliveredReply!: () => void;
    let draftConversation: string | null = null;
    const pendingReply = new Promise<void>(resolve => { releaseReply = resolve; });
    const replyArrived = new Promise<void>(resolve => { reachedReply = resolve; });
    const replyDelivered = new Promise<void>(resolve => { deliveredReply = resolve; });
    await page.route("**/api/wiki/chat", async route => {
      reachedReply();
      await pendingReply;
      await route.fulfill({ json: { answer, sources: [], activity: [] } });
      deliveredReply();
    });
    try {
      await page.goto(`${proxy.origin}/chat`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await other.goto(`${proxy.origin}/?overview=1`);
      await other.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      // Cover both a draft that predates the offer and typing after the offer.
      if (finish !== "clear") await input.fill(question);
      await offerPwaUpdate(page, proxy);
      const notice = page.locator('.pwa-notice[data-kind="update"]');
      if (finish === "clear") {
        await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
        await input.fill(question);
        draftConversation = await page.locator(".chat-history-list button.active").getAttribute("data-conversation");
        await page.getByRole("button", { name: "New", exact: true }).click();
        await expect(input).toHaveValue("");
        expect(await page.evaluate(async () => JSON.stringify(await window.__wikiChatRead())))
          .not.toContain(question);
      }
      // An empty active composer must not hide another conversation's unsent draft.
      await expect(notice).toContainText("Send or clear your message drafts in all conversations");
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await page.evaluate(() => {
        (window as any).__pwaChatDocument = "original-chat-document";
        (window as any).__pwaChatControllerChanges = 0;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          (window as any).__pwaChatControllerChanges++;
        });
      });
      await page.screenshot({ path: testInfo.outputPath(`update-chat-draft-${finish}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(finish === "clear" ? 1440 : 390);
      if (finish !== "clear") {
        await page.getByRole("button", { name: "Send", exact: false }).click();
        await replyArrived;
        await expect(notice).toContainText("Wait for your chat reply");
        await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      }
      await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
      await Promise.all([
        other.waitForEvent("load"),
        other.getByRole("button", { name: "Update now" }).click(),
      ]);
      await page.waitForFunction(() => (window as any).__pwaChatControllerChanges === 1);
      if (finish === "clear") await expect(input).toHaveValue("");
      else {
        await expect(page.locator(".chat-message.user")).toContainText(question);
        await expect(page.locator(".chat-thinking")).toBeVisible();
        await expect(notice).toContainText("Wait for your chat reply");
      }
      expect(await page.evaluate(() => (window as any).__pwaChatDocument)).toBe("original-chat-document");
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      if (finish === "send") {
        releaseReply();
        await expect(page.locator(".chat-message.assistant")).toContainText(answer);
        await expect.poll(() => page.evaluate(async () => JSON.stringify(await window.__wikiChatRead()))).toContain(answer);
      } else if (finish === "stop") {
        const aborted = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/wiki/chat");
        await page.getByRole("button", { name: "Stop reply", exact: true }).click();
        await aborted;
        releaseReply();
        await replyDelivered;
        await expect(page.locator(".chat-error")).toContainText("Reply stopped.");
        await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
        const stored = await page.evaluate(async () => JSON.stringify(await window.__wikiChatRead()));
        expect(stored).toContain(question);
        expect(stored).not.toContain(answer);
      } else {
        await page.locator(`[data-conversation="${draftConversation}"]`).click();
        await expect(input).toHaveValue(question);
        await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
        await input.fill("");
      }
      await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
      await Promise.all([
        page.waitForEvent("load"),
        notice.getByRole("button", { name: "Update now" }).click(),
      ]);
      expect(await page.evaluate(() => (window as any).__pwaChatDocument)).toBeUndefined();
      await expect(page.locator('.pwa-notice[data-kind="update"]')).toBeHidden();
      if (finish === "send") {
        await expect(page.locator(".chat-message.user")).toContainText(question);
        await expect(page.locator(".chat-message.assistant")).toContainText(answer);
      } else if (finish === "stop") {
        await expect(page.locator(".chat-message.user")).toContainText(question);
        await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
      } else await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
    } finally {
      releaseReply();
      // The context owns worker connections as well as its pages.
      await context.close();
      await proxy.close();
    }
  });
}

for (const finish of ["recover", "delete"] as const) {
  test(`PWA retains session-only chat across navigation and another tab's update until ${finish}`, async ({ page, context }, testInfo) => {
    const proxy = await pwaUpdateProxy();
    const other = await context.newPage();
    const question = "Synthetic unsaved storage question.";
    const answer = "Synthetic reply retained only in this tab.";

    await page.route("**/api/wiki/chat", route => route.fulfill({ json: { answer, sources: [], activity: [] } }));
    try {
      await page.goto(`${proxy.origin}/chat`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await other.goto(`${proxy.origin}/?overview=1`);
      await other.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await expect(page.getByLabel("Message")).toBeEnabled();
      await failWikiChatWrites(page);
      await page.getByLabel("Message").fill(question);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".chat-message.assistant")).toContainText(answer);
      await expect(page.locator(".chat-storage-notice")).toContainText("only in this tab");
      expect(await page.evaluate(async () => await window.__wikiChatRead())).toEqual([]);
      await offerPwaUpdate(page, proxy);
      const notice = page.locator('.pwa-notice[data-kind="update"]');
      await expect(notice).toContainText("Recover browser storage or delete unsaved conversations");
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await openAllPages(page);
      await page.locator('.grid a[href="/wiki/mira-quill"]').click();
      await expect(page.locator("article h1")).toHaveText("Mira Quill — fictional archivist");
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await page.evaluate(() => {
        (window as any).__pwaStorageDocument = "session-only-document";
        (window as any).__pwaStorageControllerChanges = 0;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          (window as any).__pwaStorageControllerChanges++;
        });
      });
      await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
      await Promise.all([other.waitForEvent("load"), other.getByRole("button", { name: "Update now" }).click()]);
      await page.waitForFunction(() => (window as any).__pwaStorageControllerChanges === 1);
      expect(await page.evaluate(() => (window as any).__pwaStorageDocument)).toBe("session-only-document");
      await page.getByRole("link", { name: "Chat", exact: true }).click();
      await expect(page.locator(".chat-message.assistant")).toContainText(answer);
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath(`update-chat-storage-${finish}.png`), fullPage: true });
      if (finish === "recover") {
        await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
        await page.getByRole("button", { name: "New", exact: true }).click();
        await page.locator(".chat-history-list button").filter({ hasText: question }).click();
        await expect(page.locator(".chat-storage-notice")).toHaveCount(0);
        expect(await page.evaluate(async () => JSON.stringify(await window.__wikiChatRead()))).toContain(answer);
      } else {
        await page.getByRole("button", { name: "Delete conversation" }).click();
        await expect(page.locator(".chat-message")).toHaveCount(0);
      }
      await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
      await Promise.all([page.waitForEvent("load"), notice.getByRole("button", { name: "Update now" }).click()]);
      expect(await page.evaluate(() => (window as any).__pwaStorageDocument)).toBeUndefined();
      await expect(page.locator('.pwa-notice[data-kind="update"]')).toBeHidden();
      if (finish === "recover") await expect(page.locator(".chat-message.assistant")).toContainText(answer);
      else await expect(page.locator(".chat-message")).toHaveCount(0);
    } finally {
      // The context owns worker connections as well as its pages.
      await context.close();
      await proxy.close();
    }
  });
}

test("PWA blocks update during an unchanged save until the real response arrives", async ({ page, context, request }, testInfo) => {
  const fixture = await create(request, "# PWA saving fixture\nSynthetic unchanged text.");
  const proxy = await pwaUpdateProxy();
  const other = await context.newPage();
  let held: ReturnType<typeof proxy.holdNextSave> | undefined;
  const notice = page.locator('.pwa-notice[data-kind="update"]');
  let phase = "setup";
  const step = async (name: string, run: () => Promise<void>) => {
    phase = name;
    console.info("[pwa-save-phase] " + phase);
    await test.step(name, run);
  };
  let unexpectedDialogs = 0;
  page.on("dialog", async dialog => { unexpectedDialogs++; await dialog.dismiss(); });
  try {
    await traceFirstInstall(page);
    await traceFirstInstall(other);
    await step("native workers control both tabs", async () => {
      await page.goto(`${proxy.origin}/wiki/${fixture.id}`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await other.goto(`${proxy.origin}/?overview=1`);
      await other.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    });
    await step("real save stays held while update waits", async () => {
      await page.getByRole("button", { name: "Edit page" }).click();
      held = proxy.holdNextSave();
      await page.getByRole("button", { name: "Save changes" }).click();
      await held.arrived;
      await expect(page.getByRole("button", { name: "Saving" })).toBeDisabled();
      await page.evaluate(() => {
        (window as any).__pwaDocumentMarker = "saving-document";
        (window as any).__pwaControllerChanges = 0;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          (window as any).__pwaControllerChanges++;
        });
      });
      await offerPwaUpdate(page, proxy);
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await expect(notice).toContainText(/sav/i);
      expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    });
    await step("other tab activates without losing the held save", async () => {
      await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
      await Promise.all([other.waitForEvent("load"), other.getByRole("button", { name: "Update now" }).click()]);
      await page.waitForFunction(() => (window as any).__pwaControllerChanges === 1);
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Saving" })).toBeDisabled();
      expect(unexpectedDialogs).toBe(0);
      expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBe("saving-document");
      await page.screenshot({ path: testInfo.outputPath("pwa-held-save.png") });
    });
    await step("save completes before applying the new worker", async () => {
      if (!held) throw new Error("The real save gate was not created");
      held.release();
      await expect(page.locator(".notice")).toContainText("Saved");
      await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
      await Promise.all([page.waitForEvent("load"), notice.getByRole("button", { name: "Update now" }).click()]);
      await expect(page.locator(".prose")).toContainText("Synthetic unchanged text.");
      expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBeUndefined();
      await page.screenshot({ path: testInfo.outputPath("pwa-completed-save.png") });
    });
  } finally {
    console.info("[pwa-save-lifecycle] " + JSON.stringify({
      phase, main: await readFirstInstallTrace(page, "before-cleanup"),
      other: await readFirstInstallTrace(other, "before-cleanup"),
    }));
    held?.release();
    await step("close the browser context before its proxy", async () => {
      await context.close();
      console.info("[pwa-save-phase] close-proxy");
      await proxy.close();
    });
  }
});


for (const width of [390, 1440]) {
  test(`galaxy refresh keeps anchored cores and updates a real directed bridge (${width})`, async ({ page, request }, testInfo) => {
    const group = randomUUID();
    const labels = [`Link Alpha ${group}`, `Link Beta ${group}`];
    const fixtures: Awaited<ReturnType<typeof create>>[] = [];
    try {
      for (const title of ["Alpha core", "Beta core", "Beta leaf", "Alpha leaf seed 1", "Alpha leaf seed 2", "Alpha leaf seed 3"]) {
        fixtures.push(await create(request, `# ${title}\nSynthetic link mutation fixture.`));
      }
      const [a, b, bl] = fixtures;
      // Promote the last tied ordinary star, rather than depending on UUID luck.
      const leaves = fixtures.slice(3).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const [first, second, al] = leaves;
      const leafMarkdown = `---\ngalaxy_group: link-alpha-${group}\n---\n# Alpha leaf\nSynthetic original text.`;
      const setup = [
        [a, `---\ngalaxy_group: link-alpha-${group}\ngalaxy_label: ${labels[0]}\ngalaxy_anchor: true\n---\n# Alpha core\n${leaves.map(leaf => `[[${leaf.id}]]`).join(" ")} [[${b.id}]]`],
        [b, `---\ngalaxy_group: link-beta-${group}\ngalaxy_label: ${labels[1]}\ngalaxy_anchor: true\n---\n# Beta core\n[[${bl.id}]]`],
        [bl, `---\ngalaxy_group: link-beta-${group}\n---\n# Beta leaf\nSynthetic original text.`],
        [first, `---\ngalaxy_group: link-alpha-${group}\n---\n# Alpha first\nSynthetic original text.`],
        [second, `---\ngalaxy_group: link-alpha-${group}\n---\n# Alpha second\nSynthetic original text.`],
        [al, leafMarkdown],
      ];
      for (const [fixture, markdown] of setup as [Awaited<ReturnType<typeof create>>, string][]) {
        await update(request, fixture.id, markdown, fixture.revision);
      }
      await page.setViewportSize({ width, height: 1000 });
      const capture = async (phase: string) => {
        const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/wiki/graph") && response.request().method() === "GET");
        if (phase === "before") await page.goto("/galaxy");
        else await page.getByRole("link", { name: "Refresh snapshot" }).click();
        const response = await responsePromise;
        expect(response.ok()).toBeTruthy();
        const graph = await response.json();
        const direct = await request.get("/api/wiki/graph");
        expect(direct.ok()).toBeTruthy();
        expect(await direct.json()).toEqual(graph);
        await expect(page.locator(".galaxy-revision")).toContainText(graph.revision.slice(0, 8));
        await expect(page.locator(`.galaxy-star[data-node="${a.id}"]`)).toBeVisible();
        const measurements = await page.locator(".galaxy-stage svg").evaluate(element => {
          const svg = element as SVGSVGElement, matrix = svg.getScreenCTM()!, rect = svg.getBoundingClientRect();
          return {
            world: [...svg.querySelectorAll<SVGGElement>(".galaxy-star")].map(star => ({
              id: star.dataset.node!, core: star.classList.contains("is-core"), transform: star.getAttribute("transform"),
            })).sort((a, b) => a.id.localeCompare(b.id)),
            bridges: [...svg.querySelectorAll(".galaxy-aggregate-link")].map(link => ({
              title: link.querySelector("title")!.textContent,
              coordinates: ["x1", "y1", "x2", "y2"].map(name => Number(link.querySelector("line")!.getAttribute(name))),
            })).sort((a, b) => a.title!.localeCompare(b.title!)),
            viewport: { viewBox: svg.getAttribute("viewBox"), width: rect.width, height: rect.height,
              matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] },
          };
        });
        const snapshot = { graph, measurements };
        const evidencePath = testInfo.outputPath(`galaxy-link-mutation-${width}-${phase}.json`);
        await writeFile(evidencePath, JSON.stringify(snapshot, null, 2));
        await testInfo.attach(`galaxy-link-mutation-${width}-${phase}`, { path: evidencePath, contentType: "application/json" });
        await page.screenshot({ path: testInfo.outputPath(`galaxy-link-mutation-${width}-${phase}.png`), fullPage: true });
        return snapshot;
      };
      const before = await capture("before");
      const bridgeTitle = page.locator(".galaxy-aggregate-link title").filter({ hasText: labels[0] });
      const originalTitle = `1 explicit link between ${labels[0]} and ${labels[1]}`;
      expect(before.measurements.bridges.filter(bridge => bridge.title === originalTitle)).toHaveLength(1);
      const fresh = await request.get(`/api/wiki/pages/${al.id}`);
      expect(fresh.ok()).toBeTruthy();
      const current = await fresh.json();
      await update(request, al.id, `${leafMarkdown}\n\n[[${bl.id}]]`, current.revision);
      // The map is a named snapshot until the user refreshes it.
      await expect(bridgeTitle).toHaveText(originalTitle);
      const after = await capture("after");
      expect(after.graph.revision).not.toBe(before.graph.revision);
      expect(after.graph.nodes).toEqual(before.graph.nodes);
      const edgeKey = (edge: { source: string; target: string; type: string; rel?: string }) => JSON.stringify(edge);
      const beforeEdges = new Set(before.graph.edges.map(edgeKey));
      const afterEdges = new Set(after.graph.edges.map(edgeKey));
      expect([...beforeEdges].filter(edge => !afterEdges.has(edge))).toEqual([]);
      const added = after.graph.edges.filter((edge: { source: string; target: string; type: string; rel?: string }) => !beforeEdges.has(edgeKey(edge)));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ source: al.id, target: bl.id });
      expect(after.measurements.world.filter(star => star.core)).toEqual(before.measurements.world.filter(star => star.core));
      expect(after.measurements.world.map(({ id, core }) => ({ id, core }))).toEqual(before.measurements.world.map(({ id, core }) => ({ id, core })));
      const sourceIds = leaves.map(leaf => leaf.id);
      const position = (snapshot: typeof before, id: string) => snapshot.measurements.world.find(star => star.id === id)!.transform;
      const degree = (snapshot: typeof before, id: string) => new Set(snapshot.graph.edges
        .filter((edge: { source: string; target: string }) => edge.source === id || edge.target === id)
        .map((edge: { source: string; target: string }) => edge.source === id ? edge.target : edge.source)).size;
      for (const leaf of leaves) expect(degree(before, leaf.id)).toBe(1);
      expect(degree(after, al.id)).toBe(2);
      expect(position(after, al.id)).toBe(position(before, first.id));
      expect(position(after, first.id)).toBe(position(before, second.id));
      expect(position(after, second.id)).toBe(position(before, al.id));
      expect(after.measurements.world.filter(star => !sourceIds.includes(star.id)))
        .toEqual(before.measurements.world.filter(star => !sourceIds.includes(star.id)));
      const bridge = after.measurements.bridges.filter(item => item.title!.includes(labels[0]));
      expect(bridge).toHaveLength(1);
      expect(bridge[0].title).toBe(`2 explicit links between ${labels[0]} and ${labels[1]}`);
      expect(bridge[0].coordinates.every(Number.isFinite)).toBeTruthy();
      const endpoints = [a.id, b.id].map(id => after.measurements.world.find(star => star.id === id)!.transform!
        .slice(10, -1).split(" ").map(Number));
      expect([bridge[0].coordinates.slice(0, 2), bridge[0].coordinates.slice(2)]).toEqual(endpoints);
      expect(after.measurements.bridges.filter(item => !item.title!.includes(labels[0])))
        .toEqual(before.measurements.bridges.filter(item => !item.title!.includes(labels[0])));
      await page.locator(`.galaxy-star[data-node="${al.id}"]`).focus();
      await page.keyboard.press("Enter");
      const evidence = page.locator(".galaxy-evidence li").filter({ hasText: "Beta leaf" });
      await expect(evidence).toHaveCount(1);
      await expect(evidence).toContainText("across neighborhoods");
      expect(await evidence.locator("div a[data-open]").evaluateAll(links => links.map(link => link.getAttribute("data-open"))))
        .toEqual([al.id, bl.id]);
      const selectedArticle = page.locator(".galaxy-selected-heading .galaxy-article");
      await expect(selectedArticle).toBeFocused();
      const captureGeometry = () => page.locator(".skip-link").evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, scrollX, scrollY,
          focused: document.activeElement === element,
          activePage: document.activeElement?.getAttribute("data-open"),
          transform: getComputedStyle(element).transform };
      });
      const beforeCapture = await captureGeometry();
      expect(beforeCapture.focused).toBe(false);
      expect(beforeCapture.bottom).toBeLessThanOrEqual(0);
      expect(beforeCapture.activePage).toBe(al.id);
      await page.screenshot({ path: testInfo.outputPath(`galaxy-link-mutation-${width}-evidence-viewport.png`) });
      await page.screenshot({ path: testInfo.outputPath(`galaxy-link-mutation-${width}-evidence.png`), fullPage: true });
      const afterCapture = await captureGeometry();
      expect(afterCapture).toEqual(beforeCapture);
      await expect(selectedArticle).toBeFocused();
      const geometryPath = testInfo.outputPath(`galaxy-link-mutation-${width}-capture.json`);
      await writeFile(geometryPath, JSON.stringify({ width, beforeCapture, afterCapture }, null, 2));
      await testInfo.attach(`galaxy-link-mutation-${width}-capture`, { path: geometryPath, contentType: "application/json" });
      await page.getByRole("button", { name: "List view", exact: true }).click();
      await expect(page.locator(".galaxy-stage")).toBeHidden();
      await page.locator(".galaxy-selected-heading .galaxy-article").click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${al.id}$`));
      await expect(page.locator("article h1")).toHaveText("Alpha leaf");
    } finally {
      for (const fixture of [...fixtures].reverse()) {
        const fresh = await request.get(`/api/wiki/pages/${fixture.id}`);
        expect(fresh.ok()).toBeTruthy();
        expect((await request.delete(`/api/wiki/pages/${fixture.id}`, { data: {
          base_revision: (await fresh.json()).revision, request_id: randomUUID(),
        } })).ok()).toBeTruthy();
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`galaxy curated world layout survives an unrelated real text edit (${width})`, async ({ page, request }, testInfo) => {
    const title = `Synthetic stability ${randomUUID()}`;
    const fixture = await create(request, `# ${title}\nUnrelated synthetic text before editing.`);
    try {
      await page.setViewportSize({ width, height: 1000 });
      const capture = async (phase: string) => {
        const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/wiki/graph") && response.request().method() === "GET");
        await page.goto("/galaxy");
        const browserResponse = await responsePromise;
        expect(browserResponse.ok()).toBeTruthy();
        const graph = await browserResponse.json();
        const apiResponse = await request.get("/api/wiki/graph");
        expect(apiResponse.ok()).toBeTruthy();
        expect(await apiResponse.json()).toEqual(graph);
        const curated = graph.nodes.filter((node: { galaxy?: { group: string } }) => node.galaxy?.group);
        expect(curated.length).toBeGreaterThan(0);
        const ids = curated.map((node: { id: string }) => node.id).sort();
        await expect(page.locator(".galaxy-star").first()).toBeVisible();
        const measurements = await page.locator(".galaxy-stage svg").evaluate((element, curatedIds) => {
          const svg = element as SVGSVGElement;
          const rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM()!;
          return {
            world: [...svg.querySelectorAll<SVGGElement>(".galaxy-star")]
              .filter(star => curatedIds.includes(star.dataset.node!))
              .map(star => ({ id: star.dataset.node!, core: star.classList.contains("is-core"), transform: star.getAttribute("transform") }))
              .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            bridges: [...svg.querySelectorAll(".galaxy-aggregate-link")].map(link => ({
              title: link.querySelector("title")!.textContent,
              coordinates: ["x1", "y1", "x2", "y2"].map(name => Number(link.querySelector("line")!.getAttribute(name))),
            })).sort((a, b) => a.title!.localeCompare(b.title!)),
            viewport: { viewBox: svg.getAttribute("viewBox"), width: rect.width, height: rect.height, matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] },
          };
        }, ids);
        expect(measurements.world.map(star => star.id)).toEqual(ids);
        expect(measurements.world.some(star => star.core)).toBeTruthy();
        for (const star of measurements.world) expect(star.transform).toMatch(/^translate\(/);
        for (const bridge of measurements.bridges) expect(bridge.coordinates.every(Number.isFinite)).toBeTruthy();
        expect(measurements.bridges.length).toBeGreaterThan(0);
        await page.screenshot({ path: testInfo.outputPath(`galaxy-stability-${width}-${phase}.png`), fullPage: true });
        const snapshot = { graph, measurements };
        console.log(`Galaxy stability ${width} ${phase}: ${JSON.stringify(measurements)}`);
        const evidencePath = testInfo.outputPath(`galaxy-stability-${width}-${phase}.json`);
        await writeFile(evidencePath, JSON.stringify(snapshot, null, 2));
        await testInfo.attach(`galaxy-stability-${width}-${phase}`, { path: evidencePath, contentType: "application/json" });
        return snapshot;
      };
      const before = await capture("before");
      const saved = await update(request, fixture.id, `# ${title}\nUnrelated synthetic text after a small edit.`, fixture.revision);
      expect(saved.revision).not.toBe(fixture.revision);
      const after = await capture("after");
      expect(after.graph.revision).not.toBe(before.graph.revision);
      // Equal API metadata and directed relations prove membership inputs stayed
      // fixed. SVG translations are world coordinates; screen fitting is separate.
      expect(after.graph.nodes).toEqual(before.graph.nodes);
      expect(after.graph.edges).toEqual(before.graph.edges);
      expect(after.measurements.world).toEqual(before.measurements.world);
      expect(after.measurements.bridges).toEqual(before.measurements.bridges);
    } finally {
      const fresh = await request.get(`/api/wiki/pages/${fixture.id}`);
      expect(fresh.ok()).toBeTruthy();
      const current = await fresh.json();
      const removed = await request.delete(`/api/wiki/pages/${fixture.id}`, { data: { base_revision: current.revision, request_id: randomUUID() } });
      expect(removed.ok()).toBeTruthy();
    }
  });
}


for (const width of [390, 1440]) {
  test(`delimited HTML blocks preserve real article identity and graph (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const token = randomUUID();
    const target = `delimited-visible-${token}`, hidden = `delimited-hidden-${token}`;
    const created: string[] = [];
    const save = async (id: string, markdown: string, base_revision: string | null = null) => {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown, base_revision, request_id: randomUUID() } });
      expect(response.ok()).toBe(true);
      if (!created.includes(id)) created.push(id);
      return response.json();
    };
    try {
      await save(target, "# Synthetic visible companion");
      await save(hidden, "# Synthetic hidden companion");
      for (const [kind, opening, closing] of [
        ["instruction", "<?synthetic", "?>"],
        ["declaration", "<!SYNTHETIC", ">"],
        ["cdata", "<![CDATA[", "]]>"]
      ]) {
        const id = `delimited-${kind}-${token}`;
        const title = `Synthetic ${kind} article`;
        let markdown = `${opening}\n# Literal title\n[[${hidden}]] [[delimited-absent]]\n\n- [[delimited-list-absent]]\n${closing}[[${target}|Same-line companion]]\n\n# ${title}\n\nVisible [[${target}|Visible companion]].\n`;
        const saved = await save(id, markdown);
        await page.goto(`/wiki/${id}`);
        await expect(page.locator(".prose")).toBeVisible();
        await page.screenshot({ path: info.outputPath(`delimited-${kind}-${width}.png`), fullPage: true });
        const check = async () => {
          await expect(page.locator("article > h1")).toHaveText(title);
          await expect(page.locator(".prose h1")).toHaveCount(0);
          await expect(page.locator(".prose").getByRole("link", { name: "Same-line companion", exact: true })).toHaveCount(1);
          await expect(page.locator(".prose").getByRole("link", { name: "Visible companion", exact: true })).toHaveCount(1);
          await expect(page.locator(`.prose [data-wiki-target="${hidden}"]`)).toHaveCount(0);
          const graph = await (await request.get("/api/wiki/graph")).json();
          expect(graph.edges.filter((edge: any) => edge.source === id)).toEqual([{ source: id, target, type: "wikilink" }]);
          expect(graph.missing_targets.filter((edge: any) => edge.source === id)).toEqual([]);
          expect((await (await request.get(`/api/wiki/pages/${id}`)).json()).markdown).toBe(markdown);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await check();
        await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
        await expect(page.locator("#editor")).toHaveValue(markdown);
        markdown += "\nAn intentional synthetic edit.\n";
        await page.locator("#editor").fill(markdown);
        await page.getByRole("button", { name: "Save changes →", exact: true }).click();
        await expect(page.locator(".notice")).toContainText("Saved locally");
        await check();
        await page.reload();
        await check();
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        expect(current.revision).not.toBe(saved.revision);
        expect((await (await request.get(`/api/wiki/pages/${id}/history`)).json()).history).toHaveLength(2);
        await page.locator(".prose").getByRole("link", { name: "Same-line companion", exact: true }).click();
        await expect(page.locator("article > h1")).toHaveText("Synthetic visible companion");
        await page.goBack();
        await check();
      }
    } finally {
      for (const id of created.reverse()) {
        const response = await request.get(`/api/wiki/pages/${id}`);
        expect(response.ok()).toBe(true);
        const current = await response.json();
        const deleted = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } });
        expect(deleted.ok()).toBe(true);
      }
    }
  });
}


for (const width of [390, 1440]) {
  test(`escaped backticks retain real prose links (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const token = randomUUID(), source = `ticks-source-${token}`;
    const target = `ticks-target-${token}`, hidden = `ticks-hidden-${token}`;
    const created: string[] = [];
    const save = async (id: string, markdown: string) => {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown, base_revision: null, request_id: randomUUID() } });
      expect(response.ok()).toBe(true); created.push(id);
    };
    let markdown = "# Synthetic backtick guide\r\n\r\nUse \\` [[TARGET|Visible companion]] \\` to describe ticks.\r\n\r\nThree \\\\\\` [[TARGET|Another companion]] \\\\\\` remain prose.\r\n\r\nCode `[[HIDDEN|Literal example]]` stays literal.\r\n".split("TARGET").join(target).split("HIDDEN").join(hidden);
    try {
      await save(target, "# Synthetic prose destination");
      await save(hidden, "# Synthetic code destination");
      await save(source, markdown);
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic backtick guide");
      const check = async () => {
        await expect(page.locator(`.prose [data-wiki-target="${target}"]`)).toHaveCount(2);
        await expect(page.locator(`.prose [data-wiki-target="${hidden}"]`)).toHaveCount(0);
        await expect(page.locator(".prose code")).toHaveText(`[[${hidden}|Literal example]]`);
        const current = await (await request.get(`/api/wiki/pages/${source}`)).json();
        expect(current.markdown).toBe(markdown);
        expect(current.excerpt).toContain("Visible companion");
        expect(current.excerpt).toContain("Another companion");
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: any) => edge.source === source)).toEqual([{ source, target, type: "wikilink" }]);
        const backlinks = await (await request.get(`/api/wiki/pages/${target}/backlinks`)).json();
        expect(backlinks.backlinks.some((item: any) => item.id === source)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await check();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown.replace(/\r\n/g, "\n"));
      markdown += "\r\nA deliberate synthetic revision.\r\n";
      await page.locator("#editor").fill(markdown);
      // Textareas normalize CRLF; the editor's submitted bytes are authoritative.
      markdown = await page.locator("#editor").inputValue();
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await check(); await page.reload(); await check();
      expect((await (await request.get(`/api/wiki/pages/${source}/history`)).json()).history).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`escaped-backticks-${width}.png`), fullPage: true });
      await page.locator(".prose").getByRole("link", { name: "Visible companion", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Synthetic prose destination");
      await page.goBack(); await check();
    } finally {
      for (const id of created.reverse()) {
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        expect((await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } })).ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`inline comment scopes preserve visible block and cell links (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const token = randomUUID(), source = `scope-source-${token}`;
    const target = `scope-target-${token}`, hidden = `scope-hidden-${token}`;
    const created: string[] = [];
    const save = async (id: string, markdown: string) => {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown, base_revision: null, request_id: randomUUID() } });
      expect(response.ok()).toBe(true); created.push(id); return response.json();
    };
    let markdown = `# Synthetic scoped annotation\n\nProse<!-- unfinished [[${target}|Before heading]].\n## Boundary heading [[${target}|Heading destination]]\n-->[[${target}|After heading]].\n\n| Topic | Context |\n| --- | --- |\n| cell<!-- [[${target}]] | -->[[${target}]] |\n\nProse<!-- [[${target}|Before code]].\n\`\`\`html\n-->[[${hidden}|Code example]]\n\`\`\`\n[[${target}|After code]].\n\nValid<!-- [[${hidden}|Hidden annotation]]\ncontinued --> ending.\n`;
    try {
      await save(target, "# Synthetic scope destination");
      await save(hidden, "# Synthetic literal destination");
      await save(source, markdown);
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic scoped annotation");
      const check = async () => {
        await expect(page.locator(`.prose [data-wiki-target="${target}"]`)).toHaveCount(7);
        for (const label of ["Before heading", "Heading destination", "After heading", "Before code", "After code"]) {
          await expect(page.locator(".prose").getByRole("link", { name: label, exact: true })).toHaveCount(1);
        }
        await expect(page.locator(`.prose [data-wiki-target="${hidden}"]`)).toHaveCount(0);
        const current = await (await request.get(`/api/wiki/pages/${source}`)).json();
        expect(current.markdown).toBe(markdown);
        expect(current.excerpt).toContain("Before heading");
        expect(current.excerpt).toContain("After heading");
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: any) => edge.source === source)).toEqual([{ source, target, type: "wikilink" }]);
        expect(graph.missing_targets.filter((edge: any) => edge.source === source)).toEqual([]);
        const backlinks = await (await request.get(`/api/wiki/pages/${target}/backlinks`)).json();
        expect(backlinks.backlinks.some((item: any) => item.id === source)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await check();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      markdown += "\nAn intentional synthetic edit.\n";
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await check(); await page.reload(); await check();
      expect((await (await request.get(`/api/wiki/pages/${source}/history`)).json()).history).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`inline-comment-scopes-${width}.png`), fullPage: true });
      await page.locator(".prose").getByRole("link", { name: "Before heading", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Synthetic scope destination");
      await page.goBack(); await check();
    } finally {
      for (const id of created.reverse()) {
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        const response = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`unclosed inline comments preserve visible prose (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const token = randomUUID(), source = `unclosed-source-${token}`;
    const target = `unclosed-target-${token}`, hidden = `unclosed-hidden-${token}`;
    const created: string[] = [];
    const save = async (id: string, markdown: string) => {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown, base_revision: null, request_id: randomUUID() } });
      expect(response.ok()).toBe(true); created.push(id); return response.json();
    };
    let markdown = `# Synthetic unclosed annotation\n\nProse<!-- unfinished [[${target}|Visible companion]].\n\n## Visible later heading\n\nLater [[${target}|Later companion]].\n\nCode \`<!-- [[${hidden}|Code example]]\`.\n\n<!-- unfinished block [[${hidden}|Block example]]\n`;
    try {
      await save(target, "# Synthetic visible destination");
      await save(hidden, "# Synthetic literal destination");
      await save(source, markdown);
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic unclosed annotation");
      const check = async () => {
        await expect(page.locator(".prose").getByRole("link", { name: "Visible companion", exact: true })).toHaveCount(1);
        await expect(page.locator(".prose").getByRole("link", { name: "Later companion", exact: true })).toHaveCount(1);
        await expect(page.locator(".prose").getByRole("heading", { name: "Visible later heading", exact: true })).toHaveCount(1);
        await expect(page.locator(`.prose [data-wiki-target="${hidden}"]`)).toHaveCount(0);
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: any) => edge.source === source)).toEqual([{ source, target, type: "wikilink" }]);
        expect(graph.missing_targets.filter((edge: any) => edge.source === source)).toEqual([]);
        const current = await (await request.get(`/api/wiki/pages/${source}`)).json();
        expect(current.markdown).toBe(markdown);
        expect(current.excerpt).toContain("Visible companion");
        expect(current.excerpt).toContain("Later companion");
        expect(current.excerpt).not.toContain("Block example");
        const backlinks = await (await request.get(`/api/wiki/pages/${target}/backlinks`)).json();
        expect(backlinks.backlinks.some((item: any) => item.id === source)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await check();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      markdown = markdown.replace("\n<!-- unfinished block", "\nAn intentional synthetic edit.\n\n<!-- unfinished block");
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await check(); await page.reload(); await check();
      expect((await (await request.get(`/api/wiki/pages/${source}/history`)).json()).history).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`unclosed-inline-comment-${width}.png`), fullPage: true });
      await page.locator(".prose").getByRole("link", { name: "Visible companion", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Synthetic visible destination");
      await page.goBack(); await check();
    } finally {
      for (const id of created.reverse()) {
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        const response = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`short inline comments retain visible wiki links (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const token = randomUUID(), source = `short-comment-source-${token}`;
    const visible = `short-comment-visible-${token}`, hidden = `short-comment-hidden-${token}`;
    const created: string[] = [];
    const save = async (id: string, markdown: string) => {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown, base_revision: null, request_id: randomUUID() } });
      expect(response.ok()).toBe(true); created.push(id); return response.json();
    };
    let markdown = `# Synthetic short annotations\n\nInline<!-->[[${visible}|Short companion]].\n\nInline<!--->[[${visible}|Dash companion]].\n\nNormal<!-- annotation -->[[${visible}|Normal companion]].\n\n<!-->[[${hidden}|Block suffix]]\n\nCode \`<!-->[[${hidden}|Code example]]\`.\n`;
    try {
      await save(visible, "# Synthetic visible destination");
      await save(hidden, "# Synthetic literal destination");
      await save(source, markdown);
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic short annotations");
      const check = async () => {
        for (const name of ["Short companion", "Dash companion", "Normal companion"]) {
          await expect(page.locator(".prose").getByRole("link", { name, exact: true })).toHaveCount(1);
        }
        await expect(page.locator(`.prose [data-wiki-target="${hidden}"]`)).toHaveCount(0);
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: any) => edge.source === source)).toEqual([{ source, target: visible, type: "wikilink" }]);
        expect(graph.missing_targets.filter((edge: any) => edge.source === source)).toEqual([]);
        const current = await (await request.get(`/api/wiki/pages/${source}`)).json();
        expect(current.markdown).toBe(markdown);
        expect(current.excerpt).toContain("Short companion");
        expect(current.excerpt).toContain("Dash companion");
        expect(current.excerpt).not.toContain("Block suffix");
        const backlinks = await (await request.get(`/api/wiki/pages/${visible}/backlinks`)).json();
        expect(backlinks.backlinks.some((item: any) => item.id === source)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await check();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      markdown += "\nAn intentional synthetic edit.\n";
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await check(); await page.reload(); await check();
      expect((await (await request.get(`/api/wiki/pages/${source}/history`)).json()).history).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`short-inline-comment-${width}.png`), fullPage: true });
      await page.locator(".prose").getByRole("link", { name: "Short companion", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Synthetic visible destination");
      await page.goBack(); await check();
    } finally {
      for (const id of created.reverse()) {
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        const response = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`block comment closing lines cannot publish phantom links (${width})`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const token = randomUUID(), source = `comment-source-${token}`;
    const hidden = `comment-hidden-${token}`, visible = `comment-visible-${token}`;
    const created: string[] = [];
    const save = async (id: string, markdown: string) => {
      const response = await request.post(`/api/wiki/pages/${id}`, { data: { markdown, base_revision: null, request_id: randomUUID() } });
      expect(response.ok()).toBe(true); created.push(id); return response.json();
    };
    let markdown = `# Synthetic comment boundary\n\n<!-- An annotation -->[[${hidden}|Hidden suffix]]\n\n<!-- A multiline annotation\n# Literal example\n[[comment-body-absent]]\n\n-->[[comment-closing-absent]]\n\nVisible [[${visible}|Visible companion]].\n\nInline <!-- annotation -->[[${visible}|Inline companion]].\n`;
    try {
      await save(hidden, "# Synthetic hidden companion");
      await save(visible, "# Synthetic visible companion");
      await save(source, markdown);
      await page.goto(`/wiki/${source}`);
      await expect(page.locator("article > h1")).toHaveText("Synthetic comment boundary");
      const check = async () => {
        const prose = page.locator(".prose");
        await expect(prose.getByRole("link", { name: "Visible companion", exact: true })).toHaveCount(1);
        await expect(prose.getByRole("link", { name: "Inline companion", exact: true })).toHaveCount(1);
        await expect(prose.locator(`[data-wiki-target="${hidden}"]`)).toHaveCount(0);
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: any) => edge.source === source)).toEqual([{ source, target: visible, type: "wikilink" }]);
        expect(graph.missing_targets.filter((edge: any) => edge.source === source)).toEqual([]);
        const current = await (await request.get(`/api/wiki/pages/${source}`)).json();
        expect(current.markdown).toBe(markdown);
        expect(current.excerpt).not.toContain("Hidden suffix");
        expect(current.excerpt).not.toContain("comment-closing-absent");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await check();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      markdown += "\nAn intentional synthetic edit.\n";
      await page.locator("#editor").fill(markdown);
      await page.getByRole("button", { name: "Save changes →", exact: true }).click();
      await expect(page.locator(".notice")).toContainText("Saved locally");
      await check(); await page.reload(); await check();
      expect((await (await request.get(`/api/wiki/pages/${source}/history`)).json()).history).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`comment-boundary-${width}.png`), fullPage: true });
      await page.locator(".prose").getByRole("link", { name: "Inline companion", exact: true }).click();
      await expect(page.locator("article > h1")).toHaveText("Synthetic visible companion");
      await page.goBack(); await check();
    } finally {
      for (const id of created.reverse()) {
        const current = await (await request.get(`/api/wiki/pages/${id}`)).json();
        const response = await request.delete(`/api/wiki/pages/${id}`, { data: { base_revision: current.revision, request_id: randomUUID() } });
        expect(response.ok()).toBe(true);
      }
    }
  });
}

