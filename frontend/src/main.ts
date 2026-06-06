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
  ],
  layout: { name: "fcose" },
});

cy.on("tap", "node", (evt: cytoscape.EventObject) => {
  const d = evt.target.data() as { id: string; label: string };
  void openPageModal(d.id, d.label);
});

// ---------------------------------------------------------------------------
// Smart graph refresh — only re-layout when data changed
// ---------------------------------------------------------------------------

interface GraphData {
  nodes: Array<{ id: string; title?: string; type?: string }>;
  edges: Array<{ source: string; target: string }>;
}

function graphFingerprint(data: GraphData): string {
  const nodeIds = [...(data.nodes ?? [])].map((n) => n.id).sort().join(",");
  const edgeIds = [...(data.edges ?? [])]
    .map((e) => `${e.source}->${e.target}`)
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
    if (!force && fp === lastFingerprint) return; // no change — skip redraw
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
        elements.push({ data: { source: e.source, target: e.target } });
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
// Markdown modal
// ---------------------------------------------------------------------------

async function openPageModal(slug: string, title: string): Promise<void> {
  const overlay = document.getElementById("modal-overlay")!;
  const modalTitle = document.getElementById("modal-title")!;
  const modalBody = document.getElementById("modal-body")!;

  modalTitle.textContent = title;
  modalBody.innerHTML = '<div id="modal-loading">Loading…</div>';
  overlay.classList.add("open");

  try {
    const r = await fetch(`/api/page/${encodeURIComponent(slug)}`);
    const data = (await r.json()) as { content: string };
    modalBody.innerHTML = await marked.parse(data.content);
  } catch {
    modalBody.innerHTML = "<p>Page could not be loaded.</p>";
  }
}

function closeModalBtn(): void {
  document.getElementById("modal-overlay")!.classList.remove("open");
}

function closeModal(evt: MouseEvent): void {
  if ((evt.target as HTMLElement).id === "modal-overlay") closeModalBtn();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModalBtn();
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
    const data = (await r.json()) as { result: string };
    status.textContent = "✓ " + data.result;
    input.value = "";
    setTimeout(() => void loadGraph(true), 4000);
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
  pages_updated: PageEntry[];
  pages_created: PageEntry[];
  error: string | null;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
  const overlay = document.getElementById("modal-overlay")!;
  document.getElementById("modal-title")!.textContent =
    `Ingestion · ${formatDateTime(log.started)}`;

  const statusLabel: Record<string, string> = {
    done: "✅ Done", running: "🟠 Running", failed: "❌ Error",
  };
  const duration = log.finished
    ? `${Math.round((new Date(log.finished).getTime() - new Date(log.started).getTime()) / 1000)}s`
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

  document.getElementById("modal-body")!.innerHTML = `
    <p><strong>Status:</strong> ${statusLabel[log.status] ?? log.status} &nbsp;·&nbsp; <strong>Duration:</strong> ${duration}</p>
    <h3>Input</h3>
    <p>${log.input_preview ?? "—"}</p>
    ${pageList(log.pages_updated ?? [], "Updated")}
    ${pageList(log.pages_created ?? [], "Created")}
    ${log.error ? `<h3>Error</h3><pre>${log.error}</pre>` : ""}
  `;
  overlay.classList.add("open");
}

async function loadIngestionLogs(): Promise<void> {
  const list = document.getElementById("ingestion-log-list")!;
  try {
    const r = await fetch("/api/ingestion-logs");
    if (!r.ok) throw new Error(String(r.status));
    const raw = (await r.json()) as IngestionLog[];
    if (!raw.length) {
      list.innerHTML = '<div class="status">No tasks yet</div>';
      return;
    }
    // Running tasks always on top
    const logs = [...raw]
      .sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1))
      .slice(0, 4);
    list.innerHTML = logs.map((log) => `
      <div class="log-item" style="cursor:pointer">
        <div class="log-dot ${log.status}"></div>
        <div class="log-meta">
          <span>${log.input_preview ?? ""}</span>
          <span class="log-time">${formatTime(log.started)} · ${logSummary(log)}</span>
        </div>
      </div>`).join("");

    list.querySelectorAll<HTMLElement>(".log-item").forEach((el, i) => {
      el.addEventListener("click", () => openIngestionModal(logs[i]));
    });
  } catch {
    list.innerHTML = '<div class="status">Logs unavailable</div>';
  }
}

// ---------------------------------------------------------------------------
// Mobile bottom navigation
// ---------------------------------------------------------------------------

function setupMobileNav(): void {
  const tabs = document.querySelectorAll<HTMLElement>(".m-tab");

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab ?? "graph";
      tabs.forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      document.body.className = `tab-${tab}`;
      if (tab === "graph") {
        // Let the browser repaint first so the canvas has dimensions
        requestAnimationFrame(() => cy.resize());
      }
    });
  });

  document.getElementById("m-refresh-btn")?.addEventListener("click", () => {
    void loadGraph(true);
  });

  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    void loadGraph(true);
  });
}

// ---------------------------------------------------------------------------
// Global handlers + init
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    loadGraph: (force?: boolean) => Promise<void>;
    doRemember: () => Promise<void>;
    doRecall: () => Promise<void>;
    closeModal: (evt: MouseEvent) => void;
    closeModalBtn: () => void;
  }
}
window.loadGraph = loadGraph;
window.doRemember = doRemember;
window.doRecall = doRecall;
window.closeModal = closeModal;
window.closeModalBtn = closeModalBtn;

setupMobileNav();

void loadGraph(true);
setInterval(() => void loadGraph(), 30_000);

void loadIngestionLogs();
setInterval(() => void loadIngestionLogs(), 5_000);
