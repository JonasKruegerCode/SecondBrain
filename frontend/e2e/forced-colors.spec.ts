import { expect, Locator, Page } from "@playwright/test";
import { test } from "./reading-test";

// Resolve the browser's actual palette: forced light and forced dark use
// different system colors, and operating-system palettes need not match ours.
async function systemPalette(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.forcedColorAdjust = "none";
    document.body.append(probe);
    const resolve = (color: string) => {
      probe.style.color = color;
      return getComputedStyle(probe).color;
    };
    const palette = { canvas: resolve("Canvas"), ink: resolve("CanvasText"), highlight: resolve("Highlight"), link: resolve("LinkText") };
    probe.remove();
    return palette;
  });
}

async function visibleSystemMark(locator: Locator, property: "fill" | "stroke", colors: string[]) {
  await expect(locator).toBeAttached();
  const mark = await locator.evaluate((element, property) => {
    const style = getComputedStyle(element);
    const lineLength = element instanceof SVGLineElement ? element.getTotalLength() : null;
    return { color: style.getPropertyValue(property), opacity: Number(style.getPropertyValue(`${property}-opacity`)),
      width: parseFloat(style.strokeWidth), opacityOverall: Number(style.opacity),
      display: style.display, visibility: style.visibility, lineLength };
  }, property);
  expect(mark.display).not.toBe("none");
  expect(mark.visibility).toBe("visible");
  if (mark.lineLength !== null) expect(mark.lineLength).toBeGreaterThan(0);
  else await expect(locator).toBeVisible();
  expect(colors, `${property} must use the active system palette`).toContain(mark.color);
  expect(mark.opacity * mark.opacityOverall, `${property} must remain legible`).toBeGreaterThanOrEqual(.8);
  if (property === "stroke") expect(mark.width).toBeGreaterThan(0);
}

async function visibleSelection(locator: Locator, colors: string[]) {
  const indicator = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return [
      { color: style.outlineColor, width: parseFloat(style.outlineWidth), style: style.outlineStyle },
      { color: style.borderTopColor, width: parseFloat(style.borderTopWidth), style: style.borderTopStyle },
      { color: style.borderBottomColor, width: parseFloat(style.borderBottomWidth), style: style.borderBottomStyle },
    ];
  });
  expect(indicator.some(mark => mark.width > 0 && !["none", "hidden"].includes(mark.style) && colors.includes(mark.color)),
    "selection must survive without a background-color highlight").toBe(true);
}

for (const width of [390, 1440]) {
  test(`forced colors preserve galaxy reading and keyboard entry at ${width}px`, async ({ page, request, browserName }, testInfo) => {
    test.skip(browserName !== "chromium", "Forced-colors media emulation is verified in Chromium; WebKit does not support this profile.");
    await page.setViewportSize({ width, height: 1000 });
    const originalResponse = await request.get("/api/wiki/graph");
    expect(originalResponse.ok()).toBe(true);
    const originalGraph = await originalResponse.json();
    expect(originalGraph.nodes.some((node: { id: string }) => node.id === "tide-clock")).toBe(true);
    expect(originalGraph.edges.length).toBeGreaterThan(0);

    for (const colorScheme of ["light", "dark"] as const) {
      await test.step(`${colorScheme} system palette`, async () => {
        await page.emulateMedia({ forcedColors: "active", colorScheme });
        await page.goto("/galaxy");
        expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
        expect(await page.evaluate(scheme => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme)).toBe(true);
        const palette = await systemPalette(page);
        expect(palette.ink).not.toBe(palette.canvas);
        const ink = [palette.ink, palette.highlight].filter(color => color !== palette.canvas);
        await expect(page.getByRole("heading", { name: "Follow a connection.", exact: true })).toBeVisible();
        const nav = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Galaxy", exact: true });
        await expect(nav).toHaveAttribute("aria-current", "page");
        await visibleSelection(nav, [...ink, palette.link]);
        await visibleSystemMark(page.locator(".galaxy-neighborhood text:not(.galaxy-count)").first(), "fill", ink);
        await visibleSystemMark(page.locator(".galaxy-edge").first(), "stroke", ink);
        await visibleSystemMark(page.locator(".galaxy-star .galaxy-dot").first(), "fill", ink);

        await page.getByRole("button", { name: /^Sky & navigation/ }).click();
        const star = page.locator('.galaxy-star[data-node="tide-clock"]');
        await star.focus();
        await expect(star).toBeFocused();
        // Enter selects the real page and transfers focus to its article link.
        await page.keyboard.press("Enter");
        await expect(star).toHaveClass(/is-selected/);
        const article = page.getByRole("link", { name: "Open article", exact: false });
        await expect(article).toBeFocused();
        await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Tide clock project");
        await visibleSystemMark(star.locator(".galaxy-dot"), "fill", ink);
        await visibleSystemMark(star.locator(".galaxy-glow"), "stroke", ink);
        await visibleSystemMark(star.locator("text"), "fill", ink);
        await visibleSystemMark(page.locator(".galaxy-edge.is-active").first(), "stroke", ink);
        const list = page.getByRole("button", { name: "List view", exact: true });
        await list.click();
        const selectedControl = page.getByRole("button", { name: "Map view", exact: true });
        await expect(selectedControl).toHaveAttribute("aria-pressed", "true");
        await selectedControl.blur();
        await visibleSelection(selectedControl, [palette.highlight]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await selectedControl.click();
        // The selected dot remains distinguishable even after focus leaves it.
        await visibleSystemMark(star.locator(".galaxy-dot"), "fill", ink);
        await page.screenshot({ path: testInfo.outputPath(`forced-colors-${colorScheme}-${width}.png`), fullPage: true });
        await article.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/wiki\/tide-clock$/);
        await expect(page.locator("article h1")).toHaveText("Tide clock project");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
    const finalResponse = await request.get("/api/wiki/graph");
    expect(finalResponse.ok()).toBe(true);
    expect(await finalResponse.json()).toEqual(originalGraph);
  });
}
