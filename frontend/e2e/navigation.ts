import { expect, Page } from "@playwright/test";

// Reach the library through its visible navigation. Home first resolves the
// browser's start page; only the article's explicit All pages link opens cards.
export async function openAllPages(page: Page) {
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const allPages = page.getByRole("link", { name: "← All pages", exact: true });
  await expect(page.locator(".toolbar a[href='/?overview=1'], .library").first()).toBeVisible();
  if (await allPages.isVisible()) await allPages.click();
  await expect(page.getByRole("heading", { name: "A growing collection", exact: true })).toBeVisible();
}
