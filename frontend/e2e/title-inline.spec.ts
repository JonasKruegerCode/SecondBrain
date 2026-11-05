import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./reading-test";

const endpoint = (id: string) => `/api/wiki/pages/${encodeURIComponent(id)}`;

async function removeOwnedPages(request: APIRequestContext, owned: string[]) {
  for (const id of [...owned].reverse()) {
    const current = await request.get(endpoint(id));
    expect(current.ok()).toBeTruthy();
    const removed = await request.delete(endpoint(id), { data: {
      base_revision: (await current.json()).revision, request_id: randomUUID(),
    } });
    expect(removed.ok()).toBeTruthy();
  }
}

async function assertInertTitle(title: Locator) {
  expect(await title.locator("*").evaluateAll(elements => elements.every(el =>
    ["STRONG", "EM", "DEL", "CODE", "BR"].includes(el.tagName) && el.getAttributeNames().length === 0,
  ))).toBe(true);
  await expect(title.locator("a,img,input,button,script,iframe,svg,style")).toHaveCount(0);
}

async function assertRawSnapshot(page: Page, request: APIRequestContext, id: string,
  markdown: string, title: string, revision: string, assertReading: () => Promise<void>) {
  await expect(page).toHaveTitle(`${title} · Secondbrain`);
  await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
  await expect(page.locator("#editor")).toHaveValue(markdown);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertReading();
  await page.reload();
  await assertReading();
  await expect(page).toHaveTitle(`${title} · Secondbrain`);
  const stored = await request.get(endpoint(id));
  expect(stored.ok()).toBeTruthy();
  expect(await stored.json()).toMatchObject({ title, markdown, revision });
  const history = await request.get(endpoint(id) + "/history");
  expect(history.ok()).toBeTruthy();
  expect((await history.json()).history).toHaveLength(1);
}

for (const width of [390, 1440]) {
  test(`image heading labels preserve section navigation at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const owned: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const promoted of [false, true]) {
        const id = `image-heading-${randomUUID()}`;
        const markdown = [
          promoted ? "Fictional preface." : "# Fictional atlas", "",
          "[Read chart](#chart)", "", "[Read notes](#coast-marker-notes)", "",
          `${promoted ? "#" : "##"} ![Chart](/app-icon.svg)`, "",
          "## Coast ![marker](/app-icon.svg) &amp; `notes`", "",
          "## ![](/app-icon.svg)", "",
        ].join("\n");
        const created = await request.post(endpoint(id), { data: {
          markdown, base_revision: null, request_id: randomUUID(),
        } });
        expect(created.ok()).toBeTruthy();
        owned.push(id);
        const saved = await created.json();
        await page.goto(`/wiki/${id}`);
        const chart = page.locator("article #section-1");
        const notes = page.locator(".prose #section-2");
        const assertReading = async () => {
          const toc = page.getByRole("navigation", { name: "On this page", exact: true });
          await expect(toc.locator("a")).toHaveText(["Chart", "Coast marker & notes", "Untitled section"]);
          await expect.poll(() => page.locator('.prose img[alt="marker"]').evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
          )).toBe(true);
          if (promoted) {
            await expect(chart).toHaveText("Chart");
            await expect(chart).toHaveAttribute("data-article-section", "title");
            await assertInertTitle(chart);
          } else {
            await expect(chart.getByRole("img", { name: "Chart", exact: true })).toHaveCount(1);
          }
          for (const [label, target] of [["Chart", chart], ["Coast marker & notes", notes], ["Untitled section", page.locator(".prose #section-3")]] as const) {
            await toc.getByRole("link", { name: label, exact: true }).click();
            await expect(target).toBeFocused();
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await assertReading();
        await page.locator(".prose").getByRole("link", { name: "Read chart", exact: true }).click();
        await expect(chart).toBeFocused();
        await page.locator(".prose").getByRole("link", { name: "Read notes", exact: true }).click();
        await expect(notes).toBeFocused();
        await page.goto(`/wiki/${id}#chart`);
        await expect(chart).toBeFocused();
        await page.reload();
        await expect(chart).toBeFocused();
        await assertRawSnapshot(page, request, id, markdown, saved.title, saved.revision, assertReading);
        await page.screenshot({ path: testInfo.outputPath(`image-heading-${promoted ? "promoted" : "section"}-${width}.png`), fullPage: true });
      }
      expect(errors).toEqual([]);
    } finally {
      await removeOwnedPages(request, owned);
    }
  });

  test(`confirmed title inline formatting preserves article identity at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const owned: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const raw = "Synthetic **bold** *em* ~~gone~~ `code` &amp; heading ###";
    const label = "Synthetic bold em gone code & heading";
    try {
      for (const prefaced of [false, true]) {
        const id = `title-inline-${prefaced ? "prefaced" : "leading"}-${randomUUID()}`;
        const markdown = [
          ...(prefaced ? ["## Intro", "", "Fictional preface.", ""] : []),
          `# ${raw}`, "", "## Tail", "", `# ${raw}`, "",
          ...(prefaced ? [
            "[Numeric title arrival](#section-2)", "",
            `[Named title arrival](#${encodeURIComponent(label)})`, "",
            "[Numeric tail arrival](#section-3)", "",
          ] : []),
        ].join("\n");
        const created = await request.post(endpoint(id), { data: {
          markdown, base_revision: null, request_id: randomUUID(),
        } });
        expect(created.ok()).toBeTruthy();
        owned.push(id);
        const saved = await created.json();
        expect(saved.title).toBe(raw);
        await page.goto(`/wiki/${id}`);
        const title = page.locator("article > h1");
        const assertReading = async () => {
          await expect(title).toHaveText(label);
          await expect(title.locator("strong")).toHaveText("bold");
          await expect(title.locator("em")).toHaveText("em");
          await expect(title.locator("del")).toHaveText("gone");
          await expect(title.locator("code")).toHaveText("code");
          await assertInertTitle(title);
          const headings = page.locator(".prose h1,.prose h2");
          await expect(headings).toHaveText(prefaced ? ["Intro", "Tail", label] : ["Tail", label]);
          expect(await headings.evaluateAll(elements => elements.map(el => el.id))).toEqual(
            prefaced ? ["section-1", "section-3", "section-4"] : ["section-1", "section-2"],
          );
          const toc = page.getByRole("navigation", { name: "On this page", exact: true });
          await expect(toc.locator("a")).toHaveText(prefaced ? ["Intro", label, "Tail", label] : ["Tail", label]);
          if (prefaced) {
            await expect(title).toHaveAttribute("id", "section-2");
            await expect(title).toHaveAttribute("data-article-section", "title");
            await expect(title).toHaveAttribute("data-section-label", label);
          } else {
            expect(await title.getAttribute("id")).toBeNull();
            expect(await title.getAttribute("data-article-section")).toBeNull();
          }
          await expect(page.locator("[data-article-title]")).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await assertReading();
        if (prefaced) {
          await page.getByRole("navigation", { name: "On this page", exact: true }).locator('a[href="#section-2"]').click();
          await expect(title).toBeFocused();
          for (const name of ["Numeric title arrival", "Named title arrival"]) {
            await page.locator(".prose").getByRole("link", { name, exact: true }).click();
            await expect(title).toBeFocused();
          }
          await page.locator(".prose").getByRole("link", { name: "Numeric tail arrival", exact: true }).click();
          await expect(page.locator(".prose #section-3")).toBeFocused();
          await page.goto(`/wiki/${id}#${encodeURIComponent(label)}`);
          await expect(title).toBeFocused();
          await page.reload();
          await expect(title).toBeFocused();
        }
        await assertRawSnapshot(page, request, id, markdown, raw, saved.revision, assertReading);
        await page.screenshot({ path: testInfo.outputPath(`title-inline-${prefaced ? "prefaced" : "leading"}-${width}.png`), fullPage: true });
      }
      expect(errors).toEqual([]);
    } finally {
      await removeOwnedPages(request, owned);
    }
  });

  test(`title markup stays inert and uncertain sources stay literal at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const owned: string[] = [], errors: string[] = [], imageRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.url().startsWith("https://title-inline.invalid/")) imageRequests.push(request.url());
    });
    const raw = 'Safe **bold** [link](https://example.invalid/title) [[title-inline-missing|wiki label]] ![image label](https://title-inline.invalid/pixel.png) ![blocked label](javascript:alert%281%29) <em style="color:red" onmouseover="window.titleInlineActivated=true">em</em> <button autofocus onclick="window.titleInlineActivated=true">button label</button><input disabled type="checkbox"><br>end ###';
    const label = "Safe bold link wiki label image label blocked label em button labelend";
    const fallbackId = `title-inline-fallback-${randomUUID()}--_literal_`;
    const fixtures = [
      ...[false, true].map(prefaced => ({
        id: `title-inline-safe-${prefaced ? "prefaced" : "leading"}-${randomUUID()}`,
        markdown: `${prefaced ? "Fictional preface.\n\n" : ""}# ${raw}\n\n## Tail\n`,
        title: raw, label, formatted: true,
      })),
      {
        id: `title-inline-ambiguous-${randomUUID()}`,
        markdown: "Fictional preface.\n\n# Guarded **heading** <!-- annotation -->\n\n# Guarded **heading**\n\n## Tail\n",
        title: "Guarded **heading**", label: "Guarded **heading**", formatted: false,
      },
      {
        id: fallbackId,
        markdown: "```md\n# Only a code example\n```\n\n## Tail\n",
        title: fallbackId, label: fallbackId, formatted: false,
      },
      {
        id: `title-inline-empty-${randomUUID()}`,
        markdown: "# ![](https://title-inline.invalid/empty.png)\n\n## Tail\n",
        title: "![](https://title-inline.invalid/empty.png)",
        label: "![](https://title-inline.invalid/empty.png)", formatted: false,
      },
    ];
    try {
      for (const fixture of fixtures) {
        const created = await request.post(endpoint(fixture.id), { data: {
          markdown: fixture.markdown, base_revision: null, request_id: randomUUID(),
        } });
        expect(created.ok()).toBeTruthy();
        owned.push(fixture.id);
        const saved = await created.json();
        expect(saved.title).toBe(fixture.title);
        await page.goto(`/wiki/${fixture.id}`);
        const title = page.locator("article > h1");
        const assertReading = async () => {
          await expect(title).toHaveText(fixture.label);
          await assertInertTitle(title);
          if (fixture.formatted) {
            await expect(title.locator("strong")).toHaveText("bold");
            await expect(title.locator("em")).toHaveText("em");
            await expect(title.locator("br")).toHaveCount(1);
          } else {
            await expect(title.locator("*")).toHaveCount(0);
            expect(await title.getAttribute("data-article-section")).toBeNull();
          }
          expect(await page.evaluate(() => (window as unknown as { titleInlineActivated?: boolean }).titleInlineActivated)).toBeUndefined();
        };
        await assertReading();
        await assertRawSnapshot(page, request, fixture.id, fixture.markdown, fixture.title, saved.revision, assertReading);
      }
      expect(imageRequests).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await removeOwnedPages(request, owned);
    }
  });
}
