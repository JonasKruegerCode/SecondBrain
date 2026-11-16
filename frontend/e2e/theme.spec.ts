import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [320, 390, 1440]) {
  test(`light shell keeps real reading views usable with reduced motion (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const [route, ready, name] of [
      ["/?overview=1", ".card", "overview"],
      ["/wiki/home", ".prose", "article"],
      ["/galaxy", ".galaxy-stage", "galaxy"],
      ["/search", "#results", "search"],
      ["/chat", ".chat-composer", "chat"],
    ]) {
      await page.goto(route);
      await expect(page.locator(ready).first()).toBeVisible();
      const layout = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        ambientAnimations: ["::before", "::after"].map(pseudo =>
          getComputedStyle(document.querySelector(".ambient")!, pseudo).animationName),
      }));
      expect(layout.width).toBeLessThanOrEqual(width);
      for (const link of await page.locator("header nav a").all()) {
        expect(await link.evaluate(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return range.getClientRects().length;
        }), "navigation names should not break mid-word at default text size").toBe(1);
      }
      expect(layout.ambientAnimations).toEqual(["none", "none"]);
      if (width === 1440 && name === "article") {
        const article = await page.locator("main > article").boundingBox();
        expect(article!.width).toBeGreaterThanOrEqual(1100);
        const prose = await page.locator(".prose").boundingBox();
        expect(prose!.width).toBeGreaterThan(800);
        expect(prose!.width).toBeLessThanOrEqual(article!.width - 80);
      }
      // Real API-backed views; screenshots contain only the synthetic demo.
      await page.screenshot({ path: info.outputPath(`light-shell-${name}-${width}.png`), fullPage: true });
      await page.locator('header nav a[href="/search"]').focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
    }
  });
}

test("material atmosphere covers the full article and reactive light respects motion preferences", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/wiki/home");
  await expect(page.locator(".prose")).toBeVisible();
  const coverage = await page.locator(".ambient").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top + scrollY, bottom: rect.bottom + scrollY, height: document.documentElement.scrollHeight };
  });
  expect(coverage.top).toBe(0);
  // scrollHeight is an integer CSS-pixel extent, while DOMRect retains
  // subpixel layout precision (e.g. 1570.84375 versus 1571 in WebKit).
  expect(Math.ceil(coverage.bottom)).toBeGreaterThanOrEqual(coverage.height);
  const button = page.locator(".toolbar .primary");
  await button.hover();
  await expect.poll(() => button.evaluate(node => node.style.getPropertyValue("--light-x"))).not.toBe("");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => button.evaluate(node => node.style.getPropertyValue("--light-x"))).toBe("");
  expect(await button.evaluate(node => getComputedStyle(node, "::before").display)).toBe("none");
  await page.screenshot({ path: info.outputPath("material-long-article.png"), fullPage: true });
});

for (const width of [390, 1440]) {
  test(`orbital instruments keep page targets and motion bounded (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/galaxy");
    const stars = page.locator(".galaxy-star");
    await expect(stars.first()).toBeVisible();
    const initialIds = await stars.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-node")).sort());
    expect(new Set(initialIds).size).toBe(initialIds.length);
    const field = page.locator(".galaxy-stage canvas");
    await expect(field).toHaveAttribute("aria-hidden", "true");
    await page.screenshot({ path: info.outputPath(`orbital-overview-${width}.png`), fullPage: true, animations: "disabled" });
    await page.locator(".galaxy-cluster").first().click();
    await expect(page.locator(".galaxy-sidebar-content .galaxy-page").first()).toBeVisible();
    await stars.first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading")).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(field).toBeVisible();
    expect(await stars.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-node")).sort())).toEqual(initialIds);
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
    await expect(stars.first()).toBeVisible();
    await stars.first().focus();
    await expect(stars.first()).toBeFocused();
    expect(await stars.first().evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none");
  });
}

test("small overview composition preserves fixture identities and readable labels through layout changes", async ({ page }, info) => {
  // Explicit renderer fixture, separate from the real API/graph mutation cases.
  let count = 1;
  await page.route("**/api/wiki/graph", route => {
    const groups = Array.from({ length: count }, (_, id) => ({ id, core: `fixture-${id}-core`, members: [`fixture-${id}-core`, `fixture-${id}-page`], isolated: false, curated: true, label: `Fictional neighborhood ${id + 1}` }));
    const nodes = [...groups.flatMap(group => group.members.map(id => ({ id, title: id }))), { id: "fixture-unlinked", title: "Fictional unlinked notebook" }];
    const edges = groups.flatMap(group => [
      { source: group.core, target: group.members[1], type: "link" },
      ...(count > 1 ? [{ source: group.core, target: groups[(group.id + 1) % count].core, type: "link" }] : []),
    ]);
    return route.fulfill({ json: { revision: "synthetic-renderer-fixture", nodes, edges, groups: [...groups, { id: count, core: "fixture-unlinked", members: ["fixture-unlinked"], isolated: true, curated: false }] } });
  });
  for (count = 1; count <= 7; count++) {
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-star")).toHaveCount(count * 2 + 1);
    const ids = await page.locator(".galaxy-star").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-node")).sort());
    for (const width of [1440, 1100, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(async () => page.evaluate(() => {
        const bounds = document.querySelector(".galaxy-stage")!.getBoundingClientRect();
        const labels = [...document.querySelectorAll(".galaxy-cluster")].map(node => node.getBoundingClientRect());
        return document.documentElement.scrollWidth <= innerWidth
          && labels.every(r => r.left >= 0 && r.right <= innerWidth && r.top >= bounds.top - innerHeight && r.bottom <= document.documentElement.scrollHeight);
      })).toBe(true);
      expect(await page.locator(".galaxy-star").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-node")).sort())).toEqual(ids);
    }
    if (count === 4) await page.screenshot({ path: info.outputPath("open-sky-four-neighborhoods.png"), fullPage: true });
    await page.locator('.galaxy-star[data-node="fixture-unlinked"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", "fixture-unlinked");
  }
});

test("overview layout switches preserve the keyboard's actual page identity", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/galaxy");
  const core = page.locator(".galaxy-star.is-core").first();
  await expect(core).toBeVisible();
  const id = await core.getAttribute("data-node");
  await core.focus();
  for (const width of [1100, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const restored = page.locator(".galaxy-star");
    await expect.poll(() => restored.evaluateAll((nodes, wanted) => nodes.some(node => node.getAttribute("data-node") === wanted && node === document.activeElement), id)).toBe(true);
  }
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id!);
});

test("desktop reading spread keeps contents reachable without changing mobile section navigation", async ({ page, request }, info) => {
  const id = `reading-spread-${crypto.randomUUID()}`;
  const endpoint = `/api/wiki/pages/${id}`;
  const markdown = "# Fictional field compendium\n\n" + Array.from({ length: 24 }, (_, i) => `## Field section ${i + 1}\n\n${"Synthetic observations, retained exactly as written. ".repeat(35)}\n\n`).join("");
  const created = await request.post(endpoint, { data: { markdown, base_revision: null, request_id: crypto.randomUUID() } });
  expect(created.ok()).toBe(true);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/wiki/${id}`);
    const toc = page.locator(".article-toc");
    const summary = toc.locator("summary");
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(toc.locator("details")).toHaveAttribute("open", "");
    await page.evaluate(() => scrollTo(0, 1500));
    await expect.poll(() => toc.evaluate(node => Math.round(node.getBoundingClientRect().top))).toBe(24);
    const section = toc.getByRole("link", { name: "Field section 8", exact: true });
    await section.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".prose h2").nth(7)).toBeFocused();
    await expect(page.locator(".prose h2").nth(7)).toBeInViewport();
    await page.screenshot({ path: info.outputPath("desktop-reading-spread.png"), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 360 });
    expect((await toc.boundingBox())!.height).toBeLessThanOrEqual(312);
    await page.emulateMedia({ forcedColors: "active" });
    // An explicit CanvasText border must match the engine's system palette,
    // not body ink: WebKit can emulate the media query without forcing text.
    const systemInk = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.cssText = "color:CanvasText;forced-color-adjust:none";
      document.body.append(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      return ink;
    });
    expect(await toc.evaluate(node => getComputedStyle(node).borderLeftColor)).toBe(systemInk);
    await toc.getByRole("link", { name: "Field section 20", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".prose h2").nth(19)).toBeFocused();
    await expect(page.locator(".prose h2").nth(19)).toBeInViewport();
    await page.emulateMedia({ forcedColors: "none" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await toc.evaluate(node => getComputedStyle(node).position)).toBe("static");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await toc.getByRole("link", { name: "Field section 2", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".prose h2").nth(1)).toBeFocused();
    await expect(page.locator(".prose h2").nth(1)).toBeInViewport();
    expect((await (await request.get(endpoint)).json()).markdown).toBe(markdown);
  } finally {
    const current = await (await request.get(endpoint)).json();
    expect((await request.delete(endpoint, { data: { base_revision: current.revision, request_id: crypto.randomUUID() } })).ok()).toBe(true);
  }
});

test("reactive light releases replaced reading controls and yields to keyboard focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/wiki/home");
  const edit = page.locator("#edit");
  await edit.hover();
  await expect.poll(() => edit.evaluate(node => node.style.getPropertyValue("--light-x"))).not.toBe("");
  const previous = await edit.elementHandle();
  await edit.click();
  await expect(page.locator("#editor")).toBeVisible();
  expect(await previous!.evaluate(node => ({ connected: node.isConnected, light: node.style.getPropertyValue("--light-x") }))).toEqual({ connected: false, light: "" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await edit.hover();
  await expect.poll(() => edit.evaluate(node => node.style.getPropertyValue("--light-x"))).not.toBe("");
  await page.keyboard.press("Tab");
  expect(await edit.evaluate(node => node.style.getPropertyValue("--light-x"))).toBe("");
});

for (const width of [390, 1440]) {
  test(`glass controls keep their hit boxes throughout a real press (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/wiki/home");
    const edit = page.locator("#edit");
    await expect(edit).toBeVisible();
    await edit.scrollIntoViewIfNeeded();
    const before = await edit.boundingBox();
    await edit.hover();
    await page.mouse.down();
    try {
      await expect.poll(() => edit.evaluate(node => getComputedStyle(node, "::after").opacity)).not.toBe("0");
      const pressed = await edit.boundingBox();
      expect(pressed).toEqual(before);
    } finally { await page.mouse.up(); }
    await expect(page.locator("#editor")).toBeVisible();
    await expect(edit).toHaveText("Cancel");
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".prose")).toBeVisible();
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`glass-atlas-${width}.png`), fullPage: true, animations: "disabled" });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    const control = page.locator('.galaxy-controls button').first();
    await control.focus();
    expect(await control.evaluate(node => getComputedStyle(node, "::after").display)).toBe("none");
    await expect(control).toBeFocused();
  });
}
