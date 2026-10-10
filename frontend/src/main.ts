import { marked } from "marked";
import "./style.css";
import { renderGalaxy, Graph } from "./galaxy";
type HistoryEntry = { commit: string; date: string; message: string };
type Page = {
  id: string;
  title: string;
  revision: string;
  markdown?: string;
  excerpt?: string;
};
const app = document.querySelector<HTMLDivElement>("#app")!;
let page: Page | null = null,
  draft = "",
  editing = false,
  saving = false,
  requestId = "",
  notice = "",
  deliveryNotice = "",
  generation = 0,
  deliveryGeneration = 0,
  activeUrl = location.pathname + location.search + location.hash;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const url = (id: string) => "/wiki/" + encodeURIComponent(id);
const linkUrl = (target: string, source = page?.id || "") =>
  `/resolve?${new URLSearchParams({ target, source })}`;
let cleanupView: (() => void) | undefined;
// Marked invokes inline tokenizers only in prose, leaving code blocks and spans intact.
marked.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(source: string) {
        return source.indexOf("[[");
      },
      tokenizer(source: string) {
        const match = /^\[\[([^\]\|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/.exec(source);
        if (!match || !match[1].trim()) return;
        return {
          type: "wikilink",
          raw: match[0],
          id: match[1].trim(),
          label: match[2] || match[1].trim(),
        };
      },
      renderer(token) {
        return `<a href="${esc(linkUrl(token.id as string))}" data-wiki-target="${esc(token.id as string)}">${esc(token.label as string)}</a>`;
      },
    },
  ],
});
async function api(path: string, options?: RequestInit) {
  const r = await fetch("/api/wiki" + path, options);
  const b = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(b.message || "Unable to open this page."), {
      status: r.status,
    });
  return b;
}
function markdown(s: string) {
  const doc = new DOMParser().parseFromString(
    marked.parse(s, { async: false }) as string,
    "text/html",
  );
  const allow = new Set(
    "P H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE STRONG EM DEL A IMG HR BR TABLE THEAD TBODY TR TD TH".split(
      " ",
    ),
  );
  function clean(n: Node): Node {
    if (n.nodeType === 3) return document.createTextNode(n.textContent || "");
    const el = n as HTMLElement;
    if (!allow.has(el.tagName))
      return document.createTextNode(el.textContent || "");
    const out = document.createElement(el.tagName.toLowerCase());
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      if (/^\/(wiki\/|resolve\?)/.test(href) || /^#/.test(href) || /^https?:\/\//.test(href)) {
        out.setAttribute("href", href);
        if (href.startsWith("http")) {
          out.setAttribute("target", "_blank");
          out.setAttribute("rel", "noopener noreferrer");
        }
      }
      const target = el.getAttribute("data-wiki-target");
      if (target !== null) out.dataset.wikiTarget = target;
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") || "";
      try {
        const resolved = new URL(src, location.href);
        if (
          (/^https?:\/\//.test(src) ||
            (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src) &&
              resolved.origin === location.origin)) &&
          ["http:", "https:"].includes(resolved.protocol)
        ) {
          out.setAttribute("src", resolved.href);
          out.setAttribute("alt", el.getAttribute("alt") || "");
          out.setAttribute("loading", "lazy");
        }
      } catch {}
    }
    el.childNodes.forEach((c) => out.append(clean(c)));
    if (el.tagName === "TABLE") {
      const region = document.createElement("div");
      region.className = "table-scroll";
      region.tabIndex = 0;
      region.setAttribute("role", "region");
      region.setAttribute(
        "aria-label",
        "Table; scroll horizontally to read all columns",
      );
      region.append(out);
      return region;
    }
    return out;
  }
  const f = document.createDocumentFragment();
  doc.body.childNodes.forEach((n) => f.append(clean(n)));
  return f;
}
function navigate(path: string) {
  if (saving) return;
  if (
    editing &&
    draft !== page?.markdown &&
    !confirm("Leave this page? Unsaved changes will be lost.")
  )
    return;
  history.pushState({}, "", path);
  activeUrl = location.pathname + location.search + location.hash;
  void route();
}
app.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  const href = a?.getAttribute("href");
  if (href?.startsWith("/") && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    navigate(href);
  }
});
function shell() {
  app.innerHTML = `<div class="ambient"></div><header><a class="brand" href="/?overview=1"><span>✳</span> secondbrain<small>YOUR KNOWLEDGE, CONNECTED</small></a><nav><a href="/?overview=1" class="${location.pathname === "/search" || location.pathname === "/galaxy" ? "" : "active"}">Home</a><a href="/search" class="${location.pathname === "/search" ? "active" : ""}">Search</a><a href="/galaxy" class="${location.pathname === "/galaxy" ? "active" : ""}">Galaxy</a></nav><div class="workspace"><i></i>Personal workspace</div></header><main></main><footer>A little clarity, every day.<span>Markdown is the source of truth.</span></footer>`;
}

function focusFragment() {
  if (!location.hash) return;
  let fragment = "";
  try { fragment = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const slug = (s: string) => s.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  const headings = Array.from(app.querySelectorAll<HTMLHeadingElement>(".prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6"));
  const target = headings.find(h => h.id === fragment) || headings.find(h => slug(h.textContent || "") === slug(fragment));
  if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start" }); }
}

async function resolveTargets(targets: string[], source: string) {
  const parameters = new URLSearchParams({ source });
  targets.forEach(target => parameters.append("target", target));
  return api(`/resolve-links?${parameters}`);
}

async function hydrateLinks(prose: Element, source: string) {
  const links = Array.from(prose.querySelectorAll<HTMLAnchorElement>("a[data-wiki-target]"));
  const targets = [...new Set(links.map(link => link.dataset.wikiTarget!))];
  // Keep requests small enough for reverse proxy request-line limits.
  for (let offset = 0; offset < targets.length; offset += 8) {
    if (!prose.isConnected) return;
    try {
      const data = await resolveTargets(targets.slice(offset, offset + 8), source);
      if (!prose.isConnected) return;
      for (const result of data.resolutions) {
        for (const link of links.filter(a => a.dataset.wikiTarget === result.target)) {
          if (result.status === "resolved") {
            link.href = url(result.candidates[0].id) + (result.fragment ? `#${encodeURIComponent(result.fragment)}` : "");
          } else if (result.status === "missing") {
            link.removeAttribute("href");
            link.classList.add("missing-link");
            link.title = "This page does not exist.";
            link.setAttribute("aria-label", `${link.textContent}; page missing`);
          } else {
            link.classList.add("ambiguous-link");
            link.title = "Several pages share this title. Choose a page.";
          }
        }
      }
    } catch { /* The explicit resolution route still provides a retryable fallback. */ }
  }
}
function cards(pages: Page[], fragment = "") {
  return pages
    .map(
      (p, i) =>
        `<a class="card" href="${url(p.id)}${fragment ? `#${encodeURIComponent(fragment)}` : ""}"><div class="card-meta"><span>${String(i + 1).padStart(2, "0")}</span><span>↗</span></div><h3>${esc(p.title)}</h3><p>${esc(p.excerpt || "Open this page and follow a thought.")}</p><div class="card-foot">Read page <span>→</span></div></a>`,
    )
    .join("");
}
async function route() {
  const run = ++generation;
  cleanupView?.();
  cleanupView = undefined;
  page = null;
  editing = false;
  notice = "";
  deliveryNotice = "";
  shell();
  const main = app.querySelector("main")!;
  main.innerHTML = '<p class="quiet">Opening your workspace…</p>';
  try {
    if (location.pathname === "/galaxy") {
      const graph: Graph = await api("/graph");
      if (run !== generation) return;
      cleanupView = renderGalaxy(main, graph);
      return;
    }
    if (location.pathname === "/resolve") {
      const parameters = new URLSearchParams(location.search);
      const target = parameters.get("target") || "";
      const data = await resolveTargets([target], parameters.get("source") || "");
      if (run !== generation) return;
      const result = data.resolutions[0];
      if (result.status === "resolved") {
        const path = url(result.candidates[0].id) + (result.fragment ? `#${encodeURIComponent(result.fragment)}` : "");
        history.replaceState({}, "", path);
        activeUrl = path;
        void route();
      } else {
        main.innerHTML = `<section class="intro"><div class="eyebrow">FOLLOW THE RIGHT THREAD</div><h1>${result.status === "ambiguous" ? "Choose a page." : "A missing page."}</h1><p>${result.status === "ambiguous" ? "Several pages share this title. Select the one you meant." : "This link has no existing target. Search your wiki or return to the article."}</p><p class="link-target">${esc(target)}</p></section><div class="grid">${cards(result.candidates, result.fragment)}</div><a href="/search?q=${encodeURIComponent(target)}">Search for this title →</a>`;
      }
      return;
    }
    if (location.pathname === "/search") {
      main.innerHTML = `<section class="intro"><div class="eyebrow">FOLLOW YOUR CURIOSITY</div><h1>Find a thought.</h1><p>Search your pages, pick up a thread, and keep going.</p></section><form><span>⌕</span><input aria-label="Search pages" placeholder="Search your knowledge…" value="${esc(new URLSearchParams(location.search).get("q") || "")}"><button class="primary">Search →</button></form><div id="results"><p class="quiet">A name, an idea, a phrase. Start anywhere.</p></div>`;
      const input = main.querySelector("input")!;
      const search = async () => {
        const q = input.value.trim();
        history.replaceState(
          {},
          "",
          q ? "/search?q=" + encodeURIComponent(q) : "/search",
        );
        const results = main.querySelector("#results")!;
        results.innerHTML = '<p class="quiet">Searching…</p>';
        try {
          const data = await api("/search?q=" + encodeURIComponent(q));
          if (run !== generation || input.value.trim() !== q) return;
          results.innerHTML = `<div class="section-heading"><h2>${data.results.length} results</h2></div><div class="grid">${data.results.length ? cards(data.results) : '<p class="quiet">No pages found. Try another word or phrase.</p>'}</div>`;
        } catch (e) {
          results.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
        }
      };
      main.querySelector("form")!.onsubmit = (e) => {
        e.preventDefault();
        void search();
      };
      if (input.value) void search();
      return;
    }
    if (location.pathname.startsWith("/wiki/")) {
      const loaded = await api(
        "/pages/" +
          encodeURIComponent(decodeURIComponent(location.pathname.slice(6))),
      );
      if (run !== generation) return;
      page = loaded;
      renderPage();
      focusFragment();
      return;
    }
    const { pages } = await api("/pages");
    if (run !== generation) return;
    let preferred = "";
    try {
      preferred = localStorage.getItem("secondbrain.startpage") || "";
    } catch {}
    const start =
      pages.find((p: Page) => p.id === preferred) ||
      pages.find((p: Page) => p.id === "home");
    if (
      preferred &&
      start?.id === preferred &&
      !new URLSearchParams(location.search).has("overview")
    ) {
      history.replaceState({}, "", url(preferred));
      activeUrl = url(preferred);
      void route();
      return;
    }
    main.innerHTML = `<section class="intro home"><div><div class="eyebrow">A PLACE FOR YOUR IDEAS</div><h1>Make room for<br><em>clearer thinking.</em></h1><p>Your notes, ideas, and connections. A quiet place to<br class="desktop"> find what matters and build on what you know.</p>${start ? `<a class="primary" href="${url(start.id)}">Open ${esc(start.title)} <span>↗</span></a>` : ""}</div><div class="art" aria-hidden="true"><div class="orbit"></div><div class="note small">Small discoveries &nbsp; ↗</div><div class="note large"><span>✳</span><b>One idea leads<br>to another.</b><i></i><i></i></div><div class="pill">◉ &nbsp; Stay curious</div></div></section><section class="library"><div class="section-heading"><div><div class="eyebrow">YOUR WIKI</div><h2>A growing collection</h2></div><span>${pages.length} pages</span></div><div class="grid">${pages.length ? cards(pages) : '<p class="quiet">Your workspace is ready. Ask your assistant to create your first page, or load the demo to explore.</p>'}</div></section>`;
  } catch (e) {
    if (run !== generation) return;
    main.innerHTML = `<section class="intro"><div class="eyebrow">A THREAD TO FOLLOW</div><h1>${(e as any).status === 404 ? "This page is missing." : "Couldn’t open the workspace."}</h1><p>${esc((e as Error).message)}</p><a href="/?overview=1" class="primary">Back to home →</a></section>`;
  }
}
function renderPage() {
  if (!page) return;
  const main = app.querySelector("main")!;
  main.innerHTML = `<div class="toolbar"><a href="/?overview=1">← All pages</a><div><button id="start" class="subtle">Set as start page</button><button id="edit" class="primary">${editing ? "Cancel" : "Edit page ↗"}</button></div></div><article><div class="eyebrow">WIKI PAGE <span class="revision">REVISION ${esc(String(page.revision).slice(0, 8))}</span></div><h1>${esc(page.title)}</h1><p class="notice ${notice.startsWith("Conflict") ? "error" : ""}" role="status">${esc(notice)}</p><p class="delivery-notice" aria-live="polite">${esc(deliveryNotice)}</p>${editing ? `<label for="editor">Markdown · links use [[page-id|label]]</label><textarea id="editor" spellcheck="false" ${saving ? "disabled" : ""}>${esc(draft)}</textarea><div class="editor-footer"><span>Your draft stays here if saving fails.</span><button id="save" class="primary" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Save changes →"}</button></div>` : '<div class="article-toc"></div><div class="prose"></div>'}<details class="page-history"><summary>Local Git history</summary><p class="history-context">Recent commits for this page, stored in your local workspace.</p><div class="history-content" role="status">Open to load recent changes.</div></details></article>`;
  if (!editing) {
    const prose = main.querySelector(".prose")!;
    prose.append(markdown((page.markdown || "").replace(/^\s*# [^\n]*\n?/, "")));
    void hydrateLinks(prose, page.id);
    const headings = Array.from(prose.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6"));
    if (headings.length) {
      headings.forEach((heading, i) => {
        heading.id = `section-${i + 1}`;
        heading.tabIndex = -1;
      });
      const toc = main.querySelector(".article-toc")!;
      toc.innerHTML = `<nav aria-label="On this page"><div class="eyebrow">ON THIS PAGE</div><ol>${headings.map(h => `<li class="toc-level-${h.tagName.slice(1)}"><a href="#${h.id}">${esc(h.textContent || "Untitled section")}</a></li>`).join("")}</ol></nav>`;
      toc.addEventListener("click", (event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const target = headings.find(h => `#${h.id}` === link.getAttribute("href"));
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: "start" });
      });
    }
  }
  const historyPanel = main.querySelector<HTMLDetailsElement>(".page-history")!;
  const historyPageId = page.id;
  let historyLoaded = false;
  historyPanel.addEventListener("toggle", async () => {
    if (!historyPanel.open || historyLoaded) return;
    historyLoaded = true;
    const content = historyPanel.querySelector(".history-content")!;
    content.textContent = "Loading recent changes…";
    try {
      const data: { history: HistoryEntry[] } = await api(`/pages/${encodeURIComponent(historyPageId)}/history`);
      if (!historyPanel.isConnected) return;
      content.innerHTML = data.history.length ? `<ol class="history-list">${data.history.map(entry => {
        const date = new Date(entry.date);
        const label = Number.isNaN(date.getTime()) ? entry.date : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
        return `<li><p>${esc(entry.message)}</p><div><code title="${esc(entry.commit)}">${esc(entry.commit.slice(0, 8))}</code><time datetime="${esc(entry.date)}">${esc(label)}</time></div></li>`;
      }).join("")}</ol>` : '<p>No local commits for this page yet.</p>';
    } catch (e) {
      if (!historyPanel.isConnected) return;
      historyLoaded = false;
      content.innerHTML = `<p class="error">${esc((e as Error).message)} Close and reopen history to retry.</p>`;
    }
  });
  main.querySelector("#start")!.addEventListener("click", () => {
    try {
      localStorage.setItem("secondbrain.startpage", page!.id);
      notice = "This is now your start page.";
    } catch {
      notice = "Your browser could not remember this preference.";
    }
    renderPage();
  });
  main.querySelector("#edit")!.addEventListener("click", () => {
    if (saving) return;
    if (
      editing &&
      draft !== page!.markdown &&
      !confirm("Discard unsaved changes?")
    )
      return;
    editing = !editing;
    if (editing) {
      draft = page!.markdown || "";
      requestId = crypto.randomUUID();
    }
    notice = "";
    renderPage();
  });
  if (editing) {
    main.querySelector("textarea")!.addEventListener("input", (e) => {
      draft = (e.target as HTMLTextAreaElement).value;
      requestId = crypto.randomUUID();
    });
    main.querySelector("#save")!.addEventListener("click", () => void save());
  }
}
async function refreshDelivery(run: number, token: number, attempt = 0) {
  try {
    const status = await api("/delivery-status");
    if (run !== generation || token !== deliveryGeneration) return;
    const states: Record<string, string> = {
      not_configured: "not configured", pending: "pending", current: "current",
      error: "needs attention", conflict: "conflict — needs attention",
    };
    const graph = status.indexes.graph.state as string;
    const vector = status.indexes.vector.state as string;
    const remote = status.remote.state as string;
    deliveryNotice = `Workspace indexing: graph ${states[graph] || graph}; vector ${states[vector] || vector}. Remote delivery: ${states[remote] || remote}${remote === "current" ? " (cached acknowledgement)" : ""}.`;
    const pending = [graph, vector, remote].includes("pending");
    if (pending && attempt >= 15) deliveryNotice += " Still processing; check again later.";
    const el = app.querySelector(".delivery-notice");
    if (el) el.textContent = deliveryNotice;
    if (pending && attempt < 15 && ![graph, vector, remote].some(s => s === "error" || s === "conflict")) {
      window.setTimeout(() => {
        if (run === generation && token === deliveryGeneration) void refreshDelivery(run, token, attempt + 1);
      }, 2000);
    }
  } catch {
    if (run !== generation || token !== deliveryGeneration) return;
    deliveryNotice = "Saved content is safe locally. Workspace delivery status is temporarily unavailable.";
    const el = app.querySelector(".delivery-notice");
    if (el) el.textContent = deliveryNotice;
  }
}
async function save() {
  if (!page || saving) return;
  saving = true;
  notice = "";
  renderPage();
  try {
    const result = await api("/pages/" + encodeURIComponent(page.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: draft,
        base_revision: page.revision,
        request_id: requestId,
      }),
    });
    page = result;
    editing = false;
    notice = `Saved locally · revision ${String(result.revision).slice(0, 8)}.`;
    deliveryNotice = "Checking workspace indexing and remote delivery…";
    void refreshDelivery(generation, ++deliveryGeneration);
  } catch (e) {
    notice =
      (e as any).status === 409
        ? "Conflict: this page has a newer revision. Your draft is preserved. Copy it before reloading to review the latest version."
        : (e as Error).message + " Your draft is preserved. Try saving again.";
  } finally {
    saving = false;
    renderPage();
  }
}
window.addEventListener("popstate", () => {
  if (
    saving ||
    (editing &&
      draft !== page?.markdown &&
      !confirm("Leave this page? Unsaved changes will be lost."))
  ) {
    history.pushState({}, "", activeUrl);
    return;
  }
  activeUrl = location.pathname + location.search + location.hash;
  void route();
});
window.addEventListener("hashchange", () => {
  activeUrl = location.pathname + location.search + location.hash;
  focusFragment();
});
window.addEventListener("beforeunload", (e) => {
  if (editing && draft !== page?.markdown) {
    e.preventDefault();
    e.returnValue = "";
  }
});
void route();
