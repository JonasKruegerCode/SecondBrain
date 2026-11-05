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
  expect(coverage.bottom).toBeGreaterThanOrEqual(coverage.height);
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
    const rings = page.locator(".galaxy-orbits");
    expect(await rings.count()).toBeGreaterThan(0);
    for (const ring of await rings.all()) {
      await expect(ring).toHaveAttribute("aria-hidden", "true");
      expect(await ring.evaluate(node => getComputedStyle(node).pointerEvents)).toBe("none");
    }
    expect(await page.locator(".galaxy-orbit-inner").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === "none"))).toBe(true);
    await page.screenshot({ path: info.outputPath(`orbital-overview-${width}.png`), fullPage: true, animations: "disabled" });
    await page.locator(".galaxy-cluster").first().click();
    await expect(page.locator(".galaxy-orbit-inner")).toHaveCount(1);
    expect(await page.locator(".galaxy-orbit-inner").evaluate(node => getComputedStyle(node).animationName)).toBe("orbit-instrument");
    await stars.first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading")).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(rings).toBeHidden();
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
    await expect(rings).toBeHidden();
    expect(await page.locator(".galaxy-region").first().evaluate(node => getComputedStyle(node).fill)).toBe("none");
    // Activation deliberately moves focus to the inspector. Re-enter a star
    // before checking its native high-contrast keyboard indicator.
    await stars.first().focus();
    await expect(stars.first()).toBeFocused();
    expect(await page.locator(".galaxy-star:focus-visible .galaxy-hit").count()).toBeGreaterThan(0);
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
      await expect.poll(async () => page.locator(".galaxy-stage svg").evaluate(svg => {
        const bounds = svg.getBoundingClientRect();
        const labels = [...svg.querySelectorAll<SVGTextElement>(".galaxy-neighborhood text")].map(node => node.getBoundingClientRect());
        return labels.every(r => r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom)
          && labels.every((r, i) => labels.slice(i + 1).every(b => r.right <= b.left || b.right <= r.left || r.bottom <= b.top || b.bottom <= r.top));
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
