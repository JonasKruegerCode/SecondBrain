import cytoscape from "cytoscape";
// @ts-expect-error — no types for cytoscape-fcose
import fcose from "cytoscape-fcose";
import { marked } from "marked";

cytoscape.use(fcose);

const TYPE_COLORS: Record<string, string> = {
  topic: "#7c3aed",
  person: "#0ea5e9",
  project: "#10b981",
  tool: "#f59e0b",
  event: "#ef4444",
};

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const cy = cytoscape({
  container: document.getElementById("cy"),
  style: [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        label: "data(label)",
        color: "#ccc",
        "font-size": 10,
        "text-valign": "bottom",
        "text-margin-y": 4,
        width: 22,
        height: 22,
        "border-width": 0,
      },
    },
    {
      selector: "node:selected",
      style: { "border-width": 2, "border-color": "#fff", width: 28, height: 28 },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": "#2a2a40",
        "target-arrow-color": "#2a2a40",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "arrow-scale": 0.8,
      },
    },
    {
      selector: "edge[rel]",
      style: {
        label: "data(rel)",
        "font-size": 7,
        color: "#8888aa",
        "text-rotation": "autorotate",
        "text-background-color": "#12121c",
        "text-background-opacity": 0.8,
        "text-background-padding": "1px",
      },
    },
  ],
  layout: { name: "fcose" },
});

cy.on("tap", "node", (evt: cytoscape.EventObject) => {
  const d = evt.target.data() as { id: string; label: string };
  void openPageModal(d.id, d.label);
});

// ---------------------------------------------------------------------------
// Graph refresh
// ---------------------------------------------------------------------------

interface GraphData {
  nodes: Array<{ id: string; title?: string; type?: string }>;
  edges: Array<{ source: string; target: string; rel?: string | null }>;
}

function graphFingerprint(data: GraphData): string {
  const nodeIds = [...(data.nodes ?? [])].map((n) => n.id).sort().join(",");
  const edgeIds = [...(data.edges ?? [])]
    .map((e) => `${e.source}-${e.rel ?? ""}->${e.target}`)
    .sort()
    .join(",");
  return `${nodeIds}|${edgeIds}`;
}

let lastFingerprint = "";

async function loadGraph(force = false): Promise<void> {
  const btn = document.getElementById("refresh-btn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const r = await fetch("/api/graph");
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as GraphData;

    const fp = graphFingerprint(data);
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;

    const elements: cytoscape.ElementDefinition[] = [];
    (data.nodes ?? []).forEach((n) => {
      const type = n.type ?? "topic";
      elements.push({
        data: { id: n.id, label: n.title ?? n.id, type, color: TYPE_COLORS[type] ?? "#7c3aed" },
      });
    });
    (data.edges ?? []).forEach((e) => {
      if (e.source && e.target)
        elements.push({
          data: e.rel
            ? { source: e.source, target: e.target, rel: e.rel }
            : { source: e.source, target: e.target },
        });
    });

    cy.elements().remove();
    cy.add(elements);
    cy.layout({
      name: "fcose",
      animate: true,
      animationDuration: 800,
      quality: "default",
      randomize: true,
      fit: true,
      padding: 40,
      nodeRepulsion: () => 450000,
      idealEdgeLength: () => 80,
      edgeElasticity: () => 0.45,
      nodeSeparation: 75,
      numIter: 2500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).run();

    const n = data.nodes?.length ?? 0;
    const e = data.edges?.length ?? 0;
    const msg = `${n} nodes · ${e} edges`;
    document.getElementById("node-count")!.textContent = msg;
    const mCount = document.getElementById("m-node-count");
    if (mCount) mCount.textContent = msg;
  } catch {
    const err = "Graph unavailable";
    document.getElementById("node-count")!.textContent = err;
    const mCount = document.getElementById("m-node-count");
    if (mCount) mCount.textContent = err;
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------------------
// Wiki-Page Modal — View + Edit mode
// ---------------------------------------------------------------------------

let _modalSlug = "";
let _modalRawContent = "";
let _editMode = false;

async function openPageModal(slug: string, title: string): Promise<void> {
  _modalSlug = slug;
  _editMode = false;

  document.getElementById("modal-title")!.textContent = title;
  document.getElementById("modal-body")!.innerHTML =
    '<div id="modal-loading">Loading…</div>';
  setEditMode(false);
  document.getElementById("modal-delete-bar")!.classList.remove("visible");
  document.getElementById("modal-overlay")!.classList.add("open");

  try {
    const r = await fetch(`/api/page/${encodeURIComponent(slug)}`);
    const data = (await r.json()) as { content: string };
    _modalRawContent = data.content;
    document.getElementById("modal-body")!.innerHTML =
      await marked.parse(data.content);
    document.getElementById("modal-delete-bar")!.classList.add("visible");
    document.getElementById("modal-save-status")!.textContent = "";
  } catch {
    document.getElementById("modal-body")!.innerHTML =
      "<p>Page could not be loaded.</p>";
  }
}

function setEditMode(on: boolean): void {
  _editMode = on;
  const body = document.getElementById("modal-body")!;
  const editArea = document.getElementById("modal-edit-area")!;
  const modeBtn = document.getElementById("modal-mode-btn")!;

  if (on) {
    body.style.display = "none";
    editArea.classList.add("visible");
    modeBtn.style.display = "none";
    const ta = document.getElementById("modal-raw-textarea") as HTMLTextAreaElement;
    ta.value = _modalRawContent;
    ta.focus();
  } else {
    body.style.display = "";
    editArea.classList.remove("visible");
    modeBtn.style.display = "";
    modeBtn.textContent = "✎ Edit";
  }
}

document.getElementById("modal-mode-btn")!.addEventListener("click", () => {
  if (!_modalSlug) return;
  setEditMode(true);
});

document.getElementById("modal-save-btn")!.addEventListener("click", () => {
  void savePageRaw();
});

document.getElementById("modal-discard-btn")!.addEventListener("click", () => {
  setEditMode(false);
  document.getElementById("modal-save-status")!.textContent = "";
});

async function savePageRaw(): Promise<void> {
  const ta = document.getElementById("modal-raw-textarea") as HTMLTextAreaElement;
  const content = ta.value;
  const statusEl = document.getElementById("modal-save-status")!;
  const saveBtn = document.getElementById("modal-save-btn") as HTMLButtonElement;

  saveBtn.disabled = true;
  statusEl.textContent = "Saving…";

  try {
    const r = await fetch("/api/save-page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: _modalSlug, content }),
    });
    const data = (await r.json()) as { result?: string; error?: string };
    if (data.error) {
      statusEl.textContent = "❌ " + data.error;
    } else {
      _modalRawContent = content;
      statusEl.textContent = "✓ Saved";
      // Switch back to view, re-render
      document.getElementById("modal-body")!.innerHTML =
        await marked.parse(content);
      setEditMode(false);
      setTimeout(() => void loadGraph(true), 1500);
    }
  } catch (err) {
    statusEl.textContent = "Error: " + String(err);
  }
  saveBtn.disabled = false;
}

document.getElementById("modal-delete-page-btn")!.addEventListener("click", () => {
  if (!_modalSlug) return;
  if (!confirm(`Delete page "${_modalSlug}"? Git keeps the history.`)) return;
  void deletePage();
});

async function deletePage(): Promise<void> {
  const r = await fetch("/api/delete-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_id: _modalSlug, reason: "manual delete" }),
  });
  const data = (await r.json()) as { result?: string; error?: string };
  if (data.error) {
    alert("Error: " + data.error);
  } else {
    closeModalBtn();
    setTimeout(() => void loadGraph(true), 1000);
  }
}

function closeModalBtn(): void {
  document.getElementById("modal-overlay")!.classList.remove("open");
  _modalSlug = "";
  _editMode = false;
}

function closeModal(evt: MouseEvent): void {
  if ((evt.target as HTMLElement).id === "modal-overlay") closeModalBtn();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModalBtn();
  // Ctrl+S / Cmd+S im Edit-Modus speichern
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && _editMode) {
    e.preventDefault();
    void savePageRaw();
  }
});

// ---------------------------------------------------------------------------
// Remember / Recall
// ---------------------------------------------------------------------------

async function doRemember(): Promise<void> {
  const input = document.getElementById("remember-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  const btn = document.getElementById("remember-btn") as HTMLButtonElement;
  const status = document.getElementById("remember-status")!;
  btn.disabled = true;
  status.textContent = "Processing…";
  try {
    const r = await fetch("/api/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = (await r.json()) as { result?: string; error?: string };
    if (data.error) {
      status.textContent = "❌ " + data.error;
    } else {
      status.textContent = "✓ " + (data.result ?? "Saved");
      input.value = "";
      setTimeout(() => void loadGraph(true), 2000);
    }
  } catch (err) {
    status.textContent = "Error: " + String(err);
  }
  btn.disabled = false;
}

async function doRecall(): Promise<void> {
  const input = document.getElementById("recall-input") as HTMLInputElement;
  const query = input.value.trim();
  if (!query) return;
  const btn = document.getElementById("recall-btn") as HTMLButtonElement;
  const result = document.getElementById("recall-result")!;
  btn.disabled = true;
  result.style.display = "none";
  try {
    const r = await fetch("/api/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = (await r.json()) as { result: string };
    result.textContent = data.result;
    result.style.display = "block";
  } catch (err) {
    result.textContent = "Error: " + String(err);
    result.style.display = "block";
  }
  btn.disabled = false;
}

async function doRag(): Promise<void> {
  const input = document.getElementById("recall-input") as HTMLInputElement;
  const query = input.value.trim();
  if (!query) return;
  const btn = document.getElementById("rag-btn") as HTMLButtonElement;
  const result = document.getElementById("recall-result")!;
  btn.disabled = true;
  result.textContent = "Generating answer…";
  result.style.display = "block";
  try {
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = (await r.json()) as { result: string };
    result.innerHTML = await marked.parse(data.result);
  } catch (err) {
    result.textContent = "Error: " + String(err);
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------------------
// Ingestion log
// ---------------------------------------------------------------------------

interface PageEntry {
  slug: string;
  title: string;
  changes?: string;
  preview?: string;
}

interface IngestionLog {
  task_id: string;
  status: "running" | "done" | "failed";
  started: string;
  finished: string | null;
  input_preview: string;
  input?: string | null;
  pages_updated: PageEntry[];
  pages_created: PageEntry[];
  error: string | null;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function logSummary(log: IngestionLog): string {
  if (log.status === "running") return "running…";
  if (log.status === "failed") return `Error: ${log.error ?? "unknown"}`;
  const u = log.pages_updated?.length ?? 0;
  const c = log.pages_created?.length ?? 0;
  const parts: string[] = [];
  if (u > 0) parts.push(`${u} updated`);
  if (c > 0) parts.push(`${c} new`);
  return parts.length ? parts.join(", ") : "no changes";
}

function openIngestionModal(log: IngestionLog): void {
  document.getElementById("modal-title")!.textContent =
    `Ingestion · ${formatDateTime(log.started)}`;
  _modalSlug = "";
  setEditMode(false);
  document.getElementById("modal-delete-bar")!.classList.remove("visible");

  const statusLabel: Record<string, string> = {
    done: "✅ Done", running: "🟠 Running", failed: "❌ Error",
  };
  const duration = log.finished
    ? `${Math.round(
        (new Date(log.finished).getTime() - new Date(log.started).getTime()) / 1000
      )}s`
    : "—";

  const pageList = (pages: (PageEntry | string)[], label: string) => {
    if (!pages.length) return "";
    const items = pages.map((raw) => {
      const p: PageEntry = typeof raw === "string" ? { slug: raw, title: raw } : raw;
      const diff = p.changes ?? p.preview ?? "";
      const titlePart = p.title && p.title !== p.slug ? ` — ${p.title}` : "";
      const body = diff
        ? `<pre style="font-size:0.76rem;margin:4px 0 0;white-space:pre-wrap">${diff}</pre>`
        : "<em style='font-size:0.76rem'>no text changes</em>";
      return `<details style="margin:6px 0"><summary style="cursor:pointer;font-size:0.82rem"><code>${p.slug}</code>${titlePart}</summary>${body}</details>`;
    });
    return `<h3>${label}</h3>${items.join("")}`;
  };

  const preview = log.input_preview ?? "";
  const fullInput = log.input ?? "";
  const inputHtml =
    fullInput.length > preview.length
      ? `<p style="white-space:pre-wrap">${preview}…</p>
         <details style="margin:4px 0">
           <summary style="cursor:pointer;font-size:0.8rem;color:#7c3aed">
             Show full input (${fullInput.length} chars)
           </summary>
           <pre style="font-size:0.78rem;white-space:pre-wrap;margin:4px 0 0">${fullInput}</pre>
         </details>`
      : `<p style="white-space:pre-wrap">${fullInput || preview || "—"}</p>`;

  document.getElementById("modal-body")!.innerHTML = `
    <p><strong>Status:</strong> ${statusLabel[log.status] ?? log.status}
       &nbsp;·&nbsp; <strong>Duration:</strong> ${duration}</p>
    <h3>Input</h3>
    ${inputHtml}
    ${pageList(log.pages_updated ?? [], "Updated")}
    ${pageList(log.pages_created ?? [], "Created")}
    ${log.error ? `<h3>Error</h3><pre>${log.error}</pre>` : ""}
  `;
  document.getElementById("modal-overlay")!.classList.add("open");
}

async function loadIngestionLogs(): Promise<void> {
  const list = document.getElementById("ingestion-log-list")!;
  try {
    const r = await fetch("/api/ingestion-logs");
    if (!r.ok) throw new Error(String(r.status));
    const raw = (await r.json()) as IngestionLog[];
    if (!raw.length) {
      list.innerHTML = '<div class="status">No entries yet</div>';
      return;
    }
    const logs = [...raw]
      .sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1))
      .slice(0, 3);
    list.innerHTML = logs
      .map(
        (log) => `
      <div class="log-item" style="cursor:pointer">
        <div class="log-dot ${log.status}"></div>
        <div class="log-meta">
          <span>${(log.input_preview ?? "").slice(0, 110)}</span>
          <span class="log-time">${formatDateTime(log.started)} · ${logSummary(log)}</span>
        </div>
      </div>`
      )
      .join("");

    list.querySelectorAll<HTMLElement>(".log-item").forEach((el, i) => {
      el.addEventListener("click", () => openIngestionModal(logs[i]));
    });
  } catch {
    list.innerHTML = '<div class="status">Logs unavailable</div>';
  }
}

// ---------------------------------------------------------------------------
// Resizable sidebar
// ---------------------------------------------------------------------------

function setupSidebarResize(): void {
  const sidebar = document.getElementById("sidebar")!;
  const handle = document.getElementById("sidebar-resize")!;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.classList.add("resizing");
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(window.innerWidth * 0.6, startWidth + (e.clientX - startX)));
    sidebar.style.width = `${w}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    cy.resize();
  });
}

// ---------------------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------------------

function setupMobileNav(): void {
  const tabs = document.querySelectorAll<HTMLElement>(".m-tab");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab ?? "graph";
      tabs.forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      document.body.className = `tab-${tab}`;
      if (tab === "graph") requestAnimationFrame(() => cy.resize());
    });
  });
  document.getElementById("m-refresh-btn")?.addEventListener("click", () => void loadGraph(true));
  document.getElementById("refresh-btn")?.addEventListener("click", () => void loadGraph(true));
}

// ---------------------------------------------------------------------------
// Global + init
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    loadGraph: (force?: boolean) => Promise<void>;
    doRemember: () => Promise<void>;
    doRecall: () => Promise<void>;
    doRag: () => Promise<void>;
    closeModal: (evt: MouseEvent) => void;
    closeModalBtn: () => void;
  }
}
window.loadGraph = loadGraph;
window.doRemember = doRemember;
window.doRecall = doRecall;
window.doRag = doRag;
window.closeModal = closeModal;
window.closeModalBtn = closeModalBtn;

setupMobileNav();
setupSidebarResize();

void loadGraph(true);
setInterval(() => void loadGraph(), 30_000);

void loadIngestionLogs();
setInterval(() => void loadIngestionLogs(), 5_000);
