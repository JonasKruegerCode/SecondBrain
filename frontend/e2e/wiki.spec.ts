import { test, expect, APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function create(request: APIRequestContext, markdown: string) {
  const id = `e2e-${randomUUID()}`;
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: null, request_id: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return { id, ...(await response.json()) };
}

async function update(
  request: APIRequestContext,
  id: string,
  markdown: string,
  revision: string,
) {
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: revision, request_id: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("home opens a wiki page, resolves an alias, and survives back and reload", async ({
  page,
}) => {
  await page.goto("/?overview=1");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: /Open Lantern Bay field atlas/ })
    .click();
  await expect(page).toHaveURL(/\/wiki\/home$/);
  await expect(page.locator("article h1")).toHaveCount(1);
  await page
    .getByRole("link", { name: "night sky survey", exact: true })
    .click();
  await expect(page).toHaveURL(/\/wiki\/night-sky-survey$/);
  await page.reload();
  await expect(page.locator("article h1")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/wiki\/home$/);
  await expect(
    page.getByRole("link", { name: "night sky survey", exact: true }),
  ).toBeVisible();
});

test("search finds a unique real page and opens its direct route", async ({
  page,
  request,
}) => {
  const term = `search-${randomUUID()}`;
  const fixture = await create(request, `# Search fixture\n${term}`);
  await page.goto("/search");
  await page.getByRole("textbox", { name: "Search pages" }).fill(term);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: /Search fixture/ }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await expect(page.locator(".prose")).toContainText(term);
});

test("editor publishes Markdown and reports actual pending/not-configured state", async ({
  page,
  request,
}) => {
  const fixture = await create(request, "# Editable fixture\nBefore.");
  await page.goto(`/wiki/${fixture.id}`);
  await page.getByRole("button", { name: "Edit page" }).click();
  await page
    .getByRole("textbox", { name: /Markdown/ })
    .fill("# Editable fixture\nAfter the edit.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(page.getByRole("status")).toContainText(
    "Remote sync: not configured",
  );
  await expect(page.locator(".prose")).toContainText("After the edit.");
  const saved = await (
    await request.get(`/api/wiki/pages/${fixture.id}`)
  ).json();
  expect(saved.revision).not.toBe(fixture.revision);
  expect(saved.markdown).toContain("After the edit.");
  await page.reload();
  await expect(page.locator(".prose")).toContainText("After the edit.");
});

test("concurrent revision conflict preserves the editor draft", async ({
  page,
  request,
}) => {
  const fixture = await create(request, "# Conflict fixture\nInitial.");
  await page.goto(`/wiki/${fixture.id}`);
  await page.getByRole("button", { name: "Edit page" }).click();
  const editor = page.getByRole("textbox", { name: /Markdown/ });
  await editor.fill("# Conflict fixture\nMy unsaved draft.");
  await update(
    request,
    fixture.id,
    "# Conflict fixture\nAnother writer.",
    fixture.revision,
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Conflict");
  await expect(editor).toHaveValue("# Conflict fixture\nMy unsaved draft.");
  const saved = await (
    await request.get(`/api/wiki/pages/${fixture.id}`)
  ).json();
  expect(saved.markdown).toContain("Another writer.");
});

test("start page persists, overview stays reachable, and deletion falls back", async ({
  page,
  request,
}) => {
  const fixture = await create(
    request,
    "# My starting point\nA unique synthetic page.",
  );
  await page.goto(`/wiki/${fixture.id}`);
  await page.getByRole("button", { name: "Set as start page" }).click();
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await page.reload();
  await expect(page.locator("article h1")).toHaveText("My starting point");
  await page.getByRole("link", { name: "All pages" }).click();
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  const removed = await request.delete(`/api/wiki/pages/${fixture.id}`, {
    data: { base_revision: fixture.revision, request_id: randomUUID() },
  });
  expect(removed.ok()).toBeTruthy();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open Lantern Bay/ }),
  ).toBeVisible();
});

test("safe renderer strips active HTML and resolves wikilinks only outside code", async ({
  page,
  request,
}) => {
  const target = await create(
    request,
    "# Safe target\nSynthetic link destination.",
  );
  const fixture = await create(
    request,
    `# Renderer fixture\n\n[[${target.id}|Alias destination]]\n\n\`[[inline-code]]\`\n\n\`\`\`md\n[[fenced-code]]\n\`\`\`\n\n<script>window.__wikiXss=1</script>\n<img src="data:image/svg+xml,bad" onerror="window.__wikiXss=2" alt="unsafe">\n<a href="javascript:window.__wikiXss=3">unsafe link</a>`,
  );
  await page.goto(`/wiki/${fixture.id}`);
  await expect(
    page.getByRole("link", { name: "Alias destination" }),
  ).toHaveAttribute("href", `/wiki/${target.id}`);
  await expect(page.locator(".prose code")).toContainText([
    "[[inline-code]]",
    "[[fenced-code]]",
  ]);
  await expect(page.locator('.prose a[href^="/wiki/"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__wikiXss)).toBeUndefined();
  expect(
    await page
      .locator(".prose")
      .evaluate((el) =>
        [...el.querySelectorAll("*")].every((node) =>
          [...node.attributes].every((attr) => !/^on/i.test(attr.name)),
        ),
      ),
  ).toBeTruthy();
  await expect(page.locator(".prose script")).toHaveCount(0);
  await expect(page.locator(".prose img")).not.toHaveAttribute("src");
});

test("mobile direct page and missing link state remain readable", async ({
  page,
  request,
}) => {
  const fixture = await create(
    request,
    "# Mobile fixture\n[[missing-e2e-page|A missing thought]]",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wiki/${fixture.id}`);
  await expect(page.locator("article h1")).toHaveText("Mobile fixture");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("link", { name: "A missing thought" }).click();
  await expect(
    page.getByRole("heading", { name: "This page is missing." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
});

test("canceling browser back keeps the unsaved editor draft and URL", async ({
  page,
  request,
}) => {
  const fixture = await create(request, "# Back navigation fixture\nOriginal.");
  await page.goto("/?overview=1");
  await page.locator(`a[href="/wiki/${fixture.id}"]`).click();
  await page.getByRole("button", { name: "Edit page" }).click();
  await page
    .getByRole("textbox", { name: /Markdown/ })
    .fill("# Back navigation fixture\nKeep this draft.");
  const dialogPromise = page.waitForEvent("dialog");
  await page.evaluate(() => history.back());
  await (await dialogPromise).dismiss();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(
    "# Back navigation fixture\nKeep this draft.",
  );
});
