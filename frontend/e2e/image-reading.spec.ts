import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

for (const width of [390, 1440]) {
  test(`Markdown images remain readable and inert at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = `image-reading-${randomUUID()}`;
    const endpoint = `/api/wiki/pages/${encodeURIComponent(id)}`;
    // Served by the real Vite server; its intrinsic width exceeds both viewports.
    const widePath = "/e2e/fixtures/image-reading.svg";
    // A nonexistent backend route gives a real 404; Vite serves SPA HTML for
    // unknown frontend paths, which is a decode failure rather than an HTTP 404.
    const missingPath = `/api/wiki/__synthetic_missing_image_${randomUUID()}.png`;
    const host = new URL(testInfo.project.use.baseURL || "http://127.0.0.1:5173").host;
    const markdown = [
      "# Synthetic image reading", "",
      `![Synthetic wide image with three green bands](${widePath})`, "",
      '<p>Image without alternative text <img src="/app-icon.svg" width="99999" height="1" style="position:fixed;width:99999px" onload="window.__syntheticImageExecuted = true"></p>', "",
      `<p>Missing image <img src="${missingPath}" alt="Synthetic unavailable image description" onerror="window.__syntheticImageExecuted = true"></p>`, "",
      '<p>Rejected data image <img src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E" alt="Unsafe data image"></p>', "",
      '<p>Rejected script image <img src="javascript:window.__syntheticImageExecuted=true" alt="Unsafe script image"></p>', "",
      `<p>Rejected protocol relative image <img src="//${host}/app-icon.svg" alt="Unsafe protocol relative image"></p>`, "",
      '<script>window.__syntheticImageExecuted = true</script>', "",
      "Ordinary text after the images remains readable.", "",
    ].join("\n");
    const errors: string[] = [];
    const missingStatuses: number[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      if (new URL(response.url()).pathname === missingPath) missingStatuses.push(response.status());
    });
    let created = false;
    try {
      const response = await request.post(endpoint, { data: {
        markdown, base_revision: null, request_id: randomUUID(),
      } });
      expect(response.ok()).toBeTruthy();
      created = true;
      await page.goto(`/wiki/${id}`);

      const assertReading = async () => {
        const prose = page.locator(".prose");
        const wide = prose.getByRole("img", { name: "Synthetic wide image with three green bands", exact: true });
        await wide.scrollIntoViewIfNeeded();
        await expect(wide).toBeVisible();
        await expect(wide).toHaveAttribute("src", new URL(widePath, page.url()).href);
        await expect(wide).toHaveAttribute("loading", "lazy");
        await expect.poll(() => wide.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(2400);
        const dimensions = await wide.evaluate(el => {
          const image = el as HTMLImageElement;
          const bounds = image.getBoundingClientRect();
          const container = image.closest(".prose")!.getBoundingClientRect();
          return {
            width: bounds.width, height: bounds.height,
            naturalHeight: image.naturalHeight,
            left: bounds.left, right: bounds.right,
            containerLeft: container.left, containerRight: container.right,
          };
        });
        expect(dimensions.naturalHeight).toBe(600);
        expect(dimensions.width).toBeGreaterThan(0);
        expect(dimensions.width).toBeLessThan(2400);
        expect(dimensions.left).toBeGreaterThanOrEqual(dimensions.containerLeft - 1);
        expect(dimensions.right).toBeLessThanOrEqual(dimensions.containerRight + 1);
        expect(Math.abs(dimensions.height - dimensions.width / 4)).toBeLessThanOrEqual(1);

        const withoutAlt = prose.locator("p").filter({ hasText: "Image without alternative text" }).locator("img");
        await withoutAlt.scrollIntoViewIfNeeded();
        await expect(withoutAlt).toHaveAttribute("src", new URL("/app-icon.svg", page.url()).href);
        await expect(withoutAlt).toHaveAttribute("alt", "");
        await expect(withoutAlt).toHaveAttribute("loading", "lazy");
        await expect.poll(() => withoutAlt.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        await expect(prose.locator("p").filter({ hasText: "Image without alternative text" })).toBeVisible();

        const missing = prose.getByRole("img", { name: "Synthetic unavailable image description", exact: true });
        await missing.scrollIntoViewIfNeeded();
        await expect(missing).toHaveAttribute("src", new URL(missingPath, page.url()).href);
        await expect(missing).toHaveAttribute("loading", "lazy");
        await expect.poll(() => missing.evaluate(el => (el as HTMLImageElement).complete)).toBe(true);
        expect(await missing.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(0);
        await expect.poll(() => missingStatuses).toContain(404);
        await expect(missing).toBeVisible();

        for (const label of ["Rejected data image", "Rejected script image", "Rejected protocol relative image"]) {
          const rejected = prose.locator("p").filter({ hasText: label }).locator("img");
          await expect(rejected).toHaveCount(1);
          await expect(rejected).not.toHaveAttribute("src");
        }
        await expect(prose.locator("script, img[width], img[height], img[style]")).toHaveCount(0);
        expect(await prose.locator("img").evaluateAll(images => images.flatMap(image =>
          Array.from(image.attributes).filter(attribute => /^on/i.test(attribute.name)).map(attribute => attribute.name),
        ))).toEqual([]);
        expect(await page.evaluate(() => "__syntheticImageExecuted" in window)).toBe(false);
        await expect(prose.getByText("Ordinary text after the images remains readable.", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      };

      await assertReading();
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await assertReading();
      await page.screenshot({ path: testInfo.outputPath(`image-reading-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
      await expect(page.locator("#editor")).toHaveValue(markdown);
      const saved = await request.get(endpoint);
      expect(saved.ok()).toBeTruthy();
      expect((await saved.json()).markdown).toBe(markdown);
      expect(errors).toEqual([]);
    } finally {
      if (created) {
        const current = await request.get(endpoint);
        expect(current.ok()).toBeTruthy();
        const saved = await current.json();
        const deleted = await request.delete(endpoint, { data: {
          base_revision: saved.revision, request_id: randomUUID(),
        } });
        expect(deleted.ok()).toBeTruthy();
      }
    }
  });
}
