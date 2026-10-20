import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
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

for (const width of [320, 1440]) {
  for (const indent of ["", " ", "  ", "   "]) {
    test(`prefaced ATX title keeps section identities and fragment focus with indent ${indent.length} at ${width}px`, async ({ page, request }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const id = `title-promotion-${randomUUID()}`;
      const title = "Synthetic **bold** &amp; heading ###";
      const label = "Synthetic bold & heading";
      const code = "# Fenced example\n<!-- literal code annotation -->\n";
      const markdown = [
        "---", "label: synthetic fixture", "---", "",
        "## Introductory section", "", "Fictional prose before the title.", "",
        "> # Quoted heading", "",
        "- List preface", "", "  # Listed heading", "",
        "Setext heading", "==============", "",
        "<h1>Raw HTML heading</h1>", "",
        "```markdown", code.trimEnd(), "```", "",
        "<!--", "# Hidden comment heading", "-->", "",
        `${indent}# ${title}`, "", "The promoted heading belongs to this article.", "",
        "## Trailing section", "", "Later content keeps its original section number.", "",
        `# ${title}`, "", "This repeated title is an ordinary section.", "",
        "[Numeric title arrival](#section-6)", "",
        "[Numeric trailing arrival](#section-7)", "",
        `[Named title arrival](#${encodeURIComponent(label)})`, "",
        "[Named trailing arrival](#Trailing-section)", "",
      ].join("\n");
      const owned: string[] = [], errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        const created = await request.post(endpoint(id), { data: {
          markdown, base_revision: null, request_id: randomUUID(),
        } });
        expect(created.ok()).toBeTruthy();
        owned.push(id);
        const saved = await created.json();
        expect(saved.title).toBe(title);
        await page.goto(`/wiki/${id}`);

        const assertArticle = async () => {
          const outer = page.locator("article > h1");
          await expect(outer).toHaveText(label);
          await expect(outer).toHaveAttribute("id", "section-6");
          await expect(outer).toHaveAttribute("data-article-section", "title");
          await expect(outer).toHaveAttribute("data-section-label", label);
          const prose = page.locator(".prose");
          expect(await prose.locator("h1,h2,h3,h4,h5,h6").evaluateAll(headings => headings.map(h => ({
            tag: h.tagName, id: h.id, text: h.textContent,
          })))).toEqual([
            { tag: "H2", id: "section-1", text: "Introductory section" },
            { tag: "H1", id: "section-2", text: "Quoted heading" },
            { tag: "H1", id: "section-3", text: "Listed heading" },
            { tag: "H1", id: "section-4", text: "Setext heading" },
            { tag: "H1", id: "section-5", text: "Raw HTML heading" },
            { tag: "H2", id: "section-7", text: "Trailing section" },
            { tag: "H1", id: "section-8", text: label },
          ]);
          await expect(prose.locator("blockquote h1")).toHaveText("Quoted heading");
          await expect(prose.locator("li h1")).toHaveText("Listed heading");
          expect(await prose.locator("pre code").textContent()).toBe(code);
          await expect(prose).not.toContainText("Hidden comment heading");
          await expect(prose).not.toContainText("synthetic fixture");
          await expect(page.locator("[data-article-title]")).toHaveCount(0);
          const toc = page.getByRole("navigation", { name: "On this page", exact: true });
          expect(await toc.locator("a").evaluateAll(links => links.map(a => ({
            href: a.getAttribute("href"), text: a.textContent,
          })))).toEqual([
            { href: "#section-1", text: "Introductory section" },
            { href: "#section-2", text: "Quoted heading" },
            { href: "#section-3", text: "Listed heading" },
            { href: "#section-4", text: "Setext heading" },
            { href: "#section-5", text: "Raw HTML heading" },
            { href: "#section-6", text: label },
            { href: "#section-7", text: "Trailing section" },
            { href: "#section-8", text: label },
          ]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };

        await assertArticle();
        const outer = page.locator("article > h1");
        const toc = page.getByRole("navigation", { name: "On this page", exact: true });
        await toc.locator('a[href="#section-6"]').click();
        await expect(outer).toBeFocused();
        await toc.locator('a[href="#section-8"]').click();
        await expect(page.locator(".prose #section-8")).toBeFocused();
        for (const [name, selector] of [
          ["Numeric title arrival", "article > h1"],
          ["Numeric trailing arrival", ".prose #section-7"],
          ["Named title arrival", "article > h1"],
          ["Named trailing arrival", ".prose #section-7"],
        ]) {
          await page.locator(".prose").getByRole("link", { name, exact: true }).click();
          await expect(page.locator(selector)).toBeFocused();
        }
        await page.goto(`/wiki/${id}#section-6`);
        await expect(outer).toBeFocused();
        await page.reload();
        await assertArticle();
        await expect(outer).toBeFocused();
        await page.goto(`/wiki/${id}#${encodeURIComponent(label)}`);
        await expect(outer).toBeFocused();
        await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
        await expect(page.locator("#editor")).toHaveValue(markdown);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await assertArticle();
        const stored = await request.get(endpoint(id));
        expect(stored.ok()).toBeTruthy();
        expect(await stored.json()).toMatchObject({ title, markdown, revision: saved.revision });
        const history = await request.get(endpoint(id) + "/history");
        expect(history.ok()).toBeTruthy();
        expect((await history.json()).history).toHaveLength(1);
        await page.screenshot({ path: testInfo.outputPath(`title-promotion-${width}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await removeOwnedPages(request, owned);
      }
    });

  }

  test(`uncertain title sources and leading-title numbering remain unchanged at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const owned: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fallbackId = `title-fallback-${randomUUID()}`;
    const fixtures = [
      {
        id: `title-comment-mismatch-${randomUUID()}`,
        title: "Guarded heading",
        markdown: "Preface.\n\n# Guarded heading <!-- annotation -->\n\n# Guarded heading\n\n## Tail\n",
        headings: ["Guarded heading", "Guarded heading", "Tail"],
      },
      {
        id: `title-html-guard-${randomUUID()}`,
        title: "Guarded HTML heading",
        markdown: "<div>\n# Guarded HTML heading\n</div>\n\n# Guarded HTML heading\n\n## Tail\n",
        headings: ["Guarded HTML heading", "Tail"],
      },
      {
        id: fallbackId,
        title: fallbackId,
        markdown: "```md\n# Code only\n```\n\nSetext section\n==============\n\n<h1>Raw retained heading</h1>\n",
        headings: ["Setext section", "Raw retained heading"],
      },
      {
        id: `title-leading-baseline-${randomUUID()}`,
        title: "Leading title",
        markdown: "# Leading title\n\n## First section\n\n# Leading title\n\n## Last section\n",
        headings: ["First section", "Leading title", "Last section"],
      },
    ];
    try {
      for (const fixture of fixtures) {
        await test.step(fixture.id.split("-").slice(0, 3).join("-"), async () => {
          const created = await request.post(endpoint(fixture.id), { data: {
            markdown: fixture.markdown, base_revision: null, request_id: randomUUID(),
          } });
          expect(created.ok()).toBeTruthy();
          owned.push(fixture.id);
          const saved = await created.json();
          expect(saved.title).toBe(fixture.title);
          await page.goto(`/wiki/${fixture.id}`);
          const assertUnchanged = async () => {
            const outer = page.locator("article > h1");
            await expect(outer).toHaveText(fixture.title);
            expect(await outer.getAttribute("id")).toBeNull();
            expect(await outer.getAttribute("data-article-section")).toBeNull();
            const headings = page.locator(".prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6");
            await expect(headings).toHaveText(fixture.headings);
            expect(await headings.evaluateAll(elements => elements.map(el => el.id))).toEqual(
              fixture.headings.map((_, index) => `section-${index + 1}`),
            );
            const links = page.getByRole("navigation", { name: "On this page", exact: true }).locator("a");
            await expect(links).toHaveText(fixture.headings);
            expect(await links.evaluateAll(elements => elements.map(el => el.getAttribute("href")))).toEqual(
              fixture.headings.map((_, index) => `#section-${index + 1}`),
            );
          };
          await assertUnchanged();
          await page.getByRole("navigation", { name: "On this page", exact: true }).locator('a[href="#section-1"]').click();
          await expect(page.locator(".prose #section-1")).toBeFocused();
          await page.reload();
          await assertUnchanged();
          await page.getByRole("button", { name: "Edit page ↗", exact: true }).click();
          await expect(page.locator("#editor")).toHaveValue(fixture.markdown);
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await assertUnchanged();
          const stored = await request.get(endpoint(fixture.id));
          expect(stored.ok()).toBeTruthy();
          expect(await stored.json()).toMatchObject({
            markdown: fixture.markdown, title: fixture.title, revision: saved.revision,
          });
          const history = await request.get(endpoint(fixture.id) + "/history");
          expect(history.ok()).toBeTruthy();
          expect((await history.json()).history).toHaveLength(1);
        });
      }
      expect(errors).toEqual([]);
    } finally {
      await removeOwnedPages(request, owned);
    }
  });
}


for (const width of [320, 1440]) {
  test(`empty and non-ATX headings keep article identity at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const owned: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [prefix, expected] of [["#\n", null], ["#  \t\n", null],
        ["#\u00a0Not an ATX heading\n", null], ["# \n   # Real title\n", "Real title"],
        ["#  \n   # Real title\n", "Real title"], ["   # \t \n   # Real title\n", "Real title"]]) {
        const id = `empty-title-${randomUUID()}`;
        const markdown = `${prefix}\nVisible following paragraph.\n`;
        const created = await request.post(endpoint(id), { data: {
          markdown, base_revision: null, request_id: randomUUID(),
        } });
        expect(created.ok()).toBe(true);
        owned.push(id);
        const saved = await created.json();
        expect(saved.title).toBe(expected ?? id);
        await page.goto(`/wiki/${id}`);
        await expect(page.locator("article > h1")).toHaveText(expected ?? id);
        await expect(page.locator(".prose")).toContainText("Visible following paragraph.");
        if (expected) {
          await expect(page.locator(".prose h1").filter({ hasText: expected })).toHaveCount(0);
          await expect(page.locator("article > h1")).toHaveAttribute("id", "section-2");
          await expect(page.locator(".prose h1")).toHaveAttribute("id", "section-1");
        }
        await page.reload();
        await expect(page.locator("article > h1")).toHaveText(expected ?? id);
        const stored = await (await request.get(endpoint(id))).json();
        expect(stored).toMatchObject({ markdown, revision: saved.revision });
        expect((await (await request.get(endpoint(id) + "/history")).json()).history).toHaveLength(1);
      }
      expect(errors).toEqual([]);
    } finally {
      await removeOwnedPages(request, owned);
    }
  });
}
