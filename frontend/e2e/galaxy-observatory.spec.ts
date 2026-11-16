import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  test(`galaxy observatory frame and inspector remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy?page=archive-method");

    const stage = page.locator(".galaxy-stage");
    await expect(stage.locator("canvas")).toBeVisible();
    const frame = await stage.evaluate(element => {
      const style = getComputedStyle(element, "::after");
      const bounds = element.getBoundingClientRect();
      return {
        display: style.display,
        pointerEvents: style.pointerEvents,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        radius: style.borderRadius,
        width: bounds.width,
        height: bounds.height,
        clientWidth: element.clientWidth,
      };
    });
    expect(frame.display).not.toBe("none");
    expect(frame.pointerEvents).toBe("none");
    expect(parseFloat(frame.borderWidth)).toBeGreaterThan(0);
    expect(frame.borderStyle).toBe("solid");
    expect(frame.radius).not.toBe("0px");
    expect(frame.width).toBeGreaterThan(280);
    expect(frame.height).toBeGreaterThan(350);
    expect(frame.clientWidth).toBeGreaterThan(250);

    const star = page.locator('.galaxy-star[tabindex="0"]');
    const id = await star.getAttribute("data-node");
    expect(id).toBeTruthy();
    await star.focus();
    await expect(star).toBeFocused();
    await page.keyboard.press("Enter");
    const inspector = page.locator(".galaxy-selected-heading");
    await expect(inspector).toBeVisible();
    const article = inspector.locator(".galaxy-article");
    await expect(article).toHaveAttribute("data-open", id!);
    await expect(article).toBeFocused();
    const card = await inspector.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundImage,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        radius: style.borderRadius,
      };
    });
    expect(card.background).not.toBe("none");
    expect(parseFloat(card.borderWidth)).toBeGreaterThan(0);
    expect(card.borderStyle).toBe("solid");
    expect(card.radius).not.toBe("0px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Keep the full-page review image free of fixed focus overlays; focus was asserted above.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.screenshot({ path: info.outputPath(`galaxy-observatory-${width}.png`), fullPage: true });
  });
}

test("observatory frame and selected page retain system colors", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Forced-colors emulation is verified in Chromium.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/galaxy?page=archive-method");

  const palette = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "CanvasText";
    const ink = getComputedStyle(probe).color;
    probe.style.backgroundColor = "Canvas";
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { ink, canvas };
  });
  const frame = await page.locator(".galaxy-stage").evaluate(element => {
    const style = getComputedStyle(element, "::after");
    return { borderColor: style.borderTopColor, background: style.backgroundImage, pointerEvents: style.pointerEvents };
  });
  expect(frame.borderColor).toBe(palette.ink);
  expect(frame.background).toBe("none");
  expect(frame.pointerEvents).toBe("none");

  const star = page.locator(".galaxy-star").first();
  await star.focus();
  await page.keyboard.press("Enter");
  const inspector = await page.locator(".galaxy-selected-heading").evaluate(element => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderTopColor, background: style.backgroundColor };
  });
  expect(inspector.borderColor).toBe(palette.ink);
  expect(inspector.background).toBe(palette.canvas);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test("desktop overview arranges one to six curated constellations as an open sky", async ({ page, request }, info) => {
  const prefix = `open-sky-${randomUUID()}`;
  const baselineResponse = await request.get("/api/wiki/graph");
  expect(baselineResponse.ok()).toBe(true);
  const baseline = await baselineResponse.json();
  const baselineGroups = (baseline.groups || []).filter((group: any) => !group.isolated);
  const extraGroups = Math.max(0, 6 - baselineGroups.length);
  const owned: string[] = [];

  try {
    for (let index = 0; index < extraGroups; index++) {
      const coreId = `${prefix}-core-${index}`;
      const memberId = `${prefix}-member-${index}`;
      const nextCore = extraGroups > 1 ? `${prefix}-core-${(index + 1) % extraGroups}` : null;
      owned.push(coreId, memberId);
      const metadata = `galaxy_group: ${prefix}-group-${index}\ngalaxy_label: Open sky group ${index + 1}\n`;
      const coreLinks = [`[[${memberId}]]`, ...(nextCore ? [`[[${nextCore}]]`] : [])].join("\n");
      const core = await request.post(`/api/wiki/pages/${coreId}`, { data: {
        markdown: `---\n${metadata}galaxy_anchor: true\n---\n# Open sky core ${index + 1}\n\n${coreLinks}\n`,
        base_revision: null, request_id: randomUUID(),
      } });
      expect(core.ok()).toBe(true);
      const member = await request.post(`/api/wiki/pages/${memberId}`, { data: {
        markdown: `---\n${metadata}---\n# Open sky page ${index + 1}\n\n[[${coreId}]]\n`,
        base_revision: null, request_id: randomUUID(),
      } });
      expect(member.ok()).toBe(true);
    }

    const currentResponse = await request.get("/api/wiki/graph");
    expect(currentResponse.ok()).toBe(true);
    const current = await currentResponse.json();
    expect((current.groups || []).filter((group: any) => !group.isolated).length).toBeGreaterThanOrEqual(6);

    // Use subsets of the real API snapshot: no node or edge is fabricated.
    // This exercises every supported overview count against the same real groups.
    let visibleCount = 1;
    let visibleNodeCount = 0;
    await page.route("**/api/wiki/graph", async route => {
      const response = await route.fetch();
      const body = await response.json();
      const groups = (body.groups || []).filter((group: any) => !group.isolated).slice(0, visibleCount);
      const visibleIds = new Set<string>(groups.flatMap((group: any) => group.members));
      visibleNodeCount = visibleIds.size;
      body.groups = groups.map((group: any, id: number) => ({ ...group, id }));
      body.nodes = body.nodes.filter((node: any) => visibleIds.has(node.id));
      body.edges = body.edges.filter((edge: any) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
      body.missing_targets = (body.missing_targets || []).filter((edge: any) => visibleIds.has(edge.source));
      body.ambiguous_targets = (body.ambiguous_targets || []).filter((edge: any) => visibleIds.has(edge.source));
      await route.fulfill({ response, json: body });
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    for (let count = 1; count <= 6; count++) {
      visibleCount = count;
      await page.goto("/galaxy");
      const stage = page.locator(".galaxy-stage");
      await expect(page.locator(".galaxy-cluster")).toHaveCount(count);
      await expect(stage.locator("canvas")).toBeVisible();
      await expect(stage.locator(".galaxy-star")).toHaveCount(visibleNodeCount);

      const centers = await stage.locator(".galaxy-star.is-core").evaluateAll(elements => elements.map(element => {
        const box = (element as HTMLElement).getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      }));
      expect(centers).toHaveLength(count);
      expect(new Set(centers.map(point => `${point.x},${point.y}`)).size).toBe(count);
      const stageBox = (await stage.boundingBox())!;
      expect(centers.every(point => point.x >= stageBox.x && point.x <= stageBox.x + stageBox.width && point.y >= stageBox.y && point.y <= stageBox.y + stageBox.height)).toBe(true);

      if (count === 6) {
        const labels = await page.locator(".galaxy-cluster").evaluateAll(elements => elements.map(element => element.textContent || ""));
        expect(labels).toHaveLength(6);
        expect(labels.every(label => label.trim().length > 0)).toBe(true);
        await page.screenshot({ path: info.outputPath("open-sky-six-groups-1440.png"), fullPage: true });
      }
    }

    visibleCount = 6;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-cluster")).toHaveCount(6);
    await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
    await expect(page.locator(".galaxy-star")).toHaveCount(visibleNodeCount);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    for (const id of owned.reverse()) {
      const currentPage = await request.get(`/api/wiki/pages/${id}`);
      if (currentPage.ok()) {
        const pageData = await currentPage.json();
        const removed = await request.delete(`/api/wiki/pages/${id}`, {
          data: { base_revision: pageData.revision, request_id: randomUUID() },
        });
        expect(removed.ok()).toBe(true);
      }
    }
  }
});
