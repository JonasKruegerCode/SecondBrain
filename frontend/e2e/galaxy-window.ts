import { expect, Page, TestInfo } from "@playwright/test";

export async function checkTallOverview(page: Page, testInfo: TestInfo) {
  const camera = () => page.locator(".galaxy-stage").evaluate(element =>
    `${element.getAttribute("data-zoom")}|${element.getAttribute("data-pan")}`);
  for (const width of [390, 320, 1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".galaxy-stage canvas")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`tall-overview-${width}.png`), fullPage: true });
  }
  const stage = page.locator(".galaxy-stage");
  await stage.scrollIntoViewIfNeeded();
  const before = await camera();
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height * .8);
  await page.mouse.down();
  await page.mouse.move(box.x + 8, box.y + box.height * .2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(camera).not.toBe(before);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();

  const last = page.locator(".galaxy-star.is-core").last();
  const id = await last.getAttribute("data-node");
  await last.focus();
  await expect(last).toBeFocused();
  const inside = await last.evaluate(element => {
    const star = element.getBoundingClientRect();
    const map = element.closest(".galaxy-stage")!.getBoundingClientRect();
    return star.left >= map.left && star.right <= map.right && star.top >= map.top && star.bottom <= map.bottom;
  });
  expect(inside, "keyboard focus must reveal the last core").toBe(true);
  await page.screenshot({ path: testInfo.outputPath("tall-overview-last-core.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toHaveAttribute("data-open", id!);
  await page.getByRole("button", { name: "All constellations" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".galaxy-breadcrumb")).toContainText("Galaxy");
}
