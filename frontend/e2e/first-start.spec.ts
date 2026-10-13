import { test, expect, APIRequestContext, Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

// The runner owns an empty vault and really restarts API + Vite between phases.
// Never run this destructive-to-empty precondition against an ordinary workspace.
const phase = process.env.PLAYWRIGHT_FIRST_START_PHASE;
test.skip(process.env.PLAYWRIGHT_FIRST_START !== "1", "Requires the owned first-start vault runner.");
test.use({ storageState: phase === "restart" ? process.env.PLAYWRIGHT_FIRST_START_STATE : { cookies: [], origins: [] } });

type Receipt = { id: string; markdown: string; revision: string };
type Receipts = { pages: Receipt[]; graphRevision: string; noteHistory: unknown[] };
const homeMarkdown = "# Synthetic welcome\n\nA public first-start example. Follow [[first-note|the first synthetic note]].\n";
const initialNote = "# Synthetic first note\n\nA public example about observing clouds. Return to [[home|the synthetic welcome]].\n";
const editedNote = "# Synthetic first note\n\nA public example about observing clouds. Synthetic persistence marker: silver-cloud-observation. Return to [[home|the synthetic welcome]].\n";

function artifactPath(name: "STATE" | "RECEIPT") {
  const value = process.env[`PLAYWRIGHT_FIRST_START_${name}`];
  expect(value, `Runner must provide an absolute ${name} path`).toBeTruthy();
  expect(isAbsolute(value!)).toBe(true);
  return value!;
}

async function get(request: APIRequestContext, path: string) {
  const response = await request.get(`/api/wiki${path}`);
  expect(response.ok(), `${path}: HTTP ${response.status()} from the real service`).toBe(true);
  return response.json();
}

async function create(request: APIRequestContext, id: string, markdown: string): Promise<Receipt> {
  const response = await request.post(`/api/wiki/pages/${id}`, {
    data: { markdown, base_revision: null, request_id: randomUUID() },
  });
  expect(response.ok(), `Create ${id}: HTTP ${response.status()}`).toBe(true);
  const saved = await response.json();
  expect(saved.revision).toEqual(expect.any(String));
  return { id, markdown, revision: saved.revision };
}

async function screenshots(page: Page, info: TestInfo, name: string, rendered: () => Promise<void>) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await rendered();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function searchNote(page: Page) {
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill("silver-cloud-observation");
  await page.getByRole("button", { name: "Search", exact: false }).click();
  await expect(page.locator("#results .card")).toHaveCount(1);
  await page.locator('#results .card[href="/wiki/first-note"]').click();
  await expect(page.locator("article h1")).toHaveText("Synthetic first note");
  await expect(page.locator(".prose")).toContainText("silver-cloud-observation");
}

test("first start: empty workspace, real first pages, edit and saved preference", async ({ page, request, context }, info) => {
  test.skip(phase !== "create", "Create phase only; restart phase reads the saved receipts.");
  test.setTimeout(90_000);
  const statePath = artifactPath("STATE"), receiptPath = artifactPath("RECEIPT");
  expect((await get(request, "/pages")).pages).toEqual([]);
  const emptyGraph = await get(request, "/graph");
  expect(emptyGraph.nodes).toEqual([]);
  expect(emptyGraph.edges).toEqual([]);
  await page.goto("/");
  await screenshots(page, info, "first-start-empty-home", async () => {
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".library")).toContainText("0 pages");
    await expect(page.locator(".library")).toContainText("create your first page");
    await expect(page.locator(".card")).toHaveCount(0);
  });
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await screenshots(page, info, "first-start-empty-galaxy", async () => {
    await expect(page.getByRole("heading", { name: "A quiet sky." })).toBeVisible();
    await expect(page.locator(".galaxy-snapshot")).toContainText("0 pages");
    await expect(page.locator(".galaxy-star")).toHaveCount(0);
  });
  // Opening Home and Galaxy must not silently import the demo.
  expect((await get(request, "/pages")).pages).toEqual([]);
  const home = await create(request, "home", homeMarkdown);
  const note = await create(request, "first-note", initialNote);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".library .card")).toHaveCount(2);
  await page.getByRole("link", { name: /Open Synthetic welcome/ }).click();
  await expect(page.locator("article h1")).toHaveText("Synthetic welcome");
  await page.locator(".prose").getByRole("link", { name: "the first synthetic note", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Synthetic first note");
  await page.getByRole("button", { name: "Edit page" }).click();
  await page.getByRole("textbox", { name: /Markdown/ }).fill(editedNote);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toContainText("Saved");
  const saved = await get(request, "/pages/first-note");
  expect(saved.markdown).toBe(editedNote);
  expect(saved.revision).not.toBe(note.revision);
  await expect(page.locator(".revision")).toContainText(saved.revision.slice(0, 8));
  await searchNote(page);
  await page.getByRole("button", { name: "Set as start page" }).click();
  await expect(page.locator(".notice")).toContainText("This is now your start page.");

  // Scripted delay of an unmodified real graph response; no invented response body.
  // Observe JSON completion after route() has had a turn to reject stale work.
  await page.addInitScript(() => {
    const json = Response.prototype.json;
    (window as any).__firstStartGraphBodies = 0;
    Response.prototype.json = async function () {
      const body = await json.call(this);
      if (this.url && new URL(this.url).pathname === "/api/wiki/graph")
        setTimeout(() => { (window as any).__firstStartGraphBodies++; }, 0);
      return body;
    };
  });
  await page.goto("/?overview=1");
  let release!: () => void, arrived!: () => void, completed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { arrived = resolve; });
  const delivered = new Promise<void>(resolve => { completed = resolve; });
  await page.route("**/api/wiki/graph", async route => {
    try {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      arrived();
      await gate;
      await route.fulfill({ response });
    } finally { completed(); }
  }, { times: 1 });
  try {
    await page.getByRole("link", { name: "Galaxy", exact: true }).click();
    await fetched;
    await expect(page.locator("main")).toHaveText("Opening your workspace…");
    await page.screenshot({ path: info.outputPath("first-start-real-graph-loading.png"), fullPage: true });
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(page.locator(".library .card")).toHaveCount(2);
    release();
    await delivered;
    await page.waitForFunction(() => (window as any).__firstStartGraphBodies === 1);
    await expect(page).toHaveURL(/\/?\?overview=1$/);
    await expect(page.locator(".library .card")).toHaveCount(2);
    await expect(page.locator(".galaxy")).toHaveCount(0);
  } finally { release(); }

  // Scripted transport failure, not evidence of a real API outage. Retry reaches
  // the running service after the one-shot abort has been consumed.
  await page.route("**/api/wiki/graph", route => route.abort("failed"), { times: 1 });
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await screenshots(page, info, "first-start-scripted-transport-error", async () => {
    await expect(page.getByRole("heading", { name: "Couldn’t open the workspace." })).toBeVisible();
    await expect(page.locator(".galaxy")).toHaveCount(0);
    await expect(page.locator("main")).toContainText("Check your connection and try again.");
  });
  const failedUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".galaxy-snapshot")).toContainText("2 pages");
  await expect(page.locator(".galaxy-star")).toHaveCount(2);
  expect(page.url()).toBe(failedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page.getByRole("link", { name: "Galaxy", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/");
  await expect(page).toHaveURL(/\/wiki\/first-note$/);
  await screenshots(page, info, "first-start-saved-note", async () => {
    await expect(page.locator("article h1")).toHaveText("Synthetic first note");
    await expect(page.locator(".prose")).toContainText("silver-cloud-observation");
  });
  const graph = await get(request, "/graph");
  expect(graph.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["first-note", "home"]);
  expect(graph.edges).toHaveLength(2);
  expect(graph.missing_targets).toEqual([]);
  const savedHome = await get(request, "/pages/home");
  expect({ id: savedHome.id, markdown: savedHome.markdown, revision: savedHome.revision }).toEqual(home);
  const history = await get(request, "/pages/first-note/history");
  expect(history.history.length).toBeGreaterThanOrEqual(2);
  const receipts: Receipts = { pages: [home, { id: "first-note", markdown: saved.markdown, revision: saved.revision }], graphRevision: graph.revision, noteHistory: history.history };
  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await context.storageState({ path: statePath });
  await writeFile(receiptPath, JSON.stringify(receipts, null, 2) + "\n");
});

test("first start: real process restart preserves exact pages and browser preference", async ({ page, request }, info) => {
  test.skip(phase !== "restart", "Restart phase only; create phase writes the receipts.");
  test.setTimeout(90_000);
  artifactPath("STATE");
  const receipts: Receipts = JSON.parse(await readFile(artifactPath("RECEIPT"), "utf8"));
  expect(receipts.pages.map(item => item.id).sort()).toEqual(["first-note", "home"]);
  const listed = await get(request, "/pages");
  expect(listed.pages.map((item: { id: string }) => item.id).sort()).toEqual(["first-note", "home"]);
  for (const expected of receipts.pages) {
    const actual = await get(request, `/pages/${expected.id}`);
    expect({ id: actual.id, markdown: actual.markdown, revision: actual.revision }).toEqual(expected);
  }
  const graph = await get(request, "/graph");
  expect(graph.revision).toBe(receipts.graphRevision);
  expect(graph.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["first-note", "home"]);
  expect(graph.edges).toHaveLength(2);
  expect(graph.missing_targets).toEqual([]);
  expect((await get(request, "/pages/first-note/history")).history).toEqual(receipts.noteHistory);
  await page.goto("/");
  await expect(page).toHaveURL(/\/wiki\/first-note$/);
  expect(await page.evaluate(() => localStorage.getItem("secondbrain.startpage"))).toBe("first-note");
  await page.getByText("Local Git history", { exact: true }).click();
  await expect(page.locator(".history-list li")).toHaveCount(receipts.noteHistory.length);
  await screenshots(page, info, "first-start-restarted-note-history", async () => {
    await expect(page.locator(".prose")).toContainText("silver-cloud-observation");
    await expect(page.locator(".history-list li").first()).toBeVisible();
  });
  await page.locator(".prose").getByRole("link", { name: "the synthetic welcome", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Synthetic welcome");
  await page.goBack();
  await expect(page.locator("article h1")).toHaveText("Synthetic first note");
  await searchNote(page);
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await screenshots(page, info, "first-start-restarted-galaxy", async () => {
    await expect(page.locator(".galaxy-snapshot")).toContainText("2 pages");
    await expect(page.locator(".galaxy-snapshot")).toContainText("2 explicit links");
    await expect(page.locator(".galaxy-star")).toHaveCount(2);
  });
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("first-note");
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await page.locator('.galaxy-page[data-node="first-note"]').click();
  await expect(page.locator(".galaxy-evidence li")).toHaveCount(2);
  await page.getByRole("link", { name: /^Open article/ }).click();
  await expect(page.locator(".prose")).toContainText("silver-cloud-observation");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await screenshots(page, info, "first-start-restarted-home", async () => {
    await expect(page.locator(".library .card")).toHaveCount(2);
    await expect(page.locator(".library")).toContainText("2 pages");
  });
});
