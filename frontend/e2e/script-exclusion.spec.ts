import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";

// These assert the article's excluded-SCRIPT policy, not backend link parity.
// Complex backend rawtext projection remains a separate known limitation.
const bodies = [
  'Note <script>Fictional script sentinel [[T|Hidden notebook]]</script>',
  'Note <ScRiPt>Fictional script sentinel [[T|Hidden notebook]]</sCrIpT>',
  'Note <script data-note="x>y">Fictional script sentinel [[T|Hidden notebook]]</script>',
  'Note <script>\nFictional script sentinel [[T|Hidden notebook]]\n</script>',
  'Note <script>Fictional script sentinel\n\n[[T|Hidden notebook]]</script>',
  'Note <script>`</script>` Fictional script sentinel [[T|Hidden notebook]]</script>',
  'Note <script><kbd>Fictional script sentinel [[T|Hidden notebook]]</kbd></script>',
  'Note <script><!-- Fictional script sentinel [[T|Hidden notebook]] --> </script>',
  '<script>Fictional script sentinel [[T|Hidden notebook]]</script>',
  '<div>Fictional wrapper <script>Fictional script sentinel</script></div>',
  'Note <button>Fictional wrapper <script>Fictional script sentinel</script></button>',
  'Note <script>window.__excludedScript = true; "Fictional script sentinel";</script>',
];

for (const width of [390, 1440]) {
  test(`script bodies are excluded without changing source or prose links (${width})`, async ({ page, request }, info) => {
    const owned: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    async function create(markdown: string) {
      const id = `script-exclusion-${randomUUID()}`;
      const response = await request.post(`/api/wiki/pages/${id}`, {
        data: { markdown, base_revision: null, request_id: randomUUID() },
      });
      expect(response.ok()).toBe(true); owned.push(id);
      return { id, ...(await response.json()) };
    }
    try {
      const target = await create("# Fictional notebook");
      for (const [index, body] of bodies.entries()) {
        const markdown = `# Fictional script article\n\n${body.split("[[T").join(`[[${target.id}`)}\n\n<kbd>[[${target.id}|Keyboard notebook]]</kbd> and [[${target.id}|Control notebook]]\n`;
        const saved = await create(markdown);
        await page.goto(`/wiki/${saved.id}`);
        for (const name of ["Keyboard notebook", "Control notebook"]) {
          await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("href", `/wiki/${target.id}`);
        }
        await expect(page.locator(".prose")).not.toContainText("Fictional script sentinel");
        await expect(page.locator(".prose")).not.toContainText("data-wiki-target");
        if (index === 9 || index === 10)
          await expect(page.locator(".prose")).toContainText("Fictional wrapper");
        await expect(page.locator(".prose script,.prose a[data-wiki-target]").filter({ hasText: "Hidden notebook" })).toHaveCount(0);
        await expect(page.locator(".prose script")).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).__excludedScript)).toBeUndefined();
        const read = await request.get(`/api/wiki/pages/${saved.id}`);
        expect(read.ok()).toBe(true);
        const current = await read.json();
        expect(current.markdown).toBe(markdown); expect(current.revision).toBe(saved.revision);
        console.info("[script-exclusion] " + JSON.stringify({ width, case: index, source_preserved: true }));
        if (index === 4) await page.screenshot({ path: info.outputPath(`script-exclusion-${width}.png`) });
      }
      // An escaped opener and code examples remain readable literal examples.
      const literal = await create(`# Fictional literal examples\n\n\\<script>Fictional escaped example\\</script>\n\n\`<script>Fictional code example</script>\`\n\n\`\`\`html\n<script>Fictional fenced example</script>\n\`\`\`\n`);
      await page.goto(`/wiki/${literal.id}`);
      for (const text of ["Fictional escaped example", "Fictional code example", "Fictional fenced example"])
        await expect(page.locator(".prose")).toContainText(text);
      await expect(page.locator(".prose")).toContainText("<script>Fictional escaped example</script>");
      await expect(page.locator(".prose p code")).toHaveText("<script>Fictional code example</script>");
      await expect(page.locator(".prose pre code")).toHaveText("<script>Fictional fenced example</script>\n");
      expect(errors).toEqual([]);
    } finally {
      for (const id of owned.reverse()) {
        const current = await request.get(`/api/wiki/pages/${id}`); expect(current.ok()).toBe(true);
        expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
          base_revision: (await current.json()).revision, request_id: randomUUID(),
        } })).ok()).toBe(true);
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`bounded inline SCRIPT graph matches actual article (${width})`, async ({ page, request }) => {
    const owned: string[] = [];
    await page.setViewportSize({ width, height: 900 });
    async function create(markdown: string) {
      const id = `bounded-script-${randomUUID()}`;
      const response = await request.post(`/api/wiki/pages/${id}`, {
        data: { markdown, base_revision: null, request_id: randomUUID() },
      });
      expect(response.ok()).toBe(true); owned.push(id);
      return { id, ...(await response.json()) };
    }
    try {
      const target = await create("# Fictional target");
      const control = await create("# Fictional control");
      const inputs = [
        ["Note <script>hiddenmarker [[T]]</script>", false],
        ["Note <ScRiPt>hiddenmarker [[T]]</sCrIpT>", false],
        ["Note <script>window.__excludedScript=true; // hiddenmarker [[T]]</script>", false],
        ["Note <script>hiddenmarker</script> [[T]]", true],
        ["Note <script>hiddenmarker [[T]]</script> after <script>[[T]]</script>", false],
        ["1.     Note <script>hiddenmarker [[T]]</script>", false],
        ["Note <ſcript>hiddenmarker [[T]]</ſcript>", true],
        ["`<script>hiddenmarker [[T]]</script>`", false],
      ] as const;
      for (const [index, [body, visible]] of inputs.entries()) {
        const markdown = `# Fictional bounded article\n\nControl [[${control.id}]].\n\n${body.split("[[T]]").join(`[[${target.id}]]`)}`;
        const saved = await create(markdown);
        await page.goto(`/wiki/${saved.id}`);
        await expect(page.locator(`.prose a[href="/wiki/${control.id}"]`)).toBeVisible();
        await expect(page.locator(`.prose a[href="/wiki/${target.id}"]`)).toHaveCount(visible ? 1 : 0);
        const graph = await (await request.get("/api/wiki/graph")).json();
        expect(graph.edges.filter((edge: any) => edge.source === saved.id).map((edge: any) => edge.target).sort())
          .toEqual([control.id, ...(visible ? [target.id] : [])].sort());
        const current = await (await request.get(`/api/wiki/pages/${saved.id}`)).json();
        expect(current.markdown).toBe(markdown); expect(current.revision).toBe(saved.revision);
        if ([0, 1, 2, 4].includes(index)) expect(current.excerpt).not.toContain("hiddenmarker");
        expect(await page.evaluate(() => (window as any).__excludedScript)).toBeUndefined();
      }
    } finally {
      const failures: string[] = [];
      for (const id of owned.reverse()) {
        try {
          const read = await request.get(`/api/wiki/pages/${id}`);
          expect(read.ok()).toBe(true);
          expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
            base_revision: (await read.json()).revision, request_id: randomUUID(),
          } })).ok()).toBe(true);
        } catch { failures.push(id); }
      }
      expect(failures, "Remove every owned fixture, including after a failed cleanup").toEqual([]);
    }
  });
}

