import { test, expect, APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const width of [390, 1440]) {
  test(`keyboard navigation reaches each view's content (${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["Search", "Home", "Galaxy", "Chat"]) {
      await page.goto("/wiki/night-sky-survey");
      await expect(page.locator("article > h1")).toHaveText("Night sky survey");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const link = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true });
      await link.focus();
      await page.keyboard.press("Enter");
      const heading = page.locator("main h1");
      await expect(heading).toBeVisible();
      const observed = await page.evaluate(() => ({ tag: document.activeElement?.tagName, scrollY }));
      console.log(`[view-focus] ${JSON.stringify({ width, name, observed })}`);
      await expect(heading).toBeFocused();
      expect(observed.tag).toBe("H1");
      expect(observed.scrollY).toBe(0);
      if (name === "Chat") await expect(page.locator("#chat-input")).not.toBeFocused();
      await page.screenshot({ path: info.outputPath(`view-focus-${name.toLowerCase()}-${width}.png`) });
      await page.keyboard.press("Tab");
      const next = name === "Search" ? page.getByRole("textbox", { name: "Search pages" }) :
        name === "Home" ? page.getByRole("link", { name: /Open Lantern Bay field atlas/ }) :
        name === "Galaxy" ? page.getByRole("link", { name: "Page overview ↗" }) :
        page.locator("#chat-input");
      await expect(next).toBeFocused();
    }
  });
}

async function create(request: APIRequestContext, markdown: string) {
  const id = `e2e-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, { data: {
    markdown, base_revision: null, request_id: randomUUID(),
  }});
  expect(response.ok()).toBeTruthy();
  return { id, ...(await response.json()) };
}

async function activate(page: Page, name: string) {
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await page.keyboard.press("Enter");
}

test("resolution choices, missing links and real 404s have keyboard destinations", async ({ page, request }) => {
  const owned: string[] = [];
  const add = async (markdown: string) => {
    const result = await create(request, markdown);
    owned.push(result.id);
    return result;
  };
  const title = `Shared reference ${randomUUID()}`;
  try {
    await add(`# ${title}\n\n## Details\n\nFirst synthetic choice.`);
    await add(`# ${title}\n\n## Details\n\nSecond synthetic choice.`);
    const absent = `absent-${randomUUID()}`;
    const source = await add(`# Resolution source\n\n[[${title}#Details|Choose a reference]]\n\n[Unresolved reference](/resolve?target=${absent})\n\n[Deleted article](/wiki/${absent})`);
    await page.goto(`/wiki/${source.id}`);
    await expect(page.getByRole("link", { name: "Choose a reference", exact: true })).toHaveClass(/ambiguous-link/);
    await activate(page, "Choose a reference");
    await expect(page.locator("main h1")).toHaveText("Choose a page.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(".card").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeFocused();
    await page.goBack();
    await expect(page.locator("main h1")).toHaveText("Choose a page.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.goBack();
    await expect(page.locator("article > h1")).toHaveText("Resolution source");
    await activate(page, "Unresolved reference");
    await expect(page.locator("main h1")).toHaveText("A missing page.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Search for this title →" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("Find a thought.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.goto(`/wiki/${source.id}`);
    await activate(page, "Deleted article");
    await expect(page.locator("main h1")).toHaveText("This page is missing.");
    await expect(page.locator("main h1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Back to home →" })).toBeFocused();
  } finally {
    for (const id of owned.reverse()) {
      const latest = await request.get(`/api/wiki/pages/${id}`);
      if (latest.ok()) expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
        base_revision: (await latest.json()).revision, request_id: randomUUID(),
      }})).ok()).toBeTruthy();
    }
  }
});

test("slow home and galaxy arrivals preserve deliberately chosen focus", async ({ page }) => {
  for (const [name, endpoint] of [["Home", "pages"], ["Galaxy", "graph"]]) {
    await page.goto("/wiki/night-sky-survey");
    await expect(page.locator("article > h1")).toBeVisible();
    let release!: () => void;
    let received!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { received = resolve; });
    const pattern = `**/api/wiki/${endpoint}`;
    await page.route(pattern, async route => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await activate(page, name);
      await held;
      const main = page.locator("#main-content");
      await main.focus();
      release();
      await expect(page.locator("main h1")).toBeVisible();
      await expect(main).toBeFocused();
    } finally { release(); await page.unroute(pattern); }
  }
});

test("resolved links retain header focus chosen during the real resolution read", async ({ page, request }) => {
  const source = await create(request, "# Resolve source\n\n[Resolve survey](/resolve?target=night-sky-survey)");
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { received = resolve; });
  const pattern = "**/api/wiki/resolve-links?*";
  try {
    await page.goto(`/wiki/${source.id}`);
    await expect(page.locator("article > h1")).toHaveText("Resolve source");
    await page.route(pattern, async route => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    });
    await activate(page, "Resolve survey");
    await held;
    const search = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Search", exact: true });
    await search.focus();
    release();
    await expect(page.locator("article > h1")).toHaveText("Night sky survey");
    await expect(search).toBeFocused();
  } finally {
    release?.(); await page.unroute(pattern);
    expect((await request.delete(`/api/wiki/pages/${source.id}`, { data: {
      base_revision: source.revision, request_id: randomUUID(),
    }})).ok()).toBeTruthy();
  }
});

test("direct views retain the skip-link and cross-route main fragments take precedence", async ({ page, request }) => {
  for (const path of ["/?overview=1", "/search", "/galaxy", "/chat"]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
  }
  const source = await create(request, "# Fragment source\n\n[Survey content](/wiki/night-sky-survey#main-content)");
  try {
    await page.goto(`/wiki/${source.id}`);
    await activate(page, "Survey content");
    await expect(page.locator("main h1")).toHaveText("Night sky survey");
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goBack();
    await expect(page.locator("article > h1")).toBeFocused();
    await page.goForward();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goto("/search#main-content");
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goto("/chat");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.locator("#chat-input")).toBeFocused();
  } finally {
    expect((await request.delete(`/api/wiki/pages/${source.id}`, { data: {
      base_revision: source.revision, request_id: randomUUID(),
    }})).ok()).toBeTruthy();
  }
});
