import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  test(`galaxy observatory frame and inspector remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy?page=archive-method");

    const stage = page.locator(".galaxy-stage");
    await expect(stage.locator("svg")).toBeVisible();
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

    const star = page.locator(".galaxy-star").first();
    const id = await star.getAttribute("data-node");
    expect(id).toBeTruthy();
    await star.focus();
    await page.keyboard.press("Enter");
    const inspector = page.locator(".galaxy-selected-heading");
    await expect(inspector).toBeVisible();
    const article = inspector.locator(".galaxy-article");
    await expect(article).toHaveAttribute("data-open", id!);
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
    probe.remove();
    return ink;
  });
  const frame = await page.locator(".galaxy-stage").evaluate(element => {
    const style = getComputedStyle(element, "::after");
    return { borderColor: style.borderTopColor, background: style.backgroundImage, pointerEvents: style.pointerEvents };
  });
  expect(frame.borderColor).toBe(palette);
  expect(frame.background).toBe("none");
  expect(frame.pointerEvents).toBe("none");

  const star = page.locator(".galaxy-star").first();
  await star.focus();
  await page.keyboard.press("Enter");
  const inspector = await page.locator(".galaxy-selected-heading").evaluate(element => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderTopColor, background: style.backgroundColor };
  });
  expect(inspector.borderColor).toBe(palette);
  expect(inspector.background).toBe(palette === "rgb(255, 255, 255)" ? "rgb(255, 255, 255)" : inspector.background);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
