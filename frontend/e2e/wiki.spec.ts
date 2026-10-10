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

test("editor saves Markdown and reads current delivery status", async ({
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
  const deliveryStatus = await request.get("/api/wiki/delivery-status");
  const configured = (await deliveryStatus.json()).remote.state !== "not_configured";
  await expect(page.locator(".delivery-notice")).toContainText(
    configured ? "Remote delivery: current (cached acknowledgement)" : "Remote delivery: not configured",
    { timeout: 15000 },
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
  await expect(page.locator(".missing-link")).toHaveText("A missing thought");
  await expect(page.locator(".missing-link")).not.toHaveAttribute("href");
  await page.goto("/wiki/missing-e2e-page");
  await expect(page.getByRole("heading", { name: "This page is missing." })).toBeVisible();
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

test("real demo table stays readable and keyboard-scrollable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/wiki/night-sky-survey");
  const region = page.getByRole("region", {
    name: "Table; scroll horizontally to read all columns",
  });
  await expect(region).toBeVisible();
  const session = region.getByRole("columnheader", {
    name: "Session",
    exact: true,
  });
  await expect(session).toBeVisible();
  const geometry = await region.evaluate((el) => ({
    width: el.clientWidth,
    content: el.scrollWidth,
  }));
  expect(geometry.content).toBeGreaterThan(geometry.width);
  expect(
    await session.evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(120);
  expect(
    await session.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    }),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await region.focus();
  await expect(region).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => region.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect
    .poll(() => region.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBeTruthy();
});

test("article contents links focus unique sections and history preserves an editor draft", async ({ page, request }) => {
  const fixture = await create(request, "# Synthetic article\n\n## First section\n\nA short note.\n\n### Detail\n\nMore notes.\n\n## First section\n\nAnother note.\n");
  await page.goto(`/wiki/${fixture.id}`);
  const contents = page.getByRole("navigation", { name: "On this page" });
  await expect(contents.getByRole("link")).toHaveCount(3);
  await contents.getByRole("link", { name: "First section", exact: true }).last().click();
  await expect(page.locator("#section-3")).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(contents).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Edit page" }).click();
  const editor = page.locator("#editor");
  await editor.fill("# Synthetic article\n\nUnsaved synthetic draft.");
  await page.getByText("Local Git history", { exact: true }).click();
  await expect(page.locator(".history-list li")).toHaveCount(1);
  const historyResponse = await request.get(`/api/wiki/pages/${fixture.id}/history`);
  const historyData = await historyResponse.json();
  await expect(page.locator(".history-list code")).toHaveText(historyData.history[0].commit.slice(0, 8));
  await expect(editor).toHaveValue("# Synthetic article\n\nUnsaved synthetic draft.");
});

test("history errors can be retried without leaving the page", async ({ page, request }) => {
  const fixture = await create(request, "# Synthetic history\n\nNo sections here.");
  let attempts = 0;
  await page.route(`**/api/wiki/pages/${fixture.id}/history`, async route => {
    if (++attempts === 1) await route.fulfill({ status: 503, json: { message: "History temporarily unavailable." } });
    else await route.continue();
  });
  await page.goto(`/wiki/${fixture.id}`);
  await expect(page.getByRole("navigation", { name: "On this page" })).toHaveCount(0);
  const history = page.getByText("Local Git history", { exact: true });
  await history.click();
  await expect(page.locator(".history-content")).toContainText("Close and reopen history to retry.");
  await history.click();
  await history.click();
  await expect(page.locator(".history-list li")).toHaveCount(1);
});

test("title links resolve IDs, preserve sections and show missing targets", async ({ page, request }) => {
  const title = `Reference ${randomUUID()}`;
  const target = await create(request, `# ${title}\n\n## Fine detail\n\nA synthetic reference.`);
  const source = await create(request, `# Link source\n\n[[${title}#Fine detail|Title reference]] and [[${target.id}|Stable reference]]. [[nonexistent-${randomUUID()}|Missing reference]].\n\n## Local detail\n\n[[#Local detail|Within this article]]`);
  await page.goto(`/wiki/${source.id}`);
  const titleLink = page.getByRole("link", { name: "Title reference", exact: true });
  await expect(titleLink).toHaveAttribute("href", new RegExp(`/wiki/${target.id}#Fine%20detail$`));
  await expect(page.locator(".missing-link")).toHaveText("Missing reference");
  await expect(page.locator(".missing-link")).not.toHaveAttribute("href");
  await page.getByRole("link", { name: "Within this article", exact: true }).click();
  await expect(page.locator("#section-1")).toBeFocused();
  await titleLink.click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${target.id}#Fine%20detail$`));
  await expect(page.locator("#section-1")).toBeFocused();
  await page.reload();
  await expect(page.locator("#section-1")).toBeFocused();
  await page.goBack();
  await expect(page.getByRole("link", { name: "Stable reference", exact: true })).toBeVisible();
});

test("ambiguous titles offer explicit choices and refresh after deletion", async ({ page, request }) => {
  const title = `Duplicate ${randomUUID()}`;
  const a = await create(request, `# ${title}\n\n## Details\n\nFirst synthetic candidate.`);
  const b = await create(request, `# ${title}\n\n## Details\n\nSecond synthetic candidate.`);
  const source = await create(request, `# Ambiguous source\n\n[[${title}#Details|Shared reference]]`);
  await page.goto(`/wiki/${source.id}`);
  const link = page.getByRole("link", { name: "Shared reference", exact: true });
  await expect(link).toHaveClass(/ambiguous-link/);
  await link.click();
  await expect(page.getByRole("heading", { name: "Choose a page." })).toBeVisible();
  const choices = page.locator(".card");
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toHaveAttribute("href", /#Details$/);
  await choices.filter({ hasText: title }).first().click();
  await expect(page.locator("#section-1")).toBeFocused();
  const response = await request.delete(`/api/wiki/pages/${a.id}`, { data: {
    base_revision: a.revision, request_id: randomUUID(),
  }});
  expect(response.ok()).toBeTruthy();
  await page.goto(`/wiki/${source.id}`);
  await expect(page.getByRole("link", { name: "Shared reference", exact: true })).toHaveAttribute("href", `/wiki/${b.id}#Details`);
});

test("late real page response cannot replace a newer article or edit target", async ({ page, request }) => {
  const a = await create(request, `# Delayed article ${randomUUID()}\nOld route.`);
  const title = `Current article ${randomUUID()}`;
  const b = await create(request, `# ${title}\nCurrent route.`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/wiki/pages/${a.id}`, async route => { await gate; await route.continue(); });
  await page.goto(`/wiki/${a.id}`);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.locator(".card").filter({ hasText: title }).click();
  await expect(page.locator("article h1")).toHaveText(title);
  const staleResponse = page.waitForResponse(response => response.url().endsWith(`/api/wiki/pages/${a.id}`));
  release();
  await staleResponse;
  await page.getByRole("button", { name: "Edit page" }).click();
  await expect(page.locator("#editor")).toHaveValue(b.markdown);
});

test("galaxy snapshot refresh reflects real save, link and delete operations", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const title = `New star ${randomUUID()}`;
  await page.goto("/galaxy");
  const previous = await page.locator(".galaxy-revision").innerText();
  const target = await create(request, `# ${title}\n\nAn isolated synthetic star.`);
  const source = await create(request, `# Star source ${randomUUID()}\n\n[[${target.id}]]`);
  await expect(page.locator(".galaxy-revision")).toHaveText(previous);
  await page.getByRole("link", { name: "Refresh snapshot" }).click();
  await expect(page.locator(".galaxy-revision")).not.toHaveText(previous);
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(target.id);
  await page.locator(".galaxy-page").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText(title);
  await expect(page.locator(".galaxy-evidence")).toContainText("Explicit wikilink");
  const response = await request.delete(`/api/wiki/pages/${target.id}`, { data: {
    base_revision: target.revision, request_id: randomUUID(),
  }});
  expect(response.ok()).toBeTruthy();
  await page.getByRole("link", { name: "Refresh snapshot" }).click();
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(target.id);
  await expect(page.locator(".galaxy-sidebar-content")).toContainText("No title or page ID matches.");
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill(source.id);
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-problems")).toContainText(target.id);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".galaxy-stage")).toBeHidden();
});

test("demo frontmatter curates named constellations but stays out of article prose", async ({ page }) => {
  await page.goto("/wiki/night-sky-survey");
  await expect(page.locator(".prose")).not.toContainText("galaxy_group");
  await page.getByRole("button", { name: "Edit page" }).click();
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(/galaxy_group: sky-navigation/);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/galaxy");
  await expect(page.getByRole("heading", { name: "Choose a constellation" })).toBeVisible();
  const groups = page.locator(".galaxy-cluster");
  await expect(groups.filter({ hasText: "curated" })).toHaveCount(4);
  const sky = groups.filter({ hasText: "Sky & navigation" });
  await expect(sky).toContainText("3 pages · curated");
  await sky.click();
  await expect(page.locator(".galaxy-sidebar-content")).toContainText(
    "Curated in Markdown frontmatter",
  );
  await expect(page.locator(".galaxy-sidebar-content .galaxy-page")).toHaveCount(3);
});

test("large synthetic graph opens a usable list without constructing SVG", async ({ page }) => {
  const nodes = Array.from({ length: 251 }, (_, index) => ({
    id: `scale-${String(index).padStart(3, "0")}`,
    title: `Scale page ${index}`,
  }));
  await page.route("**/api/wiki/graph", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      nodes,
      edges: [],
      revision: "synthetic-scale-fixture",
      status: "current",
      missing_targets: [],
      ambiguous_targets: [],
    }),
  }));
  await page.goto("/galaxy");
  await expect(page.locator(".galaxy-scale-note")).toContainText("Large snapshot");
  await expect(page.locator(".galaxy-stage")).toBeHidden();
  await expect(page.locator(".galaxy-stage svg")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("Scale page 250");
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Scale page 250");
});
