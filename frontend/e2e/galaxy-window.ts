import { expect, Page, TestInfo } from "@playwright/test";

export async function checkTallOverview(page: Page, testInfo: TestInfo) {
  const metrics = () => page.locator(".galaxy-stage svg").evaluate(element => {
    const svg = element as SVGSVGElement, bounds = svg.getBoundingClientRect();
    const labels = [...svg.querySelectorAll<SVGTextElement>(".galaxy-neighborhood text")];
    const boxes = labels.map(label => label.getBoundingClientRect());
    const visible = boxes.filter(box => box.top >= bounds.top && box.bottom <= bounds.bottom);
    return {
      smallest: Math.min(...labels.map(label => parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM()!.a)),
      visible: visible.length,
      clipped: visible.length < labels.length,
      inside: visible.every(box => box.left >= bounds.left && box.right <= bounds.right),
      distinct: visible.every((box, i) => visible.slice(i + 1).every(other => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top)),
    };
  });
  for (const width of [390, 320, 1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(async () => {
      const result = await metrics();
      return Math.abs(result.smallest - 11) < .01 && result.visible >= 4 && result.clipped && result.inside && result.distinct;
    }).toBe(true);
    await expect(page.locator(".galaxy-breadcrumb")).toContainText("Overview window");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`tall-overview-${width}.png`), fullPage: true });
  }
  // Pan moves the retained world; it must not discard offscreen cores or links.
  const stage = page.locator(".galaxy-stage");
  await stage.scrollIntoViewIfNeeded();
  const before = await page.locator(".galaxy-stage svg").getAttribute("viewBox");
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height * .8);
  await page.mouse.down();
  await page.mouse.move(box.x + 8, box.y + box.height * .2, { steps: 8 });
  await page.mouse.up();
  expect(await page.locator(".galaxy-stage svg").getAttribute("viewBox")).not.toBe(before);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect((await metrics()).distinct).toBe(true);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();

  const last = page.locator(".galaxy-star.is-core").last();
  const id = await last.getAttribute("data-node");
  await last.focus();
  await expect(last).toBeFocused();
  expect(await last.evaluate(element => {
    const star = element as SVGGraphicsElement, bounds = star.ownerSVGElement!.getBoundingClientRect();
    const point = new DOMPoint(0, 0).matrixTransform(star.getScreenCTM()!);
    return point.x >= bounds.left + 26 && point.x <= bounds.right - 26 && point.y >= bounds.top + 25.9 && point.y <= bounds.bottom - 25.9;
  }), "keyboard focus must reveal the last core").toBe(true);
  await page.screenshot({ path: testInfo.outputPath("tall-overview-last-core.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id!);
  await page.getByRole("button", { name: "All constellations" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".galaxy-breadcrumb")).toContainText("Overview window");
}
