import { test, expect, APIRequestContext, Page, TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

// Only the runner's isolated, public fixture vault may exercise these phases.
const phase = process.env.PLAYWRIGHT_GIT_IMPORT_PHASE;
test.skip(process.env.PLAYWRIGHT_GIT_IMPORT !== "1", "Requires the owned Git-import runner.");
test.use({ storageState: phase === "restart" ? process.env.PLAYWRIGHT_GIT_IMPORT_STATE : { cookies: [], origins: [] } });
type SavedPage = { id: string; markdown: string; revision: string };
type Entry = { commit: string; date: string; message: string };
type Graph = { revision: string; nodes: { id: string; [key: string]: unknown }[]; edges: { source: string; target: string; type: string }[]; missing_targets: { source: string; target: string }[] };
type Receipt = { pages: SavedPage[]; history: Entry[]; graph: Graph };
type Inputs = Receipt & { source_commits: string[] };
function artifact(name: "INPUTS" | "RECEIPT" | "STATE") {
  const value = process.env[`PLAYWRIGHT_GIT_IMPORT_${name}`];
  expect(value, `Runner must provide ${name}`).toBeTruthy();
  expect(isAbsolute(value!)).toBe(true);
  return value!;
}
async function get(request: APIRequestContext, path: string) {
  const response = await request.get(`/api/wiki${path}`);
  expect(response.ok(), `${path}: real service returned ${response.status()}`).toBe(true);
  return response.json();
}
function graphReceipt(graph: Graph): Graph { return graph; }
async function verify(request: APIRequestContext, expected: Receipt) {
  expect(expected.pages).toHaveLength(12);
  expect((await get(request, "/pages")).pages.map((item: SavedPage) => item.id).sort()).toEqual(expected.pages.map(item => item.id).sort());
  for (const item of expected.pages) {
    const actual = await get(request, `/pages/${item.id}`);
    expect({ id: actual.id, markdown: actual.markdown, revision: actual.revision }).toEqual(item);
  }
  expect(graphReceipt(await get(request, "/graph"))).toEqual(expected.graph);
  const note = expected.pages.find(item => item.id.endsWith("night-sky-survey"))!;
  expect((await get(request, `/pages/${note.id}/history`)).history).toEqual(expected.history);
}
async function screenshots(page: Page, info: TestInfo, name: string, rendered: () => Promise<void>) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await rendered();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow").toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function historyUI(page: Page, entries: Entry[]) {
  await page.getByText("Local Git history", { exact: true }).click();
  const rows = page.locator(".history-list li");
  await expect(rows).toHaveCount(entries.length);
  for (const [index, entry] of entries.entries()) {
    await expect(rows.nth(index).locator("p")).toHaveText(entry.message);
    await expect(rows.nth(index).locator("code")).toHaveText(entry.commit.slice(0, 8));
    await expect(rows.nth(index).locator("code")).toHaveAttribute("title", entry.commit);
    await expect(rows.nth(index).locator("time")).toHaveAttribute("datetime", entry.date);
  }
}
async function search(page: Page, marker: string, id: string) {
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill(marker);
  await page.getByRole("button", { name: "Search", exact: false }).click();
  await expect(page.locator("#results .card")).toHaveCount(1);
  await page.locator(`#results .card[href="/wiki/${id}"]`).click();
  await expect(page.locator("article h1")).toHaveText("Night sky survey");
  await expect(page.locator(".prose")).toContainText(marker);
}
async function galaxy(page: Page, info: TestInfo, expected: Receipt, name: string) {
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await screenshots(page, info, name, async () => {
    await expect(page.locator(".galaxy-snapshot")).toContainText("12 pages");
    await expect(page.locator(".galaxy-snapshot")).toContainText(`${expected.graph.edges.length} explicit links`);
    await expect(page.locator(".galaxy-star")).toHaveCount(12);
  });
  const id = expected.pages.find(item => item.id.endsWith("night-sky-survey"))!.id;
  await page.getByRole("searchbox", { name: "Find a page in this snapshot" }).fill("night-sky-survey");
  await expect(page.locator(".galaxy-page")).toHaveCount(1);
  await page.locator(`.galaxy-page[data-node="${id}"]`).click();
  await expect(page.locator(".galaxy-evidence li")).toHaveCount(expected.graph.edges.filter(edge => edge.source === id || edge.target === id).length);
  await page.getByRole("link", { name: /^Open article/ }).click();
  await expect(page.locator("article h1")).toHaveText("Night sky survey");
}

test("Git import: empty first start does not seed the public demo", async ({ page, request }, info) => {
  test.skip(phase !== "empty", "Empty phase only.");
  expect((await get(request, "/pages")).pages).toEqual([]);
  const graph = await get(request, "/graph");
  expect(graph.nodes).toEqual([]); expect(graph.edges).toEqual([]); expect(graph.missing_targets).toEqual([]);
  await page.goto("/");
  await screenshots(page, info, "git-import-empty-home", async () => {
    await expect(page.getByRole("heading", { name: "A growing collection" })).toBeVisible();
    await expect(page.locator(".library")).toContainText("0 pages");
    await expect(page.locator(".library")).toContainText("create your first page");
    await expect(page.locator(".card")).toHaveCount(0);
  });
  await page.getByRole("link", { name: "Galaxy", exact: true }).click();
  await screenshots(page, info, "git-import-empty-galaxy", async () => {
    await expect(page.getByRole("heading", { name: "A quiet sky." })).toBeVisible();
    await expect(page.locator(".galaxy-snapshot")).toContainText("0 pages");
    await expect(page.locator(".galaxy-star")).toHaveCount(0);
  });
  expect((await get(request, "/pages")).pages).toEqual([]);
  expect(graphReceipt(await get(request, "/graph"))).toEqual(graphReceipt(graph));
});

test("Git import: exact public source, real navigation, history and browser save", async ({ page, request, context }, info) => {
  test.skip(phase !== "import", "Import phase only."); test.setTimeout(90_000);
  const inputs: Inputs = JSON.parse(await readFile(artifact("INPUTS"), "utf8"));
  await verify(request, inputs);
  const note = inputs.pages.find(item => item.id.endsWith("night-sky-survey"))!;
  expect(inputs.source_commits).toHaveLength(2);
  for (const commit of inputs.source_commits) expect(inputs.history.map(entry => entry.commit)).toContain(commit);
  await page.goto("/");
  await screenshots(page, info, "git-import-home", async () => {
    await expect(page.locator(".library .card")).toHaveCount(12);
    await expect(page.locator(".library")).toContainText("12 pages");
  });
  await page.getByRole("link", { name: /Open Lantern Bay field atlas/ }).click();
  await expect(page.locator("article h1")).toHaveText("Lantern Bay field atlas");
  await page.locator(".prose").getByRole("link", { name: "night sky survey", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Night sky survey");
  await historyUI(page, inputs.history);
  await screenshots(page, info, "git-import-source-history", async () => {
    await expect(page.locator(".prose")).toContainText("synthetic-import-marker");
    await expect(page.locator(".history-list li")).toHaveCount(inputs.history.length);
  });
  await search(page, "synthetic-import-marker", note.id);
  await galaxy(page, info, inputs, "git-import-galaxy");
  const markdown = note.markdown + "\n\nBrowser persistence marker: browser-import-edit-marker.\n";
  await page.getByRole("button", { name: "Edit page" }).click();
  await page.getByRole("textbox", { name: /Markdown/ }).fill(markdown);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toContainText("Saved");
  const saved = await get(request, `/pages/${note.id}`);
  expect(saved.markdown).toBe(markdown); expect(saved.revision).not.toBe(note.revision);
  await expect(page.locator(".revision")).toContainText(saved.revision.slice(0, 8));
  const history: Entry[] = (await get(request, `/pages/${note.id}/history`)).history;
  expect(history).toHaveLength(inputs.history.length + 1); expect(history.slice(1)).toEqual(inputs.history);
  expect(history[0].commit).not.toBe(inputs.history[0].commit);
  await page.getByRole("button", { name: "Set as start page" }).click();
  await expect(page.locator(".notice")).toContainText("This is now your start page.");
  await historyUI(page, history);
  const receipt: Receipt = { pages: inputs.pages.map(item => item.id === note.id ? { id: saved.id, markdown: saved.markdown, revision: saved.revision } : item), history, graph: graphReceipt(await get(request, "/graph")) };
  expect(receipt.graph.nodes).toEqual(inputs.graph.nodes); expect(receipt.graph.edges).toEqual(inputs.graph.edges); expect(receipt.graph.missing_targets).toEqual(inputs.graph.missing_targets);
  await verify(request, receipt);
  await screenshots(page, info, "git-import-browser-saved", async () => {
    await expect(page.locator(".prose")).toContainText("browser-import-edit-marker");
    await expect(page.locator(".history-list li")).toHaveCount(history.length);
  });
  await mkdir(dirname(artifact("STATE")), { recursive: true }); await mkdir(dirname(artifact("RECEIPT")), { recursive: true });
  await context.storageState({ path: artifact("STATE") });
  await writeFile(artifact("RECEIPT"), JSON.stringify(receipt, null, 2) + "\n");
});

test("Git import: replay and real restart retain exact content and start page", async ({ page, request }, info) => {
  test.skip(phase !== "restart", "Restart phase only."); test.setTimeout(90_000); artifact("STATE");
  const receipt: Receipt = JSON.parse(await readFile(artifact("RECEIPT"), "utf8"));
  await verify(request, receipt);
  const note = receipt.pages.find(item => item.id.endsWith("night-sky-survey"))!;
  await page.goto("/"); await expect(page).toHaveURL(new RegExp(`/wiki/${note.id}$`));
  expect(await page.evaluate(() => localStorage.getItem("secondbrain.startpage"))).toBe(note.id);
  await historyUI(page, receipt.history);
  await screenshots(page, info, "git-import-restarted-history", async () => {
    await expect(page.locator(".prose")).toContainText("synthetic-import-marker");
    await expect(page.locator(".prose")).toContainText("browser-import-edit-marker");
    await expect(page.locator(".history-list li")).toHaveCount(receipt.history.length);
  });
  await page.locator(".prose").getByRole("link", { name: "tide clock", exact: true }).click();
  await expect(page.locator("article h1")).toHaveText("Tide clock project");
  await search(page, "browser-import-edit-marker", note.id);
  await galaxy(page, info, receipt, "git-import-restarted-galaxy");
  await expect(page.locator(".prose")).toContainText("browser-import-edit-marker");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await screenshots(page, info, "git-import-restarted-home", async () => {
    await expect(page.locator(".library .card")).toHaveCount(12);
    await expect(page.locator(".library")).toContainText("12 pages");
  });
});
