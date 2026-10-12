import { test, expect, APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

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

function contrastRatio(foreground: string, background: string) {
  const rgb = (value: string) => {
    if (value.startsWith("#")) {
      const hex = value.slice(1);
      return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    }
    return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  };
  const luminance = (value: string) => {
    const channels = rgb(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function pwaUpdateProxy() {
  let release = 1;
  let saveGate: { reached: () => void; resume: Promise<void>; body: boolean } | undefined;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url || "/";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(`http://127.0.0.1:5173${path}`, {
        method: request.method,
        headers: {
          accept: request.headers.accept || "*/*",
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
        },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      if (path.startsWith("/service-worker.js")) {
        body = Buffer.from(
          body
            .toString()
            .replace("secondbrain-pwa-2026-10-10-1", `pwa-browser-test-${release}`),
        );
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/javascript");
        response.setHeader("Service-Worker-Allowed", "/");
      } else {
        upstream.headers.forEach((value, key) => {
          if (!["content-encoding", "content-length", "transfer-encoding"].includes(key)) {
            response.setHeader(key, value);
          }
        });
      }
      if (request.method === "POST" && path.startsWith("/api/wiki/pages/") && saveGate) {
        const gate = saveGate;
        saveGate = undefined;
        if (gate.body) {
          response.writeHead(upstream.status);
          response.flushHeaders();
        }
        gate.reached();
        await gate.resume;
      }
      if (!response.headersSent) response.writeHead(upstream.status);
      response.end(body);
    } catch {
      response.writeHead(502);
      response.end("PWA test proxy failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bump: () => release++,
    holdNextSave: (body = false) => {
      let reached!: () => void;
      let resume!: () => void;
      const arrived = new Promise<void>(resolve => { reached = resolve; });
      const pending = new Promise<void>(resolve => { resume = resolve; });
      saveGate = { reached, resume: pending, body };
      return { arrived, release: resume };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("demo galaxy summarizes bridges without dropping its pages or internal links", async ({ page }, testInfo) => {
  const bridges = [
    "12 explicit links between Archive practice and Atlas crossroads",
    "11 explicit links between Archive practice and Shore observations",
    "15 explicit links between Archive practice and Sky & navigation",
    "9 explicit links between Atlas crossroads and Shore observations",
    "8 explicit links between Atlas crossroads and Sky & navigation",
    "4 explicit links between Shore observations and Sky & navigation",
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-star")).toHaveCount(12);
    await expect(page.locator(".galaxy-edge:not(.is-bridge)")).toHaveCount(22);
    await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(6);
    expect((await page.locator(".galaxy-aggregate-link title").allTextContents()).sort()).toEqual([...bridges].sort());
    await expect(page.locator(".galaxy-mapnote")).toContainText("Combined links between constellations");
    await page.screenshot({ path: testInfo.outputPath(`demo-galaxy-bridges-${width}.png`), fullPage: true });
  }
});

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

test("home card previews are readable plain-text summaries", async ({ page }) => {
  await page.goto("/?overview=1");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();

  const notebook = page.locator(".card", { hasText: "Field notebook" }).locator("p");
  await expect(notebook).toContainText("Question:");
  await expect(notebook).not.toContainText("**");

  const calendar = page
    .locator(".card", { hasText: "Harvest calendar" })
    .locator("p");
  await expect(calendar).toContainText("Record · What it can tell us");
  await expect(calendar).not.toContainText("|");
});

test("small muted text keeps AA contrast on light wiki surfaces", async ({ page }) => {
  const checks = [
    ["header nav a:not(.active)", "#f6f7f2"],
    [".workspace", "#f6f7f2"],
    [".intro p", "#f6f7f2"],
    [".section-heading > span", "#f6f7f2"],
    [".card-meta", "#ffffff"],
    [".card p", "#ffffff"],
    [".card-foot", "#ffffff"],
    ["footer", "#f6f7f2"],
  ] as const;

  await page.goto("/?overview=1");
  for (const [selector, background] of checks) {
    const foreground = await page.locator(selector).first().evaluate(
      (element) => getComputedStyle(element).color,
    );
    expect(contrastRatio(foreground, background), selector).toBeGreaterThanOrEqual(4.5);
  }

  await page.goto("/chat");
  for (const selector of [".chat-history-heading", ".chat-heading p", ".chat-empty"]) {
    const foreground = await page.locator(selector).evaluate(
      (element) => getComputedStyle(element).color,
    );
    expect(contrastRatio(foreground, "#ffffff"), selector).toBeGreaterThanOrEqual(4.5);
  }
});

test("mobile chat opens at its heading without forcing composer focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");

  await expect(page.getByRole("heading", { name: "Ask, then follow the evidence." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).not.toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("saved chat labels and evidence controls remain readable and touchable", async ({ page }, testInfo) => {
  // A synthetic local history tests rendering only; it is not a generated model answer.
  await page.addInitScript(() => {
    localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify([{
      id: "synthetic-accessibility-history",
      title: "Reading the demo wiki",
      updated: 1,
      messages: [
        { role: "user", content: "Where can I start exploring the demo wiki?" },
        {
          role: "assistant",
          content: "This saved rendering fixture links to the demo Home article.",
          sources: [{ id: "home", title: "Home", evidence: "read" }],
          activity: ["Read the synthetic Home article."],
        },
      ],
    }]));
  });
  let chatRequests = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/wiki/chat") chatRequests++;
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/chat");
    await expect(page.locator(".chat-message")).toHaveCount(2);
    for (const selector of [".user .chat-role", ".assistant .chat-role", ".chat-message summary", ".chat-sources > span", ".chat-sources a", ".chat-sources small"]) {
      const colors = await page.locator(selector).evaluate(element => {
        const style = getComputedStyle(element);
        const surface = element.closest("a") || element.closest(".chat-message")!;
        const background = getComputedStyle(surface).backgroundColor;
        const channels = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
        const foregroundRgb = channels(style.color);
        const backgroundRgb = channels(background);
        const opacity = Number(style.opacity);
        let opaqueAncestors = true;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (Number(getComputedStyle(parent).opacity) !== 1) opaqueAncestors = false;
        }
        return {
          foreground: `rgb(${foregroundRgb.slice(0, 3).map((channel, i) => channel * opacity + backgroundRgb[i] * (1 - opacity)).join(",")})`,
          background,
          opaque: (foregroundRgb.length === 3 || foregroundRgb[3] === 1) &&
            (backgroundRgb.length === 3 || backgroundRgb[3] === 1) && opaqueAncestors,
          fontSize: parseFloat(style.fontSize),
        };
      });
      // Fail rather than mismeasure if a later theme introduces extra alpha layers.
      expect(colors.opaque, `${width}px ${selector} opaque color surfaces`).toBe(true);
      expect.soft(contrastRatio(colors.foreground, colors.background), `${width}px ${selector} contrast`).toBeGreaterThanOrEqual(4.5);
      if (selector.endsWith(".chat-role")) expect.soft(colors.fontSize).toBeGreaterThanOrEqual(10);
    }
    for (const selector of ['[data-action="new"]', '[data-action="delete"]', ".chat-message summary", ".chat-sources a"]) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds, selector).not.toBeNull();
      expect.soft(bounds!.width, `${width}px ${selector} width`).toBeGreaterThanOrEqual(44);
      expect.soft(bounds!.height, `${width}px ${selector} height`).toBeGreaterThanOrEqual(44);
      await page.locator(selector).click({ trial: true });
    }
    const actions = page.locator(".chat-message summary");
    await actions.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-message details")).toHaveAttribute("open", "");
    await expect(page.getByText("Read the synthetic Home article.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`saved-chat-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Home read", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/home$/);
    await expect(page.locator(".prose")).toBeVisible();
  }
  expect(chatRequests).toBe(0);
});

test("keyboard users can skip navigation and identify the active view", async ({
  page,
}) => {
  await page.goto("/?overview=1");
  await expect(
    page.getByRole("heading", { name: "A growing collection" }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(primary.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await primary.getByRole("link", { name: "Search" }).click();
  await expect(primary.getByRole("link", { name: "Search" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page).toHaveTitle("Search · Secondbrain");
  await expect(
    page.getByRole("status").filter({ hasText: "Search view loaded." }),
  ).toHaveCount(1);
});

test(
  "editor rerenders restore useful keyboard focus",
  async ({ page, request }) => {
    const fixture = await create(request, "# Keyboard editor\nOriginal.");
    await page.goto(`/wiki/${fixture.id}`);
    const edit = page.getByRole("button", { name: "Edit page" });
    await edit.focus();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    await expect(editor).toBeFocused();
    await editor.fill("# Keyboard editor\nUnsaved keyboard draft.");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("button", { name: "Edit page" }),
    ).toBeFocused();
  },
);

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

async function observeSearchBodyCompletion(page: Page) {
  // Observe body completion after the UI promise chain, without changing response data.
  await page.addInitScript(() => {
    const parse = Response.prototype.json;
    (window as any).__settledSearchBodies = 0;
    Response.prototype.json = async function () {
      const body = await parse.call(this);
      if (this.url && new URL(this.url).pathname === "/api/wiki/search") {
        setTimeout(() => { (window as any).__settledSearchBodies++; }, 0);
      }
      return body;
    };
  });
}

for (const older of ["failure", "success"] as const) {
  test(`latest submitted search survives an older ${older}`, async ({ page, request }, testInfo) => {
    await observeSearchBodyCompletion(page);
    const firstTerm = `queued-${randomUUID()}`;
    const secondTerm = `current-${randomUUID()}`;
    const first = await create(request, `# Earlier search fixture\n${firstTerm}`);
    const second = await create(request, `# Current search fixture\n${secondTerm}`);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let captured!: () => void;
    const arrived = new Promise<void>(resolve => { captured = resolve; });
    let firstRequest = true;
    await page.route("**/api/wiki/search?**", async route => {
      if (new URL(route.request().url()).searchParams.get("q") !== firstTerm || !firstRequest) {
        await route.continue();
        return;
      }
      firstRequest = false;
      const response = await route.fetch(); // Capture the actual older service snapshot.
      expect((await response.json()).results[0].id).toBe(first.id);
      captured();
      await gate;
      if (older === "failure") {
        // Explicit transport/UI failure injection, not an observed backend outage.
        await route.fulfill({ status: 503, json: { message: "Delayed synthetic search outage." } });
      } else await route.fulfill({ response });
    });
    const submit = async (query: string) => {
      await page.getByRole("textbox", { name: "Search pages" }).fill(query);
      await page.getByRole("button", { name: "Search", exact: false }).click();
    };
    try {
      await page.goto("/search");
      await submit(firstTerm);
      await arrived;
      if (older === "success") {
        await update(request, first.id, `# Updated search fixture\n${firstTerm}`, first.revision);
      }
      await submit(secondTerm);
      await expect(page.locator(`#results a[href="/wiki/${second.id}"]`)).toBeVisible();
      if (older === "success") {
        // A -> B -> A has the same input value but a newer content snapshot.
        await submit(firstTerm);
        await expect(page.locator("#results .card h3")).toHaveText("Updated search fixture");
      }
      release();
      await page.waitForFunction(count => (window as any).__settledSearchBodies === count, older === "success" ? 3 : 2);
      await expect(page.locator("#results .card h3")).toHaveText(older === "success" ? "Updated search fixture" : "Current search fixture");
      await expect(page.locator("#results .error")).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/search\\?q=${older === "success" ? firstTerm : secondTerm}$`));
      if (older === "failure") {
        let unavailable = true;
        await page.route(`**/api/wiki/search?q=${secondTerm}`, async route => {
          if (unavailable) {
            unavailable = false;
            await route.fulfill({ status: 503, json: { message: "Current synthetic search outage." } });
          } else await route.continue();
        });
        await submit(secondTerm);
        await expect(page.locator("#results .error")).toHaveText("Current synthetic search outage.");
        await submit(secondTerm);
        await expect(page.locator("#results .card h3")).toHaveText("Current search fixture");
        await expect(page.locator("#results .error")).toHaveCount(0);
      }
      if (older === "success") {
        await page.screenshot({ path: testInfo.outputPath("search-latest-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: testInfo.outputPath("search-latest-mobile.png"), fullPage: true });
      }
      const target = older === "success" ? first.id : second.id;
      await page.locator(`#results a[href="/wiki/${target}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/wiki/${target}$`));
    } finally {
      release();
    }
  });
}

test("submitted search finishes while the next query remains an unsubmitted draft", async ({ page, request }) => {
  await observeSearchBodyCompletion(page);
  const term = `submitted-${randomUUID()}`;
  const fixture = await create(request, `# Submitted search fixture\n${term}`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const arrived = new Promise<void>(resolve => { captured = resolve; });
  let searches = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/wiki/search") searches++;
  });
  await page.route(`**/api/wiki/search?q=${term}`, async route => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/search");
    const input = page.getByRole("textbox", { name: "Search pages" });
    await input.fill(term);
    await page.getByRole("button", { name: "Search" }).click();
    await arrived;
    await input.fill("Unsubmitted next query");
    release();
    await page.waitForFunction(() => (window as any).__settledSearchBodies === 1);
    await expect(page.locator("#results .card h3")).toHaveText("Submitted search fixture");
    await expect(input).toHaveValue("Unsubmitted next query");
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${term}$`));
    expect(searches).toBe(1);
    await page.locator(`#results a[href="/wiki/${fixture.id}"]`).click();
    await expect(page.locator("article h1")).toHaveText("Submitted search fixture");
  } finally {
    release();
  }
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
  await expect(page.locator(".notice")).toContainText("Saved");
  await expect(page.locator("article h1")).toBeFocused();
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

for (const retryMode of ["unchanged", "edited"] as const) {
test(`a timed-out save preserves its ${retryMode} draft without another publication`, async ({ page, request }, testInfo) => {
  const fixture = await create(request, "# Save timeout fixture\nBefore.");
  await page.goto(`/wiki/${fixture.id}`);
  await page.clock.install();
  const payloads: { request_id: string; base_revision: string; markdown: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const published = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/wiki/pages/${fixture.id}`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    payloads.push(route.request().postDataJSON());
    if (payloads.length > 1) { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {}); // The client may already have aborted.
  });
  try {
    await page.getByRole("button", { name: "Edit page" }).click();
    const draft = "# Save timeout fixture\nA synthetic saved change.";
    const editor = page.getByRole("textbox", { name: /Markdown/ });
    await editor.fill(draft);
    await page.getByRole("button", { name: "Save changes" }).click();
    await published;
    const saved = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(saved.markdown).toBe(draft);
    await page.clock.fastForward(30_001);
    await expect(page.locator(".notice")).toContainText("timed out");
    await expect(page.locator(".notice")).toHaveClass(/error/);
    await expect(editor).toHaveValue(draft);
    await expect(editor).toBeEnabled();
    await expect(editor).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("save-timeout-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("save-timeout-mobile.png"), fullPage: true });
    release();
    if (retryMode === "edited") await editor.fill("# Save timeout fixture\nA further unsaved change.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".notice")).toContainText(retryMode === "unchanged" ? "Saved locally" : "Conflict");
    if (retryMode === "unchanged") await expect(page.locator(".notice")).not.toHaveClass(/error/);
    expect(payloads).toHaveLength(2);
    if (retryMode === "unchanged") expect(payloads[1]).toEqual(payloads[0]);
    else {
      expect(payloads[1].request_id).not.toBe(payloads[0].request_id);
      expect(payloads[1].base_revision).toBe(payloads[0].base_revision);
      await expect(editor).toHaveValue("# Save timeout fixture\nA further unsaved change.");
      await expect(editor).toBeFocused();
    }
    const retry = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(retry.revision).toBe(saved.revision);
    const history = await (await request.get(`/api/wiki/pages/${fixture.id}/history`)).json();
    expect(history.history).toHaveLength(2); // Creation plus the one actual edit.
    expect(retry.markdown).toBe(draft);
    if (retryMode === "unchanged") await expect(page.locator(".prose")).toContainText("A synthetic saved change.");
  } finally { release(); }
});
}

test("a stalled save body times out after successful headers and replays the real receipt", async ({ page, request }, testInfo) => {
  const fixture = await create(request, "# Save body fixture\nBefore.");
  const proxy = await pwaUpdateProxy();
  let gate: ReturnType<typeof proxy.holdNextSave> | undefined;
  let phase = "opening the proxied article";
  try {
    await page.goto(`${proxy.origin}/wiki/${fixture.id}`);
    await expect(page.locator("article h1")).toHaveText("Save body fixture");
    await page.clock.install();
    await page.getByRole("button", { name: "Edit page" }).click();
    const draft = "# Save body fixture\nSynthetic change behind held body.";
    await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
    gate = proxy.holdNextSave(true);
    const headers = page.waitForResponse(response => response.request().method() === "POST" &&
      response.url().endsWith(`/api/wiki/pages/${fixture.id}`));
    phase = "waiting for the committed save to reach the body gate";
    await page.getByRole("button", { name: "Save changes" }).click();
    let arrived = false;
    void gate.arrived.then(() => { arrived = true; });
    await test.step("Receive the committed save at the body gate", async () => {
      await expect.poll(() => arrived, { message: "The real save never reached the body-stall gate", timeout: 10_000 }).toBeTruthy();
    });
    phase = "waiting for successful headers before the held response body";
    expect((await headers).status()).toBe(200); // Browser received real successful headers, not the body.
    const saved = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(saved.markdown).toBe(draft);
    phase = "advancing the body deadline and waiting for the recoverable error";
    await page.clock.fastForward(30_001);
    await expect(page.locator(".notice")).toContainText("save response timed out");
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toBeEnabled();
    gate.release();
    phase = "replaying the identical real save receipt";
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".notice")).toContainText("Saved locally");
    const recovered = await (await request.get(`/api/wiki/pages/${fixture.id}`)).json();
    expect(recovered.revision).toBe(saved.revision);
    const history = await (await request.get(`/api/wiki/pages/${fixture.id}/history`)).json();
    expect(history.history).toHaveLength(2);
  } finally {
    // These synthetic checkpoints stay in browser.log when the runner can only
    // report a whole-test timeout, including a stall during proxy teardown.
    console.info(`[save-body] status=${testInfo.status}; last phase=${phase}; entering cleanup`);
    gate?.release();
    await test.step("Close the browser and owned body-stall proxy", async () => {
      await page.close();
      await proxy.close();
    });
    console.info("[save-body] cleanup completed");
  }
});

test("a timed-out search leaves a retryable error and accepts a fresh real response", async ({ page, request }) => {
  const term = `timeout${randomUUID().replace(/-/g, "")}`;
  const fixture = await create(request, `# Search timeout fixture\n${term}`);
  await page.goto("/search");
  await expect(page.getByRole("heading", { name: "Find a thought." })).toBeVisible();
  await page.clock.install();
  let searches = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const responseReady = new Promise<void>(resolve => { captured = resolve; });
  await page.route("**/api/wiki/search?**", async route => {
    if (++searches > 1) { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole("textbox", { name: "Search pages" }).fill(term);
    await page.getByRole("button", { name: "Search" }).click();
    await responseReady;
    await page.clock.fastForward(30_001);
    await expect(page.locator("#results .error")).toContainText("Request timed out");
    await expect(page.getByRole("textbox", { name: "Search pages" })).toHaveValue(term);
    release();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator(`#results a[href="/wiki/${fixture.id}"]`)).toBeVisible();
    await expect(page.locator("#results .error")).toHaveCount(0);
    expect(searches).toBe(2);
  } finally { release(); }
});

test("chat has a longer bounded response deadline and preserves a retryable question", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.locator("#chat-input")).toBeVisible();
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const responseReady = new Promise<void>(resolve => { captured = resolve; });
  let calls = 0;
  await page.route("**/api/wiki/chat", async route => {
    if (++calls > 1) { await route.continue(); return; }
    const response = await route.fetch(); // Real unconfigured-provider error, never a fake answer.
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.locator("#chat-input").fill("What can this synthetic wiki support?");
    await page.getByRole("button", { name: "Send", exact: false }).click();
    await responseReady;
    await page.clock.fastForward(30_001);
    await expect(page.locator("#chat-input")).toBeDisabled();
    await expect(page.locator(".chat-error")).toHaveCount(0);
    await page.clock.fastForward(90_000);
    await expect(page.locator(".chat-error")).toContainText("Request timed out");
    await expect(page.locator("#chat-input")).toBeEnabled();
    await expect(page.locator(".chat-message.user")).toContainText("What can this synthetic wiki support?");
    await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
    release();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".chat-error")).toContainText("not configured");
    expect(calls).toBe(2);
    await expect(page.locator(".chat-message.user")).toHaveCount(1);
  } finally { release(); }
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
  await expect(page.locator(".notice")).toContainText("Conflict");
  await expect(editor).toHaveValue("# Conflict fixture\nMy unsaved draft.");
  await expect(editor).toBeFocused();
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

for (const direction of ["back", "forward"] as const) {
  test(`rejecting browser ${direction} preserves the complete article history`, async ({ page, request }) => {
    const last = await create(request, "# Last history article\nSynthetic final destination.");
    const middle = await create(request, `# Middle history article\nOriginal.\n\n[[${last.id}|Next article]]`);
    const first = await create(request, `# First history article\n[[${middle.id}|Next article]]`);
    await page.goto(`/wiki/${first.id}`);
    await page.getByRole("link", { name: "Next article", exact: true }).click();
    await expect(page.locator("article h1")).toHaveText("Middle history article");
    await page.getByRole("link", { name: "Next article", exact: true }).click();
    await expect(page.locator("article h1")).toHaveText("Last history article");
    await page.goBack();
    await expect(page.locator("article h1")).toHaveText("Middle history article");
    const length = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "Edit page" }).click();
    const draft = "# Middle history article\nUnsaved synthetic draft.";
    await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
    const dialog = page.waitForEvent("dialog");
    await page.evaluate(direction => history[direction](), direction);
    await (await dialog).dismiss();
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
    expect(await page.evaluate(() => history.length)).toBe(length);
    const discard = page.waitForEvent("dialog");
    const click = page.getByRole("button", { name: "Cancel", exact: true }).click();
    await (await discard).accept();
    await click;
    await expect(page.getByRole("button", { name: "Edit page" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/wiki/${first.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${last.id}$`));
    await expect(page.locator("article h1")).toHaveText("Last history article");
    expect(await page.evaluate(() => history.length)).toBe(length);
  });
}

test("blocked traversal preserves history while a real save acknowledgement is pending", async ({ page, request }, testInfo) => {
  const last = await create(request, "# Save history last\nSynthetic destination.");
  const middle = await create(request, `# Save history middle\nOriginal.\n\n[[${last.id}|Next article]]`);
  const first = await create(request, `# Save history first\n[[${middle.id}|Next article]]`);
  await page.goto(`/wiki/${first.id}`);
  await page.getByRole("link", { name: "Next article", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Save history middle");
  await page.getByRole("link", { name: "Next article", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Save history last");
  await page.goBack();
  await expect(page.locator("article h1")).toHaveText("Save history middle");
  const length = await page.evaluate(() => history.length);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const published = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/wiki/pages/${middle.id}`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "Edit page" }).click();
    await page.getByRole("textbox", { name: /Markdown/ }).fill("# Save history middle\nSaved synthetic content.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await published;
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    expect(await page.evaluate(() => history.length)).toBe(length);
    await expect(page.getByRole("textbox", { name: /Markdown/ })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("history-pending-save-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("history-pending-save-mobile.png"), fullPage: true });
    release();
    await expect(page.locator(".notice")).toContainText("Saved locally");
    await expect(page.locator("article h1")).toHaveText("Save history middle");
    await expect(page.locator(".prose")).toContainText("Saved synthetic content.");
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/wiki/${first.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${middle.id}$`));
    await expect(page.locator(".prose")).toContainText("Saved synthetic content.");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/wiki/${last.id}$`));
    expect(await page.evaluate(() => history.length)).toBe(length);
  } finally { release(); }
});

test("bare fragment links keep tracked history and preserve an editor during traversal", async ({ page, request }) => {
  const fixture = await create(request, "# Fragment history\n[Jump to notes](#Notes)\n\n## Notes\nSynthetic notes.");
  await page.goto(`/wiki/${fixture.id}`);
  const length = await page.evaluate(() => history.length);
  await page.getByRole("link", { name: "Jump to notes", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}#Notes$`));
  await expect(page.locator("#section-1")).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.getByRole("link", { name: "Jump to notes", exact: true }).click();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.getByRole("button", { name: "Edit page" }).click();
  const draft = "# Fragment history\nUnsaved synthetic notes.";
  await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}$`));
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/wiki/${fixture.id}#Notes$`));
  await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
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

test("nested-list wikilinks stay aligned between the article and graph", async ({
  page,
  request,
}) => {
  const target = await create(request, "# Nested target\n\nA synthetic destination.");
  const source = await create(
    request,
    `# Nested source\n\n- References\n    - [[${target.id}|Nested target]]`,
  );

  await page.goto(`/wiki/${source.id}`);
  await expect(
    page.getByRole("link", { name: "Nested target", exact: true }),
  ).toHaveAttribute("href", `/wiki/${target.id}`);

  const graph = await (await request.get("/api/wiki/graph")).json();
  expect(graph.edges).toContainEqual({
    source: source.id,
    target: target.id,
    type: "wikilink",
  });
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

test("demo tour preserves an unanswered real chat question across reload and navigation", async ({ page, request }, testInfo) => {
  // Use the actual unconfigured API in the isolated demo, without a scripted answer.
  const before = await (await request.get("/api/wiki/graph")).json();
  const calls: unknown[] = [];
  page.on("request", call => {
    if (new URL(call.url()).pathname === "/api/wiki/chat" && call.method() === "POST")
      calls.push(call.postDataJSON());
  });
  await page.goto("/wiki/home");
  await page.getByRole("button", { name: "Set as start page" }).click();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Lantern Bay field atlas", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Mira Quill", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/mira-quill$/);
  await expect(page.locator("article h1")).toContainText("fictional archivist");
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("Mira Quill");
  await page.locator(".galaxy-page").click();
  await expect(page.locator(".galaxy-selected-heading h2")).toContainText("Mira Quill");
  await page.getByRole("link", { name: /Open article/ }).click();
  await expect(page).toHaveURL(/\/wiki\/mira-quill$/);
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  const question = "What does Mira record when a recollection cannot establish a date?";
  await page.getByLabel("Message").fill(question);
  const first = page.waitForResponse(response => response.url().endsWith("/api/wiki/chat"));
  await page.getByRole("button", { name: "Send" }).click();
  expect((await first).status()).toBe(503);
  await expect(page.getByRole("alert")).toContainText("not configured");
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.locator(".chat-message.user")).toHaveText(/cannot establish a date/);
  expect(calls).toHaveLength(1); // Restoring a question never starts a paid call.
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.locator(".chat-history-list button").filter({ hasText: question.slice(0, 54) }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  const retry = page.waitForResponse(response => response.url().endsWith("/api/wiki/chat"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect((await retry).status()).toBe(503);
  expect(calls).toEqual([calls[0], calls[0]]);
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await expect(page.locator(".chat-message.assistant")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("not configured");
  await page.screenshot({ path: testInfo.outputPath("unanswered-chat-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const retryTarget = (await page.getByRole("button", { name: "Retry", exact: true }).boundingBox())!;
  expect(retryTarget.height).toBeGreaterThanOrEqual(44);
  expect(retryTarget.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("unanswered-chat-mobile.png"), fullPage: true });
  const after = await (await request.get("/api/wiki/graph")).json();
  expect(after.revision).toBe(before.revision);
});

test("read-only chat keeps multi-turn context and conversations in this browser", async ({ page }) => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  await page.route("**/api/wiki/chat", async route => {
    requests.push(route.request().postDataJSON());
    const followUp = requests.length > 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        answer: followUp
          ? "The follow-up connects the atlas to the night sky survey."
          : "The atlas begins at Lantern Bay.",
        activity: followUp ? ["Read “Night sky survey”."] : ["Read “Lantern Bay field atlas”."],
        sources: [
          followUp
            ? { id: "night-sky-survey", title: "Night sky survey", evidence: "read" }
            : { id: "home", title: "Lantern Bay field atlas", evidence: "read" },
        ],
        limits: { tool_calls: 1, max_tool_calls: 8 },
      }),
    });
  });

  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Ask, then follow the evidence." })).toBeVisible();
  await page.getByLabel("Message").fill("Where does the atlas begin?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Lantern Bay");
  await expect(page.getByRole("link", { name: /Lantern Bay field atlas/ })).toBeVisible();

  await page.getByLabel("Message").fill("What does that connect to?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
  expect(requests[1].messages.map(message => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);

  await page.reload();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
});

test("chat preserves independent tab conversations and does not resurrect a deleted one", async ({ page, context }) => {
  const other = await context.newPage();
  for (const tab of [page, other]) {
    await tab.route("**/api/wiki/chat", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic tab answer.", sources: [], activity: [] }),
    }));
  }

  await page.goto("/chat");
  await other.goto("/chat");
  await page.getByLabel("Message").fill("Question from the first tab.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic tab answer.");
  await other.getByLabel("Message").fill("Question from the second tab.");
  await other.getByRole("button", { name: "Send" }).click();
  await expect(other.locator(".chat-message.assistant")).toContainText("Synthetic tab answer.");

  const storedQuestions = () => page.evaluate(() =>
    JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1") || "[]")
      .flatMap((conversation: { messages: Array<{ role: string; content: string }> }) => conversation.messages)
      .filter((message: { role: string }) => message.role === "user")
      .map((message: { content: string }) => message.content),
  );
  await expect.poll(storedQuestions).toEqual([
    "Question from the second tab.",
    "Question from the first tab.",
  ]);

  await page.getByRole("button", { name: "Delete conversation" }).click();
  await other.getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(storedQuestions).toEqual(["Question from the second tab."]);
  await other.close();
});

for (const width of [1440, 390]) {
test(`chat deletion in another tab survives a follow-up and an in-flight answer (${width}px)`, async ({ page, context }, testInfo) => {
  await page.route("**/api/wiki/chat", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ answer: "Synthetic initial answer.", sources: [], activity: [] }) }));
  await page.goto("/chat");
  await page.getByLabel("Message").fill("Question to be deleted.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic initial answer.");
  const deletedId = await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!)[0].id);
  const stale = await context.newPage();
  await stale.setViewportSize({ width, height: 844 });
  let submitted: { messages: Array<{ role: string; content: string }> } | undefined;
  await stale.route("**/api/wiki/chat", route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic fresh answer.", sources: [], activity: [] }) });
  });
  await stale.goto("/chat");
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await stale.getByLabel("Message").fill("Follow-up after deletion.");
  await stale.getByRole("button", { name: "Send" }).click();
  await expect(stale.locator(".chat-message.assistant").last()).toContainText("Synthetic fresh answer.");
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!).some((item: { id: string }) => item.id === id), deletedId)).toBeFalsy();
  expect(submitted?.messages).toEqual([{ role: "user", content: "Follow-up after deletion." }]);
  await expect(stale.locator(".chat-conversation-notice")).toContainText("started a new conversation");
  expect(await stale.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await stale.screenshot({ path: testInfo.outputPath("chat-deleted-tab.png"), fullPage: true });

  await page.reload();
  await expect(page.locator(".chat-message.user")).toContainText("Follow-up after deletion.");
  const inFlightId = await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!)[0].id);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await stale.unroute("**/api/wiki/chat");
  await stale.route("**/api/wiki/chat", async route => {
    await hold;
    await route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ answer: "Synthetic delayed answer.", sources: [], activity: [] }) });
  });
  const requested = stale.waitForRequest("**/api/wiki/chat");
  await stale.getByLabel("Message").fill("Question whose answer arrives after deletion.");
  await stale.getByRole("button", { name: "Send" }).click();
  await requested;
  await page.getByRole("button", { name: "Delete conversation" }).click();
  release();
  await expect(stale.locator(".chat-thinking")).toHaveCount(0);
  await expect(stale.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(stale.locator(".chat-conversation-notice")).toContainText("deleted in another tab");
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!).some((item: { id: string }) => item.id === id), inFlightId)).toBeFalsy();
  await expect(stale.getByLabel("Message")).toBeEnabled();
  await stale.close();
});
}

for (const failureAfterDeletion of [false, true]) {
test(`chat retry respects another tab's deletion (${failureAfterDeletion ? "late failure" : "earlier failure"})`, async ({ page, context }) => {
  let calls = 0;
  let arrived!: () => void;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/wiki/chat", async route => {
    calls++;
    arrived();
    if (failureAfterDeletion) await held;
    if (calls === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ error: "chat_unavailable", message: "Synthetic provider unavailable." }) });
    else await route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ answer: "This stale request should not be sent.", sources: [], activity: [] }) });
  });
  await page.goto("/chat");
  await page.getByLabel("Message").fill("Synthetic question deleted before retry.");
  await page.getByRole("button", { name: "Send" }).click();
  await requested;
  if (!failureAfterDeletion) await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/chat");
  await other.getByRole("button", { name: "Delete conversation" }).click();
  if (failureAfterDeletion) release();
  else await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(page.locator(".chat-conversation-notice")).toContainText("deleted in another tab");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message")).toBeEnabled();
  expect(calls).toBe(1); // A retry must not resend the deleted transcript.
  await other.close();
});
}

test("PWA metadata registers an online-only worker without private caches", async ({
  page,
  request,
  context,
}) => {
  await page.addInitScript(() => {
    const key = "pwa-first-install-documents";
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || "0") + 1));
  });
  await page.goto("/?overview=1");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any maskable" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any maskable" }),
    ]),
  );

  const session = await context.newCDPSession(page);
  const appManifest = await session.send("Page.getAppManifest");
  expect(appManifest.errors).toEqual([]);
  const installability = await session.send("Page.getInstallabilityErrors");
  expect(installability.installabilityErrors).toEqual([]);
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await new Promise<void>(resolve => {
      if (navigator.serviceWorker.controller) return resolve();
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
        once: true,
      });
    });
    return {
      scope: registration.scope,
      script: registration.active?.scriptURL,
      caches: await caches.keys(),
    };
  });
  expect(worker.scope).toBe("http://127.0.0.1:5173/");
  expect(worker.script).toMatch(/\/service-worker\.js$/);
  expect(worker.caches).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("pwa-first-install-documents"))).toBe("1");

  const serviceWorker = await (await request.get("/service-worker.js")).text();
  expect(serviceWorker).toContain("SKIP_WAITING");
  expect(serviceWorker).not.toContain('addEventListener("fetch"');
  expect(serviceWorker).not.toContain("caches.");

  await context.setOffline(true);
  await expect(page.locator('.pwa-notice[data-kind="offline"]')).toContainText(
    "wiki and chat need a connection",
  );
  await context.setOffline(false);
  await expect(page.locator(".pwa-notice")).toBeHidden();
});

test("PWA offers and applies a waiting worker update", async ({ page }) => {
  const proxy = await pwaUpdateProxy();
  try {
    await page.goto(`${proxy.origin}/?overview=1`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    proxy.bump();
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    const update = page.locator('.pwa-notice[data-kind="update"]');
    await expect(update).toContainText("new version");
    await Promise.all([
      page.waitForEvent("load"),
      update.getByRole("button", { name: "Update now" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".pwa-notice")).toBeHidden();
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
  } finally {
    await proxy.close();
  }
});


async function offerPwaUpdate(page: Page, proxy: Awaited<ReturnType<typeof pwaUpdateProxy>>) {
  proxy.bump();
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await expect(page.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
}

test("article backlinks show only actual incoming sources and refresh after edits", async ({ page, request }, testInfo) => {
  const target = await create(request, "# Incoming link destination\nA synthetic article.");
  const source = await create(request, `# An incoming source\n[[${target.id}|Destination]] and [[${target.id}#Details]].`);
  const distant = await create(request, `# An indirect source\n[[${source.id}]].`);
  await create(request, `# Code is not a backlink\n\n\`[[${target.id}]]\``);
  await page.goto(`/wiki/${target.id}`);
  const panel = page.locator(".page-backlinks");
  await panel.locator("summary").click();
  await expect(panel.getByRole("link", { name: source.title, exact: true })).toHaveCount(1);
  await expect(panel.getByRole("link", { name: distant.title, exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Explicit links");
  await page.screenshot({ path: testInfo.outputPath("article-backlinks-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await panel.getByRole("link", { name: source.title, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("article-backlinks-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await panel.getByRole("link", { name: source.title, exact: true }).click();
  await expect(page.locator("article h1")).toHaveText(source.title);
  await page.goBack();
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks a")).toHaveCount(1);
  await update(request, source.id, "# An incoming source\nThe link has been removed.", source.revision);
  await page.getByRole("button", { name: "Refresh links" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-backlinks")).toContainText("No other pages link here yet.");
  await expect(page.getByRole("button", { name: "Refresh links" })).toBeFocused();
});

test("late backlink response cannot replace a newer article and read failures can retry", async ({ page, request }) => {
  const old = await create(request, "# Previous backlink article\nSynthetic old route.");
  const current = await create(request, "# Current backlink article\nSynthetic current route.");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/wiki/pages/${old.id}/backlinks`, async route => { await gate; await route.continue(); });
  await page.goto(`/wiki/${old.id}`);
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks")).toContainText("Loading incoming links");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.locator(".card").filter({ hasText: current.title }).click();
  const delayed = page.waitForResponse(response => response.url().endsWith(`/pages/${old.id}/backlinks`));
  release();
  await delayed;
  await expect(page.locator("article h1")).toHaveText(current.title);
  await expect(page.locator(".page-backlinks")).toContainText("Open to see pages");
  let failOnce = true;
  await page.route(`**/api/wiki/pages/${current.id}/backlinks`, async route => {
    if (failOnce) { failOnce = false; await route.abort(); } else await route.continue();
  });
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks")).toContainText("Couldn’t load incoming links");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".page-backlinks")).toContainText("No other pages link here yet.");
  await update(request, current.id, "# Current backlink article\nChanged after this read.", current.revision);
  await page.getByRole("button", { name: "Refresh links" }).click();
  await expect(page.locator(".page-backlinks")).toContainText("This article has changed");
  const reload = page.getByRole("button", { name: "Reload article", exact: true });
  await expect(reload).toBeFocused();
  let failReload = true;
  await page.route(`**/api/wiki/pages/${current.id}`, async route => {
    if (failReload) { failReload = false; await route.abort(); } else await route.continue();
  });
  await reload.press("Enter");
  await expect(page.locator(".page-backlinks")).toContainText("Couldn’t reload this article");
  await expect(reload).toBeFocused();
  await reload.press("Enter");
  await expect(page.locator(".prose")).toContainText("Changed after this read.");
  await expect(page.locator("article h1")).toBeFocused();
  await page.locator(".page-backlinks summary").click();
  await expect(page.locator(".page-backlinks")).toContainText("No other pages link here yet.");
});

test("chat ignores malformed saved records and keeps a valid bounded conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const valid = { id: "synthetic-valid", title: "Synthetic saved question", updated: 1,
      messages: Array.from({ length: 26 }, () => ({ role: "user", content: "A retained synthetic question." })) };
    const invalid = [
      { ...valid, id: "bad-title", title: 42 },
      { ...valid, id: "bad-content", messages: [{ role: "user", content: null }] },
      { ...valid, id: "bad-source", messages: [{ role: "assistant", content: "Invalid source", sources: [{ id: null, title: "bad", evidence: "read" }] }] },
      { ...valid, id: "bad-activity", messages: [{ role: "assistant", content: "Invalid activity", activity: [42] }] },
      { ...valid, id: "bad-surrogate", messages: [{ role: "assistant", content: "Invalid source", sources: [{ id: "\ud800", title: "bad", evidence: "read" }] }] },
    ];
    localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify([...invalid, valid]));
  });
  await page.goto("/chat");
  await expect(page.locator(".chat-message.user")).toHaveCount(24);
  await expect(page.locator(".chat-message.user").first()).toContainText("A retained synthetic question.");
  await expect(page.locator(".chat-history-list button")).toHaveCount(1);
  expect(errors).toEqual([]);
  for (let i = 0; i < 22; i++) await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-history-list button")).toHaveCount(20);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!).length)).toBe(20);
});

test("new chat remains active at the limit even with future-dated saved conversations", async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem("secondbrain.chat.conversations.v1")) localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify(
    Array.from({ length: 20 }, (_, i) => ({ id: `synthetic-future-${i}`, title: `Earlier synthetic chat ${i}`, updated: Date.now() + 86400000,
      messages: [{ role: "user", content: "Earlier synthetic question." }] })),
  )); });
  let submitted: unknown;
  await page.route("**/api/wiki/chat", route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Synthetic new answer.", sources: [], activity: [] }) });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-message")).toHaveCount(0);
  await page.getByLabel("Message").fill("New synthetic question.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic new answer.");
  expect(submitted).toEqual({ messages: [{ role: "user", content: "New synthetic question." }] });
  await expect(page.locator(".chat-history-list button")).toHaveCount(20);
  await page.reload();
  await expect(page.locator(".chat-message.user")).toHaveText(/New synthetic question/);
});

test("chat storage failure explains session-only answers and unsuccessful persisted deletion", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const key = "secondbrain.chat.conversations.v1";
    localStorage.setItem(key, JSON.stringify([{ id: "synthetic-storage", title: "Synthetic saved question", updated: 1,
      messages: [{ role: "user", content: "Previously saved synthetic question." }] }]));
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "secondbrain.chat.conversations.v1") throw new DOMException("Synthetic unavailable storage", "QuotaExceededError");
      return set.call(this, key, value);
    };
    window.addEventListener("synthetic-storage-ready", () => { Storage.prototype.setItem = set; }, { once: true });
  });
  // Scripted transport only: this checks local persistence, not model behavior.
  await page.route("**/api/wiki/chat", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ answer: "A synthetic session answer.", sources: [], activity: [] }) }));
  await page.goto("/chat");
  await page.getByLabel("Message").fill("Synthetic follow-up.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("A synthetic session answer.");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("A synthetic session answer.");
  await expect(page.locator(".chat-storage-notice")).toContainText("only in this tab");
  const historyBox = (await page.locator(".chat-history").boundingBox())!;
  const titleBox = (await page.locator(".chat-history-list button").boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(historyBox.x + historyBox.width);
  expect((await page.locator(".chat-storage-notice").boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: testInfo.outputPath("chat-session-only-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".chat-storage-notice")).toBeVisible();
  expect((await page.locator(".chat-storage-notice").boundingBox())!.height).toBeGreaterThanOrEqual(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("chat-session-only-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  await expect(page.locator(".chat-storage-notice")).toContainText("previously saved");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start with a real question." })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!)[0].messages)).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-storage-notice")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1")!).some((item: { id: string }) => item.id === "synthetic-storage"))).toBeFalsy();
});

test("chat storage recovery retains unsaved conversations after article navigation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("secondbrain.chat.conversations.v1", JSON.stringify([{
      id: "saved-before-quota", title: "Saved before quota", updated: 1,
      messages: [{ role: "user", content: "Previously saved question." }],
    }]));
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "secondbrain.chat.conversations.v1")
        throw new DOMException("Synthetic full storage", "QuotaExceededError");
      return set.call(this, key, value);
    };
    window.addEventListener("synthetic-storage-ready", () => { Storage.prototype.setItem = set; }, { once: true });
  });
  await page.route("**/api/wiki/chat", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ answer: "Synthetic answer during quota failure.", sources: [], activity: [] }) }));
  await page.goto("/chat");
  await page.getByLabel("Message").fill("Unsaved follow-up in existing conversation.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer during quota failure.");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Message").fill("Unsaved independent conversation.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText("Synthetic answer during quota failure.");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-storage-notice")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-storage-ready")));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".chat-storage-notice")).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("secondbrain.chat.conversations.v1") || "[]"));
  expect(stored.find((item: { id: string }) => item.id === "saved-before-quota").messages).toHaveLength(3);
  expect(stored.some((item: { messages: Array<{ content: string }> }) =>
    item.messages.some(message => message.content === "Unsaved independent conversation."))).toBeTruthy();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".chat-history-list button")).toHaveCount(3);
});

test("galaxy keyboard return restores its originating page and constellation", async ({ page }) => {
  await page.goto("/galaxy");
  const sky = page.locator(".galaxy-cluster").filter({ hasText: "Sky & navigation" });
  await sky.focus();
  await page.keyboard.press("Enter");
  const selected = page.locator(".galaxy-sidebar-content .galaxy-page").first();
  await expect(selected).toBeFocused();
  const id = await selected.getAttribute("data-node");
  await page.keyboard.press("Enter");
  await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeFocused();
  await page.getByRole("button", { name: "Neighborhood pages" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`.galaxy-sidebar-content .galaxy-page[data-node="${id}"]`)).toBeFocused();
  await page.getByRole("button", { name: "All constellations" }).focus();
  await page.keyboard.press("Enter");
  await expect(sky).toBeFocused();
});

for (const width of [1440, 390]) {
  test(`galaxy overview bundles real bridges and retains directional evidence (${width})`, async ({ page, request }, testInfo) => {
    const group = randomUUID();
    const pages = await Promise.all(["Alpha core", "Alpha leaf", "Beta core", "Beta leaf"].map(title => create(request, `# ${title}\nSynthetic bridge fixture.`)));
    const [a, al, b, bl] = pages;
    const markdown = [
      `---\ngalaxy_group: alpha-${group}\ngalaxy_label: Bridge Alpha ${group}\ngalaxy_anchor: true\n---\n# Alpha core\n[[${al.id}]] [[${b.id}]] [[${bl.id}]]`,
      `---\ngalaxy_group: alpha-${group}\n---\n# Alpha leaf\n[[${b.id}]]`,
      `---\ngalaxy_group: beta-${group}\ngalaxy_label: Bridge Beta ${group}\ngalaxy_anchor: true\n---\n# Beta core\n[[${a.id}]]`,
      `---\ngalaxy_group: beta-${group}\n---\n# Beta leaf\n[[${al.id}]]`,
    ];
    for (let i = 0; i < pages.length; i++) await update(request, pages[i].id, markdown[i], pages[i].revision);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy");
    await expect(page.locator(".galaxy-star").first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`galaxy-bridge-overview-${width}.png`), fullPage: true });
    const title = page.locator(".galaxy-aggregate-link title").filter({ hasText: `Bridge Alpha ${group}` });
    await expect(title).toHaveCount(1);
    await expect(title).toHaveText(`5 explicit links between Bridge Alpha ${group} and Bridge Beta ${group}`);
    await page.locator(`.galaxy-star[data-node="${a.id}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading h2")).toHaveText("Alpha core");
    await expect(page.locator(".galaxy-evidence li")).toHaveCount(4);
    await expect(page.locator(".galaxy-evidence li").filter({ hasText: "Beta core" })).toHaveCount(2);
    await expect(page.locator(".galaxy-aggregate-link")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`galaxy-bridge-evidence-${width}.png`), fullPage: true });
    await page.locator(".galaxy-selected-heading .galaxy-article").click();
    await expect(page).toHaveURL(new RegExp(`/wiki/${a.id}$`));
    await expect(page.locator("article h1")).toHaveText("Alpha core");
  });
}

for (const width of [1440, 390]) {
  test(`galaxy keeps keyboard stars visible after zoom (${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/galaxy");
    const star = page.locator(".galaxy-star").first();
    await expect(star).toBeVisible();
    for (let step = 0; step < 6; step++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "List view", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`galaxy-keyboard-zoom-${width}.png`), fullPage: true });
    const visible = () => star.evaluate(element => {
      const node = element.getBoundingClientRect();
      const stage = element.closest(".galaxy-stage")!.getBoundingClientRect();
      const x = node.left + node.width / 2, y = node.top + node.height / 2;
      return x >= stage.left + 8 && x <= stage.right - 8 && y >= stage.top + 8 && y <= stage.bottom - 8;
    });
    expect(await visible(), "focused star must remain inside the clipped map").toBe(true);
    const map = (await page.locator(".galaxy-stage").boundingBox())!;
    await page.mouse.move(map.x + map.width - 12, map.y + 12);
    await page.mouse.down();
    await page.mouse.move(map.x + 12, map.y + map.height - 12, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString() || ""), "map dragging must not select SVG labels").toBe("");
    await page.getByRole("button", { name: "List view", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    expect(await visible(), "keyboard focus must also recover a panned map").toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`galaxy-keyboard-pan-${width}.png`), fullPage: true });
    await page.keyboard.press("Enter");
    await expect(page.locator(".galaxy-selected-heading .galaxy-article")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/wiki\//);
    await expect(page.locator("article h1")).toBeVisible();
  });
}

for (const finish of ["save", "discard"] as const) {
  test(`PWA preserves a dirty tab when another tab updates, then permits ${finish} and reload`, async ({ page, context, request }, testInfo) => {
    const fixture = await create(request, "# PWA draft fixture\nOriginal synthetic content.");
    const draft = "# PWA draft fixture\nUnsaved synthetic draft.";
    const proxy = await pwaUpdateProxy();
    const other = await context.newPage();
    let unexpectedDialogs = 0;
    page.on("dialog", async dialog => {
      unexpectedDialogs++;
      await dialog.dismiss();
    });
    try {
      await page.goto(`${proxy.origin}/wiki/${fixture.id}`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await other.goto(`${proxy.origin}/?overview=1`);
      await other.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await page.getByRole("button", { name: "Edit page" }).click();
      await page.getByRole("textbox", { name: /Markdown/ }).fill(draft);
      await page.evaluate(() => {
        (window as any).__pwaDocumentMarker = "dirty-original-document";
        (window as any).__pwaControllerChanges = 0;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          (window as any).__pwaControllerChanges++;
        });
      });
      await offerPwaUpdate(page, proxy);
      const notice = page.locator('.pwa-notice[data-kind="update"]');
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      await expect(notice).toContainText(/save.*discard/i);
      if (finish === "save") {
        await page.screenshot({ path: testInfo.outputPath("update-draft-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: testInfo.outputPath("update-draft-mobile.png"), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      }
      await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
      await Promise.all([
        other.waitForEvent("load"),
        other.getByRole("button", { name: "Update now" }).click(),
      ]);
      await page.waitForFunction(() => (window as any).__pwaControllerChanges === 1);
      await expect(page.getByRole("textbox", { name: /Markdown/ })).toHaveValue(draft);
      expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBe("dirty-original-document");
      expect(unexpectedDialogs).toBe(0);
      await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
      if (finish === "save") {
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.locator(".notice")).toContainText("Saved");
      } else {
        page.removeAllListeners("dialog");
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Cancel" }).click();
      }
      await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
      await Promise.all([
        page.waitForEvent("load"),
        notice.getByRole("button", { name: "Update now" }).click(),
      ]);
      await expect(page.locator(".prose")).toContainText(finish === "save" ? "Unsaved synthetic draft." : "Original synthetic content.");
      expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBeUndefined();
      await expect(page.locator('.pwa-notice[data-kind="update"]')).toBeHidden();
    } finally {
      await other.close();
      await page.close();
      await proxy.close();
    }
  });
}


test("PWA blocks update during an unchanged save until the real response arrives", async ({ page, context, request }) => {
  const fixture = await create(request, "# PWA saving fixture\nSynthetic unchanged text.");
  const proxy = await pwaUpdateProxy();
  const other = await context.newPage();
  let held: ReturnType<typeof proxy.holdNextSave> | undefined;
  let unexpectedDialogs = 0;
  page.on("dialog", async dialog => { unexpectedDialogs++; await dialog.dismiss(); });
  try {
    await page.goto(`${proxy.origin}/wiki/${fixture.id}`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await other.goto(`${proxy.origin}/?overview=1`);
    await other.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.getByRole("button", { name: "Edit page" }).click();
    held = proxy.holdNextSave();
    await page.getByRole("button", { name: "Save changes" }).click();
    await held.arrived;
    await expect(page.getByRole("button", { name: "Saving" })).toBeDisabled();
    await page.evaluate(() => {
      (window as any).__pwaDocumentMarker = "saving-document";
      (window as any).__pwaControllerChanges = 0;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        (window as any).__pwaControllerChanges++;
      });
    });
    await offerPwaUpdate(page, proxy);
    const notice = page.locator('.pwa-notice[data-kind="update"]');
    await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
    await expect(notice).toContainText(/sav/i);
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    await expect(other.locator('.pwa-notice[data-kind="update"]')).toBeVisible();
    await Promise.all([other.waitForEvent("load"), other.getByRole("button", { name: "Update now" }).click()]);
    await page.waitForFunction(() => (window as any).__pwaControllerChanges === 1);
    await expect(notice.getByRole("button", { name: "Update now" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Saving" })).toBeDisabled();
    expect(unexpectedDialogs).toBe(0);
    expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBe("saving-document");
    held.release();
    await expect(page.locator(".notice")).toContainText("Saved");
    await expect(notice.getByRole("button", { name: "Update now" })).toBeEnabled();
    await Promise.all([page.waitForEvent("load"), notice.getByRole("button", { name: "Update now" }).click()]);
    await expect(page.locator(".prose")).toContainText("Synthetic unchanged text.");
    expect(await page.evaluate(() => (window as any).__pwaDocumentMarker)).toBeUndefined();
  } finally {
    held?.release();
    await other.close();
    await page.close();
    await proxy.close();
  }
});
