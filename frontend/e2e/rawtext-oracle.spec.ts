import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./reading-test";
import { rawtextOracleCases } from "./rawtext-oracle-cases";

// Explicit opt-in against an isolated disposable demo. Success means the
// observations were collected intact; it does NOT mean render/graph parity.
test.skip(process.env.WIKI_RAWTEXT_ORACLE !== "1", "Opt-in synthetic rawtext diagnosis");

for (const width of [390, 1440]) {
  test(`records full-document rawtext observations (${width})`, async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const owned: string[] = [];
    const rows: unknown[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const nativeParse = DOMParser.prototype.parseFromString;
      (window as any).__rawtextOracle = [];
      DOMParser.prototype.parseFromString = function (input, type) {
        const doc = nativeParse.call(this, input, type);
        // Observe the application's own renderer, not an independent copy.
        // Capture only our deliberately synthetic documents, before returning
        // the unmodified native Document for the application's normal cleaning.
        if (type === "text/html" && String(input).includes("Fictional rawtext oracle")) {
          (window as any).__rawtextOracle.push({
            emittedHtml: String(input), beforeHtml: doc.documentElement.outerHTML,
            scriptsBefore: Array.from(doc.querySelectorAll("script"), script => script.outerHTML),
            document: doc,
          });
        }
        return doc;
      };
    });
    async function create(markdown: string) {
      const id = `rawtext-oracle-${randomUUID()}`;
      const response = await request.post(`/api/wiki/pages/${id}`, {
        data: { markdown, base_revision: null, request_id: randomUUID() },
      });
      expect(response.ok()).toBe(true); owned.push(id);
      return { id, ...(await response.json()) };
    }
    try {
      const target = await create("# Fictional oracle notebook");
      const control = await create("# Fictional oracle control");
      for (const [name, body] of rawtextOracleCases) {
        const probeTerm = "oracleterm" + randomUUID().split("-").join("");
        const content = body.split("Fictional raw sentinel").join(`Fictional raw sentinel ${probeTerm}`)
          .split("[[T").join(`[[${target.id}`);
        const markdown = `# Fictional rawtext oracle ${name}\n\n[[${control.id}|Control before]]\n\n${content}\n\n[[${control.id}|Control after]]\n`;
        const saved = await create(markdown);
        await page.goto(`/wiki/${saved.id}`);
        // This independent link precedes every script, including unclosed ones.
        await expect(page.getByRole("link", { name: "Control before", exact: true }))
          .toHaveAttribute("href", `/wiki/${control.id}`);
        const rendering = await page.evaluate(() => ({
          documents: (window as any).__rawtextOracle.map((record: any) => ({
            emittedHtml: record.emittedHtml, beforeHtml: record.beforeHtml,
            scriptsBefore: record.scriptsBefore,
            afterScriptRemovalHtml: record.document.documentElement.outerHTML,
            scriptsAfter: record.document.querySelectorAll("script").length,
          })),
          sanitizedHtml: document.querySelector(".prose")!.innerHTML,
          visibleText: (document.querySelector(".prose") as HTMLElement).innerText,
          anchors: Array.from(document.querySelectorAll<HTMLAnchorElement>(".prose a[data-wiki-target]"), a => ({
            target: a.dataset.wikiTarget, text: a.textContent, href: a.getAttribute("href"),
            visible: a.getClientRects().length > 0,
          })),
          executionMarker: Boolean((window as any).__rawtextExecuted),
        }));
        expect(rendering.documents).toHaveLength(1);
        expect(rendering.documents[0].scriptsAfter).toBe(0);
        const graphResponse = await request.get("/api/wiki/graph"); expect(graphResponse.ok()).toBe(true);
        const graph = await graphResponse.json();
        const edges = graph.edges.filter((edge: { source: string }) => edge.source === saved.id);
        const backendTargets = [...new Set(edges.map((edge: { target: string }) => edge.target))].sort();
        const renderedTargets = [...new Set(rendering.anchors.map(anchor => anchor.target))].sort();
        const read = await request.get(`/api/wiki/pages/${saved.id}`); expect(read.ok()).toBe(true);
        const current = await read.json();
        expect(current.markdown).toBe(markdown); expect(current.revision).toBe(saved.revision);
        const searchResponse = await request.get("/api/wiki/search?q=" + encodeURIComponent(saved.id));
        expect(searchResponse.ok()).toBe(true);
        const search = await searchResponse.json();
        const contentSearchResponse = await request.get("/api/wiki/search?q=" + encodeURIComponent(probeTerm));
        expect(contentSearchResponse.ok()).toBe(true);
        const contentSearch = await contentSearchResponse.json();
        // Never serialize an unrelated result, even if retrieval regresses.
        const ownedResults = (results: { id: string }[]) => results.filter(result => result.id === saved.id);
        const identityResults = ownedResults(search.results);
        const sentinelResults = ownedResults(contentSearch.results);
        expect(identityResults.length === search.results.length).toBe(true);
        expect(sentinelResults.length === contentSearch.results.length).toBe(true);
        const backlinks = await request.get(`/api/wiki/pages/${target.id}/backlinks?limit=100`);
        expect(backlinks.ok()).toBe(true);
        const row = { case: name, width, markdown, pageId: saved.id, target: target.id, control: control.id,
          ...rendering, edges, backendTargets, renderedTargets,
          targetsAgree: JSON.stringify(backendTargets) === JSON.stringify(renderedTargets),
          missing: graph.missing_targets.filter((entry: { source: string }) => entry.source === saved.id),
          ambiguous: graph.ambiguous_targets.filter((entry: { source: string }) => entry.source === saved.id),
          targetHasBacklink: (await backlinks.json()).backlinks.some((entry: { id: string }) => entry.id === saved.id),
          excerpt: current.excerpt, lexicalIdentityResults: identityResults,
          lexicalSentinelQuery: probeTerm, lexicalSentinelResults: sentinelResults,
          sourceRevision: saved.revision, readRevision: current.revision };
        rows.push(row); console.info("[rawtext-oracle] " + JSON.stringify(row));
        if (name === "code-close" || name === "double-escaped")
          await page.screenshot({ path: info.outputPath(`rawtext-${name}-${width}.png`) });
      }
      expect(errors).toEqual([]);
    } finally {
      const cleanupErrors: string[] = [];
      try {
        await info.attach("rawtext-oracle.json", { body: JSON.stringify({
          kind: "diagnostic-not-parity-acceptance", engine: info.project.use.browserName || "chromium",
          width, rows, errors,
        }, null, 2), contentType: "application/json" });
      } catch { cleanupErrors.push("Could not attach synthetic observations"); }
      for (const id of owned.reverse()) {
        try {
          const current = await request.get(`/api/wiki/pages/${id}`); expect(current.ok()).toBe(true);
          expect((await request.delete(`/api/wiki/pages/${id}`, { data: {
            base_revision: (await current.json()).revision, request_id: randomUUID(),
          } })).ok()).toBe(true);
        } catch { cleanupErrors.push(`Could not remove owned page ${id}`); }
      }
      expect(cleanupErrors).toEqual([]);
    }
  });
}
