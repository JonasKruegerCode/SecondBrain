import { marked } from "marked";
import "./style.css";
import { renderGalaxy, Graph, GalaxyViewState } from "./galaxy";
import { chatReloadBlocker, renderChat } from "./chat";
import { applyUpdate, installApp, observePwa, PwaState, startPwa } from "./pwa";
type HistoryEntry = { commit: string; date: string; message: string };
type Backlinks = {
  revision: string;
  target_revision: string;
  backlinks: { id: string; title: string; relations: string[] }[];
  total: number;
  truncated: boolean;
};
type Page = {
  id: string;
  title: string;
  revision: string;
  markdown?: string;
  excerpt?: string;
};
const app = document.querySelector<HTMLDivElement>("#app")!;
type NavigationEntry = { session: string; index: number; id: string };
const navigationKey = "secondbrain.navigation";
let navigationSession = crypto.randomUUID();
const navigationEntry = (index: number): NavigationEntry => ({ session: navigationSession, index, id: crypto.randomUUID() });
let activeEntry = navigationEntry(0);
let restoringHistory = false;
let historyRestoreTimer: number | undefined;
let historyCorrectionTimer: number | undefined;
type ReadingPoint = { x: number; y: number };
const readingPoints = new Map<string, ReadingPoint>();
const galaxyViews = new Map<string, GalaxyViewState>();
const readingStorageKey = "secondbrain.reading-points";
let readingStorageTimer: number | undefined;
let viewComplete = false;
let readingReady = false;
let readingInterrupted = false;
function persistReadingPoints() {
  window.clearTimeout(readingStorageTimer);
  readingStorageTimer = undefined;
  try {
    // Only opaque visit IDs and coordinates: no article, URL, draft or chat data.
    sessionStorage.setItem(readingStorageKey, JSON.stringify({ session: navigationSession, points: [...readingPoints] }));
  } catch {} // Reading and in-document history still work when storage is blocked/full.
}
function resumeReadingPoints() {
  try {
    const raw = sessionStorage.getItem(readingStorageKey);
    if (!raw || raw.length > 32768) return;
    const cached = JSON.parse(raw);
    const entry = history.state?.[navigationKey];
    if (typeof cached?.session !== "string" || !cached.session || cached.session.length > 100 ||
      entry?.session !== cached.session || !Number.isSafeInteger(entry.index) || entry.index < 0 ||
      typeof entry.id !== "string" || !entry.id || entry.id.length > 100 ||
      !Array.isArray(cached.points) || cached.points.length > 100) return;
    const points = new Map<string, ReadingPoint>();
    for (const item of cached.points) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !item[0] || item[0].length > 100 ||
        !item[1] || ![item[1].x, item[1].y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e7)) return;
      points.set(item[0], { x: item[1].x, y: item[1].y });
    }
    navigationSession = cached.session;
    activeEntry = { session: entry.session, index: entry.index, id: entry.id };
    points.forEach((point, id) => readingPoints.set(id, point));
  } catch {} // Malformed/unavailable tab storage must never block the initial read.
}
function rememberReadingPoint() {
  if (!readingReady || restoringHistory) return;
  readingPoints.delete(activeEntry.id);
  readingPoints.set(activeEntry.id, { x: Math.max(0, scrollX), y: Math.max(0, scrollY) });
  // Reading positions belong to visits, not URLs; keep this tab's memory bounded.
  if (readingPoints.size > 100) readingPoints.delete(readingPoints.keys().next().value!);
  // Coalesce scroll writes; document lifecycle events flush the final snapshot.
  if (readingStorageTimer === undefined) readingStorageTimer = window.setTimeout(persistReadingPoints, 100);
}
window.addEventListener("scroll", rememberReadingPoint, { passive: true });
const interruptReading = () => { if (!readingReady) readingInterrupted = true; };
window.addEventListener("wheel", interruptReading, { passive: true });
window.addEventListener("touchmove", interruptReading, { passive: true });
window.addEventListener("pointerdown", interruptReading, { passive: true });
window.addEventListener("keydown", event => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interruptReading();
});
let page: Page | null = null,
  draft = "",
  editing = false,
  saving = false,
  notice = "",
  noticeError = false,
  noticeAtSave = false,
  deliveryNotice = "",
  generation = 0,
  deliveryGeneration = 0,
  activeUrl = location.pathname + location.search + location.hash;
let saveAttempt: { pageId: string; markdown: string; base_revision: string; request_id: string } | null = null;
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
let pwaState: PwaState = { offline: !navigator.onLine, installable: false, updateAvailable: false };
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
        const match = /^\[\[([^\]\|\r\n]+)(?:\|([^\]\r\n]*))?\]\]/.exec(source);
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
  const controller = new AbortController();
  const signal = options?.signal;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, path === "/chat" ? 120_000 : 30_000);
  const savingPage = options?.method === "POST" && path.startsWith("/pages/");
  try {
    const r = await fetch("/api/wiki" + path, { ...options, signal: controller.signal });
    let b;
    try {
      b = await r.json();
    } catch (error) {
      // Proxies can return empty or HTML errors. Keep the HTTP status for
      // missing-page and revision-conflict handling, without exposing parser text.
      if (controller.signal.aborted) throw error;
      throw Object.assign(new Error(savingPage
        ? "The save response could not be confirmed. The change may already be saved. Retry the unchanged draft to check."
        : "The workspace returned an unreadable response. Try again."), { status: r.status });
    }
    if (!r.ok)
      throw Object.assign(new Error(b?.message || (savingPage
        ? "The save response could not be confirmed. The change may already be saved. Retry the unchanged draft to check."
        : "Unable to open this page.")), {
        status: r.status,
      });
    return b;
  } catch (error) {
    if (timedOut) {
      // Aborting the response does not establish whether the server published a write.
      throw new Error(savingPage
        ? "The save response timed out. The change may already be saved. Retry the unchanged draft to check."
        : "Request timed out. Check your connection and try again.");
    }
    if (error instanceof TypeError && !controller.signal.aborted) {
      throw new Error(savingPage
        ? "The workspace could not be reached. The change may already be saved. Check your connection, then retry the unchanged draft."
        : "The workspace could not be reached. Check your connection and try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
function markdown(s: string, pageTitle?: string) {
  const options = { ...marked.defaults, async: false };
  const tokens = marked.lexer(s, options);
  // Only an actual top-level ATX title can duplicate the separate page heading.
  // Raw HTML, nested headings and unrelated H1s remain article content.
  const firstTitle = tokens.find(token => token.type === "heading" && token.depth === 1 &&
    Boolean(token.raw.match(/^ {0,3}#[ \t]+([^\r\n]+)/)?.[1].trim()));
  const earlierHtmlTitle = firstTitle && tokens.slice(0, tokens.indexOf(firstTitle)).some(token =>
    token.type === "html" && !token.raw.trimStart().startsWith("<!--") &&
    !/^ {0,3}(?:<(script|pre|style|textarea)[\s>]|<\?|<![a-z]|<!\[CDATA\[)/i.test(token.raw) &&
    /^ {0,3}#[ \t]+/m.test(token.raw));
  const candidate = pageTitle !== undefined && !earlierHtmlTitle &&
    firstTitle?.raw.match(/^ {0,3}#[ \t]+([^\r\n]+)/)?.[1].trim() === pageTitle ? firstTitle : undefined;
  let candidateIndex = -1, headingCount = 0;
  marked.walkTokens(tokens, token => {
    if (token.type !== "heading") return;
    if (token === candidate) candidateIndex = headingCount;
    headingCount++;
  });
  const marker = crypto.randomUUID();
  const renderer = new marked.Renderer();
  const heading = renderer.heading.bind(renderer);
  let renderedHeadings = 0;
  renderer.heading = (text, level, raw) => {
    const html = heading(text, level, raw);
    return renderedHeadings++ === candidateIndex
      ? html.replace("<h1>", `<h1 data-article-title="${marker}">`) : html;
  };
  const doc = new DOMParser().parseFromString(
    marked.parser(tokens, { ...options, renderer }),
    "text/html",
  );
  const sourceTitle = doc.querySelector(`[data-article-title="${marker}"]`);
  let titleHeading: HTMLHeadingElement | undefined;
  const allow = new Set(
    "P H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE STRONG EM DEL A IMG HR BR TABLE THEAD TBODY TR TD TH".split(
      " ",
    ),
  );
  function clean(n: Node): Node {
    if (n.nodeType === 3) return document.createTextNode(n.textContent || "");
    // Comments are source annotations, not visible article prose.
    if (n.nodeType !== 1) return document.createTextNode("");
    const el = n as HTMLElement;
    // GFM task markers carry content, but never become editable form controls.
    // Rebuild only the inert checkbox shape emitted by Markdown; retain no
    // source attributes such as handlers, names, values or form associations.
    if (el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "checkbox" && el.hasAttribute("disabled")) {
      const marker = document.createElement("input");
      marker.type = "checkbox";
      marker.disabled = true;
      marker.checked = el.hasAttribute("checked");
      return marker;
    }
    if (!allow.has(el.tagName))
      return document.createTextNode(el.textContent || "");
    const out = document.createElement(el.tagName.toLowerCase());
    if (el === sourceTitle) titleHeading = out as HTMLHeadingElement;
    // Some engines do not put scrollable code blocks in the native Tab order.
    if (el.tagName === "PRE") out.tabIndex = 0;
    if (el.tagName === "OL") {
      const start = el.getAttribute("start");
      if (start !== null && /^-?\d+$/.test(start)) out.setAttribute("start", start);
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      if (/^\/(wiki\/|resolve\?)/.test(href) || /^#/.test(href) || /^https?:\/\//i.test(href)) {
        out.setAttribute("href", href);
        if (/^https?:\/\//i.test(href)) {
          out.setAttribute("target", "_blank");
          out.setAttribute("rel", "noopener noreferrer");
        }
      }
      const target = el.getAttribute("data-wiki-target");
      if (target !== null) out.dataset.wikiTarget = target;
    }
    if (el.tagName === "IMG") {
      out.setAttribute("alt", el.getAttribute("alt") || "");
      const src = el.getAttribute("src") || "";
      try {
        const resolved = new URL(src, location.href);
        if (
          (/^https?:\/\//.test(src) ||
            (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src) &&
              resolved.origin === location.origin)) &&
          ["http:", "https:"].includes(resolved.protocol)
        ) {
          if (!sourceTitle?.contains(el)) out.setAttribute("src", resolved.href);
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
  return { fragment: f, titleHeading };
}

function titleInline(heading: HTMLHeadingElement): DocumentFragment {
  // A display title keeps Markdown emphasis, never navigation or active media.
  // Rebuild from the confirmed, sanitized source heading without attributes.
  function copy(node: Node): Node {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || "");
    const out = document.createDocumentFragment();
    if (!(node instanceof HTMLElement)) return out;
    if (node.tagName === "IMG") return document.createTextNode(node.getAttribute("alt") || "");
    const children = ["STRONG", "EM", "DEL", "CODE", "BR"].includes(node.tagName)
      ? document.createElement(node.tagName.toLowerCase()) : out;
    node.childNodes.forEach(child => children.append(copy(child)));
    return children;
  }
  const fragment = document.createDocumentFragment();
  heading.childNodes.forEach(child => fragment.append(copy(child)));
  return fragment;
}

function articleMarkdown(s: string) {
  // Frontmatter remains visible in the raw editor and Git history, but is not article prose.
  return s.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}
function navigationState() {
  const state = history.state;
  return { ...(state && typeof state === "object" && !Array.isArray(state) ? state : {}), [navigationKey]: activeEntry };
}
function readNavigationEntry(state: any): NavigationEntry | null {
  const entry = state?.[navigationKey];
  return entry?.session === navigationSession && Number.isSafeInteger(entry.index) && entry.index >= 0 &&
    typeof entry.id === "string" && entry.id ? entry : null;
}
function replaceAppUrl(path: string) {
  history.replaceState(navigationState(), "", path);
  activeUrl = location.pathname + location.search + location.hash;
}
function resetHistoryTracking(path: string) {
  // An untracked entry has no reliable relative position. Preserve the editor
  // and forward stack by replacing this one entry, then start a fresh session.
  navigationSession = crypto.randomUUID();
  activeEntry = navigationEntry(0);
  restoringHistory = false;
  window.clearTimeout(historyRestoreTimer);
  window.clearTimeout(historyCorrectionTimer);
  replaceAppUrl(path);
}
function queueHistoryCorrection() {
  window.clearTimeout(historyCorrectionTimer);
  window.clearTimeout(historyRestoreTimer);
  // Let already queued native traversals finish. A delta captured from the
  // first popstate can be obsolete by the time a second Back arrives.
  historyCorrectionTimer = window.setTimeout(() => {
    if (!restoringHistory) return;
    const current = readNavigationEntry(history.state);
    const targetUrl = location.pathname + location.search + location.hash;
    if (current?.id === activeEntry.id && targetUrl === activeUrl) {
      restoringHistory = false;
      return;
    }
    const delta = current ? activeEntry.index - current.index : 0;
    if (!delta) {
      resetHistoryTracking(activeUrl);
      return;
    }
    history.go(delta);
    // A browser can suppress a correction during another traversal. Retry
    // from its actual position; never replace a known, different visit.
    historyRestoreTimer = window.setTimeout(() => {
      if (restoringHistory) queueHistoryCorrection();
    }, 1000);
  }, 0);
}
function restoreHistory(entry: NavigationEntry | null) {
  const delta = entry ? activeEntry.index - entry.index : 0;
  if (delta) {
    restoringHistory = true;
    queueHistoryCorrection();
  } else resetHistoryTracking(activeUrl);
}
function navigate(path: string) {
  if (saving || restoringHistory) return;
  if (
    editing &&
    draft !== page?.markdown &&
    !confirm("Leave this page? Unsaved changes will be lost.")
  )
    return;
  rememberReadingPoint();
  history.scrollRestoration = "manual";
  activeEntry = navigationEntry(activeEntry.index + 1);
  history.pushState(navigationState(), "", path);
  activeUrl = location.pathname + location.search + location.hash;
  void route(true);
}

function viewReady(title: string) {
  document.title = `${title} · Secondbrain`;
  const status = app.querySelector<HTMLElement>(".route-status");
  requestAnimationFrame(() => {
    if (status?.isConnected) status.textContent = `${title} view loaded.`;
  });
}

function plainLinkClick(event: MouseEvent) {
  return !event.defaultPrevented && event.button === 0 &&
    !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

app.addEventListener("click", (e) => {
  if (!plainLinkClick(e)) return;
  const a = (e.target as HTMLElement).closest("a");
  const href = a?.getAttribute("href");
  if (href?.startsWith("/") || href?.startsWith("#")) {
    e.preventDefault();
    if (href.startsWith("#")) {
      if (restoringHistory) return;
      const path = location.pathname + location.search + href;
      if (new URL(path, location.origin).href !== location.href) {
        rememberReadingPoint();
        history.scrollRestoration = "manual";
        activeEntry = navigationEntry(activeEntry.index + 1);
        history.pushState(navigationState(), "", path);
        activeUrl = location.pathname + location.search + location.hash;
      }
      focusFragment();
    } else navigate(href);
  }
});
function shell() {
  const active = (path: string) => location.pathname === path ? ' class="active" aria-current="page"' : "";
  const homeActive = !["/search", "/galaxy", "/chat"].includes(location.pathname)
    ? ` class="active"${location.pathname === "/" ? ' aria-current="page"' : ""}`
    : "";
  app.innerHTML = `<a class="skip-link" href="#main-content">Skip to content</a><div class="ambient"></div><header><a class="brand" href="/?overview=1" aria-label="Secondbrain home"><span aria-hidden="true">✳</span> secondbrain<small aria-hidden="true">YOUR KNOWLEDGE, CONNECTED</small></a><nav aria-label="Primary"><a href="/?overview=1"${homeActive}>Home</a><a href="/search"${active("/search")}>Search</a><a href="/galaxy"${active("/galaxy")}>Galaxy</a><a href="/chat"${active("/chat")}>Chat</a></nav><div class="workspace"><i></i>Personal workspace</div></header><div class="pwa-notice" role="status" hidden><span></span><button type="button"></button></div><p class="route-status sr-only" role="status" aria-live="polite"></p><main id="main-content" tabindex="-1"></main><footer>A little clarity, every day.<span>Markdown is the source of truth.</span></footer>`;
  renderPwaState();
}

function canReloadApp() {
  return !saving && !(editing && draft !== page?.markdown) && !chatReloadBlocker();
}

function renderPwaState() {
  const notice = app.querySelector<HTMLElement>(".pwa-notice");
  if (!notice) return;
  const label = notice.querySelector("span")!;
  const button = notice.querySelector<HTMLButtonElement>("button")!;
  notice.hidden = false;
  button.hidden = true;
  button.disabled = false;
  if (pwaState.offline) {
    notice.dataset.kind = "offline";
    label.textContent = "You’re offline. Saved browser drafts remain local; wiki and chat need a connection.";
  } else if (pwaState.updateAvailable) {
    notice.dataset.kind = "update";
    label.textContent = saving
      ? "A new version is ready. Wait for saving to finish before updating."
      : chatReloadBlocker() === "reply"
        ? "A new version is ready. Wait for your chat reply before updating."
      : chatReloadBlocker() === "draft"
        ? "A new version is ready. Send or clear your message drafts in all conversations before updating."
      : chatReloadBlocker() === "storage"
        ? "A new version is ready. Recover browser storage or delete unsaved conversations before updating."
      : !canReloadApp()
        ? "A new version is ready. Save or discard your changes before updating."
        : "A new version of Secondbrain is ready.";
    button.hidden = false;
    button.disabled = !canReloadApp();
    button.textContent = "Update now";
    button.onclick = applyUpdate;
  } else if (pwaState.installable) {
    notice.dataset.kind = "install";
    label.textContent = "Install Secondbrain for a focused app window and quick access.";
    button.hidden = false;
    button.textContent = "Install app";
    button.onclick = () => void installApp();
  } else {
    notice.hidden = true;
    delete notice.dataset.kind;
  }
}

function focusFragment() {
  if (!location.hash) return;
  let fragment = "";
  try { fragment = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const slug = (s: string) => s.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  const headings = Array.from(app.querySelectorAll<HTMLHeadingElement>("article > h1[data-article-section],.prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6"));
  const target = (fragment === "main-content" ? app.querySelector<HTMLElement>("#main-content") : null) ||
    headings.find(h => h.id === fragment) || headings.find(h => slug(h.dataset.sectionLabel ?? h.textContent ?? "") === slug(fragment));
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
function cards(pages: Page[], fragment = "", showIdentity = false) {
  return pages
    .map(
      (p, i) =>
        `<a class="card" href="${url(p.id)}${fragment ? `#${encodeURIComponent(fragment)}` : ""}"><div class="card-meta"><span>${String(i + 1).padStart(2, "0")}</span><span>↗</span></div><h3>${esc(p.title)}</h3>${showIdentity ? `<div class="card-id">Page ID: <code>${esc(p.id)}</code></div>` : ""}<p>${esc(p.excerpt || "Open this page and follow a thought.")}</p><div class="card-foot">Read page <span>→</span></div></a>`,
    )
    .join("");
}
async function route(focusView = false, reuseShell = false, readingPoint?: ReadingPoint,
  startNavigation: { fallbackOnError?: boolean; notice?: string; articleFocus?: "edit" } = {}) {
  const run = ++generation;
  viewComplete = false;
  readingReady = false;
  if (!reuseShell) readingInterrupted = false;
  cleanupView?.();
  cleanupView = undefined;
  page = null;
  editing = false;
  saveAttempt = null;
  notice = "";
  noticeError = false;
  noticeAtSave = false;
  deliveryNotice = "";
  if (reuseShell) {
    // Resolving a link or a saved start page normalizes the URL within this
    // load. Keep header/main focus chosen while the first real read was pending.
    app.querySelector("header nav a[aria-current]")?.removeAttribute("aria-current");
    if (location.pathname === "/")
      app.querySelector('header nav a[href="/?overview=1"]')?.setAttribute("aria-current", "page");
  } else shell();
  const main = app.querySelector("main")!;
  main.innerHTML = '<p class="quiet">Opening your workspace…</p>';
  let routeFocusedHeading: HTMLElement | null = null;
  const complete = (title: string, ready = true) => {
    if (run !== generation) return;
    const heading = main.querySelector<HTMLElement>("h1");
    if (heading) heading.tabIndex = -1;
    const focusTarget = (startNavigation.articleFocus === "edit" ? main.querySelector<HTMLElement>("#edit") : null) || heading;
    // Announce the new reading destination only when navigation removed the
    // old focus. Never steal a focus explicitly chosen during an async read.
    const untouchedFocus = document.activeElement === document.body || document.activeElement === routeFocusedHeading;
    if (focusView && !location.hash && untouchedFocus) {
      focusTarget?.focus({ preventScroll: true });
      routeFocusedHeading = focusTarget;
    }
    if (ready && (focusView || readingPoint) && !location.hash && untouchedFocus && !readingInterrupted)
      window.scrollTo(readingPoint?.x || 0, readingPoint?.y || 0);
    // Automatic arrival must not override a focus chosen while loading.
    // Explicit fragment navigation has its own handlers below.
    if (untouchedFocus) focusFragment();
    // A usable search form already owns fragment/input navigation, while its
    // pending results are not yet tall enough to restore a reading position.
    viewComplete = true;
    readingReady = ready;
    rememberReadingPoint();
    viewReady(title);
  };
  try {
    if (location.pathname === "/chat") {
      cleanupView = renderChat(main, api, renderPwaState, () => complete("Chat"));
      return;
    }
    if (location.pathname === "/galaxy") {
      const graph: Graph = await api("/graph");
      if (run !== generation) return;
      // Keep view state with this visit even when navigation changes activeEntry
      // before the outgoing view's cleanup runs. This state stays in memory.
      const entryId = activeEntry.id;
      cleanupView = renderGalaxy(main, graph, undefined, {
        initialPage: new URLSearchParams(location.search).get("page") || undefined,
        initialState: galaxyViews.get(entryId),
        onLeave: (state: GalaxyViewState) => {
          galaxyViews.delete(entryId);
          galaxyViews.set(entryId, state);
          if (galaxyViews.size > 100) galaxyViews.delete(galaxyViews.keys().next().value!);
        },
      });
      complete("Galaxy");
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
        replaceAppUrl(path);
        void route(focusView, true, readingPoint);
      } else {
        main.innerHTML = `<section class="intro"><div class="eyebrow">FOLLOW THE RIGHT THREAD</div><h1>${result.status === "ambiguous" ? "Choose a page." : "A missing page."}</h1><p>${result.status === "ambiguous" ? "Several pages share this title. Select the one you meant." : "This link has no existing target. Search your wiki or return to the article."}</p><p class="link-target">${esc(target)}</p></section><div class="grid">${cards(result.candidates, result.fragment, result.status === "ambiguous")}</div><a href="/search?q=${encodeURIComponent(target)}">Search for this title →</a>`;
        complete(result.status === "ambiguous" ? "Choose a page" : "Missing page");
      }
      return;
    }
    if (location.pathname === "/search") {
      main.innerHTML = `<section class="intro"><div class="eyebrow">FOLLOW YOUR CURIOSITY</div><h1>Find a thought.</h1><p>Search your pages, pick up a thread, and keep going.</p></section><form><span>⌕</span><input aria-label="Search pages" placeholder="Search your knowledge…" value="${esc(new URLSearchParams(location.search).get("q") || "")}"><button class="primary">Search →</button></form><p id="search-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p><div id="results" aria-busy="false"><p class="quiet">A name, an idea, a phrase. Start anywhere.</p></div>`;
      const input = main.querySelector("input")!;
      // Keep one mounted live region outside the cards: announce the submitted
      // query's outcome without moving focus or reading every result aloud.
      const searchStatus = main.querySelector("#search-status")!;
      let searchGeneration = 0;
      const search = async () => {
        const searchRun = ++searchGeneration;
        const q = input.value.trim();
        // Typing the next draft does not change ownership of the submitted query.
        const current = () => run === generation && searchRun === searchGeneration;
        // Normalize the submitted query without discarding its reading target.
        // Use the current fragment, never a route-start value or a late reply.
        replaceAppUrl((q ? "/search?q=" + encodeURIComponent(q) : "/search") + location.hash);
        const results = main.querySelector("#results")!;
        const scope = q ? `for “${q}”` : "in your wiki";
        results.setAttribute("aria-busy", "true");
        searchStatus.textContent = `Searching ${scope}…`;
        results.innerHTML = '<p class="quiet">Searching…</p>';
        try {
          const data = await api("/search?q=" + encodeURIComponent(q));
          if (!current()) return;
          results.innerHTML = `<div class="section-heading"><h2>${data.results.length} ${data.results.length === 1 ? "result" : "results"}</h2></div><div class="grid">${data.results.length ? cards(data.results) : '<p class="quiet">No pages found. Try another word or phrase.</p>'}</div>`;
          results.setAttribute("aria-busy", "false");
          searchStatus.textContent = data.results.length
            ? `${data.results.length} ${data.results.length === 1 ? "result" : "results"} ${scope}.`
            : `No pages found ${scope}. Try another word or phrase.`;
        } catch (e) {
          if (!current()) return;
          results.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
          results.setAttribute("aria-busy", "false");
          searchStatus.textContent = `Search failed ${scope}. ${(e as Error).message} Submit your search to try again.`;
        } finally {
          // Search results determine document height. Restore only once the
          // actual initial payload has rendered, never against the loading view.
          if (current() && !readingReady) complete("Search");
        }
      };
      main.querySelector("form")!.onsubmit = (e) => {
        e.preventDefault();
        readingInterrupted = true;
        void search();
      };
      if (input.value) void search();
      complete("Search", !input.value);
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
      complete(loaded.title);
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
      replaceAppUrl(url(preferred));
      void route(focusView, true, readingPoint, { fallbackOnError: true });
      return;
    }
    const startNotice = startNavigation.notice ||
      (preferred && !pages.some((p: Page) => p.id === preferred) &&
        !new URLSearchParams(location.search).has("overview")
        ? "Your saved start page no longer exists. Home is shown instead." : "");
    main.innerHTML = `<section class="intro home"><div><div class="eyebrow">A PLACE FOR YOUR IDEAS</div><h1>Make room for<br><em>clearer thinking.</em></h1><p>Your notes, ideas, and connections. A quiet place to<br class="desktop"> find what matters and build on what you know.</p>${start ? `<a class="primary" href="${url(start.id)}">Open ${esc(start.title)} <span>↗</span></a>` : ""}</div><div class="art" aria-hidden="true"><div class="orbit"></div><div class="note small">Small discoveries &nbsp; ↗</div><div class="note large"><span>✳</span><b>One idea leads<br>to another.</b><i></i><i></i></div><div class="pill">◉ &nbsp; Stay curious</div></div></section><section class="library"><div class="section-heading"><div><div class="eyebrow">YOUR WIKI</div><h2>A growing collection</h2></div><span>${pages.length} pages</span></div><div class="grid">${pages.length ? cards(pages) : '<p class="quiet">Your workspace is ready. Ask your assistant to create your first page, or load the demo to explore.</p>'}</div></section>`;
    if (startNotice) {
      const message = document.createElement("p");
      message.className = "start-page-notice";
      message.setAttribute("role", "status");
      message.textContent = startNotice;
      main.querySelector(".home > div")!.prepend(message);
    }
    complete("Home");
  } catch (e) {
    if (run !== generation) return;
    if (startNavigation.fallbackOnError) {
      // Only automatic start-page navigation falls back. Direct article URLs
      // retain their normal error/retry state, and the saved preference remains.
      replaceAppUrl("/?overview=1");
      void route(focusView, true, readingPoint, {
        notice: "Your saved start page could not be opened. Home is shown instead. Your start-page choice is unchanged.",
      });
      return;
    }
    const missing = (e as any).status === 404;
    const message = e instanceof TypeError
      ? "The workspace could not be reached. Check your connection and try again."
      : (e as Error).message;
    main.innerHTML = `<section class="intro"><div class="eyebrow">A THREAD TO FOLLOW</div><h1>${missing ? "This page is missing." : "Couldn’t open the workspace."}</h1><p>${esc(message)}</p>${missing ? "" : '<p><button id="retry-workspace" class="primary">Try again →</button></p>'}<a href="/?overview=1" class="${missing ? "primary" : "subtle"}">Back to home →</a></section>`;
    const retry = main.querySelector<HTMLButtonElement>("#retry-workspace");
    if (retry) retry.onclick = () => {
      // Reload this visit, retaining its URL and history position. A later
      // navigation must not revive this failed route through a stale button.
      if (run === generation) void route(true, false, readingPoint, { articleFocus: startNavigation.articleFocus });
    };
    complete(missing ? "Missing page" : "Workspace unavailable");
  }
}
function renderPage(focusTarget?: "editor" | "edit" | "start" | "heading",
  historyState?: { open: boolean; focused: boolean }) {
  if (!page) return;
  const main = app.querySelector("main")!;
  const feedback = `<p class="notice ${noticeError ? "error" : ""}" role="status" aria-atomic="true">${esc(notice)}</p>`;
  main.innerHTML = `<div class="toolbar"><a href="/?overview=1">← All pages</a><div><button id="start" class="subtle">Set as start page</button><button id="edit" class="primary">${editing ? "Cancel" : "Edit page ↗"}</button></div></div><article><div class="eyebrow">WIKI PAGE <span class="revision">REVISION ${esc(String(page.revision).slice(0, 8))}</span></div><h1 tabindex="-1">${esc(page.title)}</h1>${editing && noticeAtSave ? "" : feedback}${editing ? `<label for="editor">Markdown · links use [[page-id|label]]</label><textarea id="editor" spellcheck="false" ${saving ? "disabled" : ""}>${esc(draft)}</textarea><div class="editor-footer"><div class="editor-feedback"><span>Your draft stays here if saving fails.</span>${noticeAtSave ? feedback : ""}</div><button id="save" class="primary" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Save changes →"}</button></div>` : `<div class="article-toc"></div><div class="prose"></div>`}<div class="delivery-status"><p class="delivery-notice" aria-live="polite">${esc(deliveryNotice)}</p><button id="check-delivery" class="subtle" type="button">Check sync status</button></div><details class="page-history"><summary>Local Git history</summary><p class="history-context">Recent commits for this page, stored in your local workspace.</p><div class="history-content" role="status">Open to load recent changes.</div></details></article>`;
  if (!editing) {
    const connections = document.createElement("a");
    connections.className = "article-connections";
    connections.href = `/galaxy?page=${encodeURIComponent(page.id)}`;
    connections.textContent = "Explore connections";
    main.querySelector(".toolbar > div")!.prepend(connections);
    const prose = main.querySelector(".prose")!;
    const articleSource = articleMarkdown(page.markdown || "");
    // Strip only a confirmed leading ATX title. Broad whitespace can consume
    // indented code; a newline match must stop at CR as well as LF.
    const leadingTitle = /^(?:[ \t]*(?:\r\n|\r|\n))* {0,3}# [^\r\n]*(?:\r\n|\r|\n|$)/;
    const leadingHeading = articleSource.match(leadingTitle)?.[0];
    const leadingProjection = leadingHeading ? markdown(leadingHeading, page.title).titleHeading : undefined;
    const rendered = markdown(leadingProjection ? articleSource.slice(leadingHeading!.length) : articleSource,
      leadingProjection ? undefined : page.title);
    const title = main.querySelector<HTMLHeadingElement>("article > h1")!;
    const displayHeading = rendered.titleHeading || leadingProjection;
    if (displayHeading) {
      const inline = titleInline(displayHeading);
      if (inline.textContent?.trim()) title.replaceChildren(inline);
    }
    const headings = Array.from(rendered.fragment.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6"));
    if (headings.length) {
      headings.forEach((heading, i) => {
        heading.id = `section-${i + 1}`;
        heading.tabIndex = -1;
        // Reuse the inert title projection so image alternatives participate in
        // both TOC labels and named-fragment matching without fetching media.
        heading.dataset.sectionLabel = titleInline(heading).textContent?.trim() || "Untitled section";
      });
      if (rendered.titleHeading) {
        // Keep this heading's old section identity on the existing page title.
        // Later section numbers, named arrival and TOC focus remain available.
        title.id = rendered.titleHeading.id;
        title.dataset.articleSection = "title";
        title.dataset.sectionLabel = rendered.titleHeading.dataset.sectionLabel;
        headings[headings.indexOf(rendered.titleHeading)] = title;
        rendered.titleHeading.remove();
      }
      const toc = main.querySelector<HTMLElement>(".article-toc")!;
      toc.innerHTML = `<nav aria-label="On this page"><div class="eyebrow">ON THIS PAGE</div><ol>${headings.map(h => `<li class="toc-level-${h.tagName.slice(1)}"><a href="#${h.id}">${esc(h.dataset.sectionLabel ?? h.textContent ?? "Untitled section")}</a></li>`).join("")}</ol></nav>`;
      toc.addEventListener("click", (event) => {
        // Let the browser open modified activations in another tab/window.
        if (!plainLinkClick(event)) return;
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const target = headings.find(h => `#${h.id}` === link.getAttribute("href"));
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: "start" });
      });
    }
    prose.append(rendered.fragment);
    void hydrateLinks(prose, page.id);
    const panel = document.createElement("details");
    panel.className = "page-backlinks";
    panel.innerHTML = '<summary>Linked from</summary><div class="backlinks-content" role="status">Open to see pages that link here.</div>';
    main.querySelector(".page-history")!.before(panel);
    const targetId = page.id, targetRevision = page.revision;
    let loaded = false;
    const content = panel.querySelector<HTMLElement>(".backlinks-content")!;
    const load = async () => {
      const restoreFocus = content.contains(document.activeElement);
      // Replacing a focused refresh/retry button leaves focus on body. Only
      // reclaim that unowned focus, not a control chosen during the read.
      const canRestoreFocus = () => restoreFocus && document.activeElement === document.body;
      loaded = true;
      content.textContent = "Loading incoming links…";
      try {
        const result: Backlinks = await api(`/pages/${encodeURIComponent(targetId)}/backlinks`);
        if (!panel.isConnected || page?.id !== targetId || page.revision !== targetRevision) return;
        if (result.target_revision !== targetRevision) {
          content.innerHTML = '<p>This article has changed. Reload it to review its current links.</p><button type="button" class="subtle">Reload article</button>';
          const reload = content.querySelector<HTMLButtonElement>("button")!;
          reload.onclick = async () => {
            const restoreReloadFocus = document.activeElement === reload;
            const canRestoreReloadFocus = () => restoreReloadFocus &&
              (document.activeElement === reload || document.activeElement === document.body);
            reload.disabled = true;
            try {
              const latest: Page = await api(`/pages/${encodeURIComponent(targetId)}`);
              if (!panel.isConnected || page?.id !== targetId || page.revision !== targetRevision) return;
              page = latest;
              // Snapshot the user's latest history choice before replacing its
              // DOM. Recreate it so its existing listener reads fresh history.
              renderPage(canRestoreReloadFocus() ? "heading" : undefined, {
                open: historyPanel.open,
                focused: document.activeElement === historyPanel.querySelector("summary"),
              });
              viewReady(latest.title);
            } catch {
              if (!panel.isConnected) return;
              content.querySelector("p")!.textContent = "Couldn’t reload this article. Try again when your connection is ready.";
              reload.disabled = false;
              if (canRestoreReloadFocus()) reload.focus();
            }
          };
          if (canRestoreFocus()) reload.focus();
          return;
        }
        content.innerHTML = result.backlinks.length
          ? `<nav aria-label="Pages linking here"><ul>${result.backlinks.map(source => `<li><a href="${url(source.id)}">${esc(source.title)}</a>${source.relations.length ? `<small>Declared relation: ${esc(source.relations.join(", "))}</small>` : ""}</li>`).join("")}</ul></nav>${result.truncated ? `<p>Showing ${result.backlinks.length} of ${result.total} linking pages.</p>` : ""}<p class="backlinks-context">Explicit links · snapshot ${esc(result.revision.slice(0, 8))}</p><button type="button" class="subtle">Refresh links</button>`
          : '<p>No other pages link here yet.</p><button type="button" class="subtle">Refresh links</button>';
        content.querySelector("button")?.addEventListener("click", () => void load());
        if (canRestoreFocus()) content.querySelector<HTMLButtonElement>("button")?.focus();
      } catch {
        if (!panel.isConnected) return;
        loaded = false;
        content.innerHTML = '<p>Couldn’t load incoming links.</p><button type="button" class="subtle">Try again</button>';
        content.querySelector("button")!.addEventListener("click", () => void load());
        if (canRestoreFocus()) content.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    panel.addEventListener("toggle", () => {
      if (panel.open && !loaded) void load();
    });
  }
  const checkDelivery = main.querySelector<HTMLButtonElement>("#check-delivery")!;
  checkDelivery.addEventListener("click", async () => {
    const run = generation, token = ++deliveryGeneration;
    const restoreFocus = document.activeElement === checkDelivery;
    checkDelivery.disabled = true;
    checkDelivery.textContent = "Checking…";
    await refreshDelivery(run, token);
    if (checkDelivery.isConnected && run === generation && token === deliveryGeneration) {
      checkDelivery.disabled = false;
      checkDelivery.textContent = "Check sync status";
      if (restoreFocus && document.activeElement === document.body) checkDelivery.focus({ preventScroll: true });
    }
  });
  const historyPanel = main.querySelector<HTMLDetailsElement>(".page-history")!;
  const historyPageId = page.id;
  let historyLoading = false;
  historyPanel.addEventListener("toggle", async () => {
    if (!historyPanel.open || historyLoading) return;
    // Reopening reads current agent edits; toggling during a pending read must
    // still share that request rather than launching duplicate history loads.
    historyLoading = true;
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
      content.innerHTML = `<div class="error"><p>${esc((e as Error).message)}</p><p>Close and reopen history to retry.</p></div>`;
    } finally {
      historyLoading = false;
    }
  });
  main.querySelector("#start")!.addEventListener("click", () => {
    try {
      localStorage.setItem("secondbrain.startpage", page!.id);
      notice = "This is now your start page.";
      noticeError = false;
    } catch {
      notice = "Your browser could not remember this preference.";
      noticeError = true;
    }
    noticeAtSave = false;
    // Saving or setting a preference must not replace an active editor and
    // destroy the browser's native selection/undo history.
    if (editing) updateEditorState();
    else renderPage("start");
  });
  main.querySelector("#edit")!.addEventListener("click", () => {
    if (saving) return;
    if (
      editing &&
      draft !== page!.markdown &&
      !confirm("Discard unsaved changes?")
    )
      return;
    if (editing) {
      // A failed acknowledgement or conflict can leave this snapshot behind
      // the server. Discard the local draft, then read this same visit afresh.
      // The shared route handles missing/error/retry and ignores late reads.
      void route(true, true, undefined, { articleFocus: "edit" });
      renderPwaState();
      return;
    }
    editing = true;
    saveAttempt = null;
    if (editing) {
      draft = page!.markdown || "";
    }
    notice = "";
    noticeError = false;
    renderPage(editing ? "editor" : "edit");
  });
  if (editing) {
    const editor = main.querySelector<HTMLTextAreaElement>("#editor")!;
    // HTML parsing discards an initial textarea newline. Assign the value after
    // construction so opening the editor preserves every leading blank line.
    editor.value = draft;
    editor.addEventListener("input", (e) => {
      draft = (e.target as HTMLTextAreaElement).value;
      renderPwaState();
    });
    main.querySelector("#save")!.addEventListener("click", () => void save());
  }
  const targets = {
    editor: "#editor",
    edit: "#edit",
    start: "#start",
    heading: "article h1",
  } as const;
  if (focusTarget && !(focusTarget === "editor" && saving)) {
    main.querySelector<HTMLElement>(targets[focusTarget])?.focus();
  }
  // The listener is attached before opening, so the recreated panel fetches
  // current history instead of retaining a detached request or stale content.
  if (historyState?.open) historyPanel.open = true;
  if (historyState?.focused) historyPanel.querySelector("summary")?.focus({ preventScroll: true });
  renderPwaState();
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
    deliveryNotice = "Workspace status is unavailable. Local storage and remote delivery could not be verified. Try again.";
    const el = app.querySelector(".delivery-notice");
    if (el) el.textContent = deliveryNotice;
  }
}
function updateEditorState(restoreSaveFocus = false) {
  const main = app.querySelector("main")!;
  const editor = main.querySelector<HTMLTextAreaElement>("#editor");
  const button = main.querySelector<HTMLButtonElement>("#save");
  if (!editor || !button) return;
  // Keep the same textarea and never assign its value: text/selection alone
  // cannot reconstruct native undo history. Read-only keeps it selectable.
  editor.readOnly = saving;
  button.disabled = saving;
  button.textContent = saving ? "Saving…" : "Save changes →";
  main.querySelector<HTMLButtonElement>("#edit")!.disabled = saving;
  const message = main.querySelector<HTMLElement>(".notice")!;
  // Keep one live region. Save feedback belongs beside Save; preference
  // feedback stays above the draft near the toolbar that produced it.
  const saveFeedback = main.querySelector<HTMLElement>(".editor-feedback")!;
  if (noticeAtSave) {
    if (message.parentElement !== saveFeedback) saveFeedback.append(message);
  } else if (message.parentElement === saveFeedback) {
    main.querySelector('label[for="editor"]')!.before(message);
  }
  message.textContent = notice;
  message.classList.toggle("error", noticeError);
  main.querySelector<HTMLElement>(".delivery-notice")!.textContent = deliveryNotice;
  // A disabled Save button can leave focus on the document body. Return it
  // to the draft, but don't steal focus if the user chose another control.
  if (restoreSaveFocus && (document.activeElement === button || document.activeElement === document.body)) {
    editor.focus({ preventScroll: true });
    // Error text can expand the row beyond a previously visible Save button.
    // Reveal both only while restoring our own focus, not a later user choice.
    if (noticeError && noticeAtSave) saveFeedback.parentElement!.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  renderPwaState();
}
async function save() {
  if (!page || saving) return;
  const previousAttempt = saveAttempt;
  // An edit followed by undo must still recover a lost acknowledgement. Bind
  // the retry identity to the submitted payload, rather than each input event.
  if (!saveAttempt || saveAttempt.pageId !== page.id ||
    saveAttempt.markdown !== draft || saveAttempt.base_revision !== page.revision) {
    saveAttempt = { pageId: page.id, markdown: draft, base_revision: page.revision, request_id: crypto.randomUUID() };
  }
  const attempt = saveAttempt;
  saving = true;
  notice = "";
  noticeError = false;
  noticeAtSave = true;
  updateEditorState();
  try {
    const result = await api("/pages/" + encodeURIComponent(page.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: attempt.markdown,
        base_revision: attempt.base_revision,
        request_id: attempt.request_id,
      }),
    });
    page = result;
    editing = false;
    saveAttempt = null;
    notice = `Saved locally · revision ${String(result.revision).slice(0, 8)}.`;
    deliveryNotice = "Checking workspace indexing and remote delivery…";
    void refreshDelivery(generation, ++deliveryGeneration);
  } catch (e) {
    // A rejected newer edit did not publish. Keep an earlier lost-ack receipt
    // recoverable if the user restores that submitted draft after the conflict.
    if ((e as any).status === 409) saveAttempt = previousAttempt;
    noticeAtSave = true;
    noticeError = true;
    notice =
      (e as any).status === 409
        ? "Conflict: this page has a newer revision. Your draft is preserved. Copy it before reloading to review the latest version."
        : (e as Error).message + " Your draft is preserved. Try saving again.";
  } finally {
    saving = false;
    if (editing) updateEditorState(true);
    else renderPage("heading");
  }
}
window.addEventListener("popstate", event => {
  history.scrollRestoration = "manual";
  // Traversal can arrive before the last scroll event. Manual restoration
  // leaves the outgoing view in place until this handler replaces it.
  rememberReadingPoint();
  const entry = readNavigationEntry(event.state);
  const targetUrl = location.pathname + location.search + location.hash;
  if (restoringHistory) {
    if (entry?.id === activeEntry.id && targetUrl === activeUrl) {
      restoringHistory = false;
      window.clearTimeout(historyRestoreTimer);
      window.clearTimeout(historyCorrectionTimer);
    } else queueHistoryCorrection();
    return;
  }
  const previous = new URL(activeUrl, location.origin);
  if (previous.pathname === location.pathname && previous.search === location.search) {
    // Refresh can create adjacent Galaxy visits with the same URL. Resolve
    // their visit state before replacing activeEntry; fragment-only handling
    // remains enough when the visit itself has not changed.
    const galaxyVisitChanged = location.pathname === "/galaxy" && !!entry && entry.id !== activeEntry.id;
    // Unknown native entries cannot safely imply a new relative position.
    if (entry && (entry.id !== activeEntry.id || targetUrl === activeUrl)) {
      activeEntry = entry;
      replaceAppUrl(targetUrl);
    } else resetHistoryTracking(targetUrl);
    if (!viewComplete || galaxyVisitChanged) {
      void route(true, false, readingPoints.get(activeEntry.id));
      return;
    }
    focusFragment();
    if (!location.hash && readingReady) {
      const point = readingPoints.get(activeEntry.id);
      window.scrollTo(point?.x || 0, point?.y || 0);
    }
    return;
  }
  if (
    saving ||
    (editing &&
      draft !== page?.markdown &&
      !confirm("Leave this page? Unsaved changes will be lost."))
  ) {
    restoreHistory(entry);
    return;
  }
  if (entry) activeEntry = entry;
  else resetHistoryTracking(targetUrl);
  activeUrl = location.pathname + location.search + location.hash;
  void route(true, false, readingPoints.get(activeEntry.id));
});
window.addEventListener("hashchange", () => {
  const targetUrl = location.pathname + location.search + location.hash;
  if (restoringHistory || targetUrl === activeUrl) return;
  resetHistoryTracking(targetUrl);
  focusFragment();
});
window.addEventListener("beforeunload", (e) => {
  rememberReadingPoint();
  persistReadingPoints();
  if (!canReloadApp()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  rememberReadingPoint();
  persistReadingPoints();
});
resumeReadingPoints();
history.scrollRestoration = "manual";
replaceAppUrl(activeUrl);
startPwa(canReloadApp);
observePwa(state => {
  pwaState = state;
  renderPwaState();
});
void route(false, false, readingPoints.get(activeEntry.id));
