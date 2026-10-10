import "./galaxy.css";

export interface Graph {
  nodes: { id: string; title: string; galaxy?: { group: string; label?: string; anchor?: boolean } }[];
  edges: { source: string; target: string; type: string; rel?: string }[];
  revision?: string | null;
  status?: string;
  missing_targets?: { source: string; target: string }[];
  ambiguous_targets?: { source: string; target: string; candidates: string[] }[];
}
type Cluster = { id: number; core: string; members: string[]; isolated: boolean; curated: boolean; label?: string };
type Point = { x: number; y: number };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const colors = ["#81e1d3", "#c5a5fa", "#f5c887", "#90baf8", "#f0a8c1", "#b8d787"];

/**
 * Render a snapshot from /api/wiki/graph. onOpen receives a page ID, never a URL.
 * Returns an event-listener cleanup function; call it before replacing the view.
 * Layout is deterministic, derived from undirected link topology only. Edges keep
 * their original direction and relation in the evidence panel. Grouping is a
 * navigation aid, not a claim of semantic similarity or causality.
 */
export function renderGalaxy(main: HTMLElement, graph: Graph, onOpen?: (id: string) => void): () => void {
  const nodes = [...graph.nodes].sort((a, b) => compareId(a.id, b.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = graph.edges.filter(e => byId.has(e.source) && byId.has(e.target));
  const adjacency = new Map(nodes.map(n => [n.id, new Set<string>()]));
  edges.forEach(e => {
    if (e.source !== e.target) {
      adjacency.get(e.source)!.add(e.target);
      adjacency.get(e.target)!.add(e.source);
    }
  });
  const rank = (a: string, b: string) => adjacency.get(b)!.size - adjacency.get(a)!.size || compareId(a, b);
  const seen = new Set<string>(), clusters: Cluster[] = [], membership = new Map<string, number>();
  const curated = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (node.galaxy?.group) curated.set(node.galaxy.group, [...(curated.get(node.galaxy.group) || []), node]);
  }
  for (const [group, groupNodes] of [...curated].sort(([a], [b]) => compareId(a, b))) {
    const members = groupNodes.map(node => node.id).sort(rank);
    const anchors = groupNodes.filter(node => node.galaxy?.anchor).map(node => node.id).sort(rank);
    const core = anchors[0] || members[0];
    members.sort((a, b) => a === core ? -1 : b === core ? 1 : rank(a, b));
    const label = byId.get(core)?.galaxy?.label || groupNodes.find(node => node.galaxy?.label)?.galaxy?.label || group;
    const cluster = { id: clusters.length, core, members, isolated: false, curated: true, label };
    clusters.push(cluster);
    members.forEach(id => { membership.set(id, cluster.id); seen.add(id); });
  }
  const distance = (start: string) => {
    const distances = new Map([[start, 0]]), queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i])!) {
        if (!membership.has(next) && !distances.has(next)) {
          distances.set(next, distances.get(queue[i])! + 1);
          queue.push(next);
        }
      }
    }
    return distances;
  };
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const component = [...distance(node.id).keys()].sort(rank);
    component.forEach(id => seen.add(id));
    if (!adjacency.get(node.id)!.size) {
      const cluster = { id: clusters.length, core: node.id, members: [node.id], isolated: true, curated: false };
      clusters.push(cluster); membership.set(node.id, cluster.id); continue;
    }
    // Prefer the most connected page as a visible core. Add distant cores only
    // in larger components; nearest-core shortest paths form reproducible groups.
    // Broad overview pages otherwise absorb every neighbor into one giant group.
    // Prefer local link hubs; universal connectors stay visible as ordinary stars.
    const localHubs = component.filter(id => adjacency.get(id)!.size < (component.length - 1) * .8);
    const firstCore = localHubs[0] || component[0];
    const seeds = [firstCore], seedDistances = [distance(firstCore)];
    const limit = Math.min(8, Math.ceil(component.length / 7));
    for (const candidate of component) {
      if (seeds.length >= limit) break;
      if (seedDistances.every(d => d.get(candidate)! >= 2)) {
        seeds.push(candidate); seedDistances.push(distance(candidate));
      }
    }
    const baseId = clusters.length;
    const local = seeds.map((core, i) => ({ id: baseId + i, core, members: [] as string[], isolated: false, curated: false }));
    for (const id of component) {
      let owner = 0;
      for (let i = 1; i < seeds.length; i++) {
        if (seedDistances[i].get(id)! < seedDistances[owner].get(id)!) owner = i;
      }
      local[owner].members.push(id); membership.set(id, local[owner].id);
    }
    for (const cluster of local) {
      cluster.members.sort((a, b) => a === cluster.core ? -1 : b === cluster.core ? 1 : rank(a, b));
      clusters.push(cluster);
    }
  }
  const linked = clusters.filter(c => !c.isolated), isolated = clusters.filter(c => c.isolated);
  const bridges = edges.filter(e => membership.get(e.source) !== membership.get(e.target));
  const largeGraph = nodes.length > 250 || edges.length > 800;
  let selectedCluster: number | null = null, selectedNode: string | null = null, query = "", listOnly = largeGraph;
  let scale = 1, panX = 0, panY = 0, height = 600;
  const uid = `galaxy-${Math.random().toString(36).slice(2, 9)}`;
  const name = (id: string) => byId.get(id)?.title || id;
  const clusterName = (cluster: Cluster) => cluster.label || name(cluster.core);
  const article = (id: string, label = "Open article ↗") => `<a class="galaxy-article" data-open="${escape(id)}" href="/wiki/${encodeURIComponent(id)}">${escape(label)}</a>`;
  const matching = (id: string) => !query || `${name(id)} ${id}`.toLowerCase().includes(query);
  const color = (c: Cluster) => c.isolated ? "#a6afc2" : colors[c.id % colors.length];
  const button = (id: string) => `<button type="button" class="galaxy-page${selectedNode === id ? " is-selected" : ""}" data-node="${escape(id)}" aria-pressed="${selectedNode === id}"><i style="--cluster-color:${color(clusters[membership.get(id)!])}"></i><span>${escape(name(id))}<small>${adjacency.get(id)!.size} neighbor${adjacency.get(id)!.size === 1 ? "" : "s"}</small></span><b>→</b></button>`;
  main.innerHTML = `<section class="galaxy" aria-labelledby="${uid}-title"><div class="galaxy-heading"><div><div class="galaxy-eyebrow">YOUR WIKI, IN ORBIT</div><h1 id="${uid}-title">Follow a connection.</h1><p>Explore curated constellations and honest link neighborhoods. Pick a page to see the evidence.</p></div><a class="galaxy-return" href="/?overview=1">Page overview ↗</a></div><div class="galaxy-snapshot"><span><i></i>${nodes.length} pages</span><span>${edges.length} explicit links</span><span>${linked.length} constellation${linked.length === 1 ? "" : "s"}</span><span>${isolated.length} unlinked</span><span class="galaxy-revision">Snapshot ${escape(graph.revision?.slice(0, 8) || "empty")} · ${escape(graph.status || "unknown")}</span><a class="galaxy-refresh" href="/galaxy">Refresh snapshot ↻</a></div>${largeGraph ? '<p class="galaxy-scale-note">Large snapshot: list view opens first to keep browsing readable. Switch to Map view to inspect the topology.</p>' : ""}<div class="galaxy-workspace"><div class="galaxy-map"><div class="galaxy-mapbar"><div class="galaxy-breadcrumb"></div><div class="galaxy-controls"><button type="button" data-action="zoom-out" aria-label="Zoom out">−</button><button type="button" data-action="zoom-in" aria-label="Zoom in">+</button><button type="button" data-action="reset">Reset</button><button type="button" data-action="list" aria-pressed="${listOnly}">${listOnly ? "Map view" : "List view"}</button></div></div><div class="galaxy-stage"></div><div class="galaxy-mapnote"><span><i class="galaxy-legend-link"></i>Explicit Markdown link</span><span><i class="galaxy-legend-bridge"></i>Link across constellations</span><span>Drag to pan · + / − to zoom</span></div><details class="galaxy-method"><summary>How this map is arranged</summary><p>Pages with <code>galaxy_group</code> frontmatter form named, curated constellations; <code>galaxy_anchor: true</code> selects their core. Other pages fall back to deterministic link-topology neighborhoods. Broad connectors linked to at least 80% of a component are left as ordinary stars where possible. Unlinked pages have their own shelf. Positions and colors help navigation; they do not invent topics, relevance, or dependencies. Lines are resolved links from this Markdown snapshot. Link direction and declared relation are shown as evidence. This map stays at the shown revision until you refresh it.</p></details></div><aside class="galaxy-sidebar" aria-label="Explore pages"><label class="galaxy-search"><span>Find a page in this snapshot</span><input type="search" placeholder="Title or page ID…" aria-label="Find a page in this snapshot"></label><div class="galaxy-sidebar-content"></div></aside></div><div class="galaxy-status" aria-live="polite"></div></section>`;
  const root = main.querySelector<HTMLElement>(".galaxy")!;
  const stage = root.querySelector<HTMLElement>(".galaxy-stage")!;
  const sidebar = root.querySelector<HTMLElement>(".galaxy-sidebar-content")!;
  const status = root.querySelector<HTMLElement>(".galaxy-status")!;
  const setView = () => {
    const svg = stage.querySelector("svg");
    const width = 1100 / scale, viewHeight = height / scale;
    panX = Math.max(-350, Math.min(350, panX)); panY = Math.max(-height / 3, Math.min(height / 3, panY));
    svg?.setAttribute("viewBox", `${(1100 - width) / 2 + panX} ${(height - viewHeight) / 2 + panY} ${width} ${viewHeight}`);
  };
  function renderMap() {
    const active = selectedCluster === null ? null : clusters[selectedCluster];
    stage.hidden = listOnly;
    root.classList.toggle("is-list-view", listOnly);
    root.querySelector(".galaxy-breadcrumb")!.innerHTML = active ? `<button type="button" data-action="overview">← All constellations</button><span>${escape(clusterName(active))}</span>` : `<span>Galaxy overview</span>`;
    if (listOnly) { stage.innerHTML = ""; return; }
    const positions = new Map<string, Point>(), centers = new Map<number, Point>();
    const columns = linked.length <= 2 ? 2 : 3;
    const rows = Math.ceil(linked.length / columns);
    height = active ? 600 : Math.max(480, rows * 300 + (isolated.length ? 140 : 0));
    const shown = active ? [active] : linked;
    shown.forEach((c, i) => {
      const center = active ? { x: 550, y: 300 } : { x: (i % columns + .5) * 1100 / columns, y: Math.floor(i / columns) * 300 + 145 };
      centers.set(c.id, center); positions.set(c.core, center);
      const rest = c.members.filter(id => id !== c.core);
      const ringCapacity = active ? 16 : 12;
      rest.forEach((id, j) => {
        const ring = Math.floor(j / ringCapacity), count = Math.min(ringCapacity, rest.length - ring * ringCapacity);
        const angle = -Math.PI / 2 + (j % ringCapacity) * Math.PI * 2 / count + ring * .24;
        const rings = Math.ceil(rest.length / ringCapacity);
        const radius = active ? (rings <= 3 ? 105 + ring * 44 : 70 + (ring + 1) * 145 / rings) : (rings <= 3 ? 52 + ring * 20 : 35 + (ring + 1) * 65 / rings);
        positions.set(id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius * .8 });
      });
    });
    if (!active) isolated.forEach((c, i) => positions.set(c.core, { x: 70 + i % 15 * 68, y: Math.max(340, rows * 300) + 55 + Math.floor(i / 15) * 55 }));
    if (!active && isolated.length > 15) height += Math.floor((isolated.length - 1) / 15) * 55;
    const svgLinks = edges.map(e => {
      const a = positions.get(e.source), b = positions.get(e.target);
      if (!a || !b || e.source === e.target) return "";
      const cross = membership.get(e.source) !== membership.get(e.target);
      const selected = selectedNode === e.source || selectedNode === e.target;
      return `<line class="galaxy-edge${cross ? " is-bridge" : ""}${selected ? " is-active" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${escape(`${name(e.source)} → ${name(e.target)} (${e.rel || "wikilink"})`)}</title></line>`;
    }).join("");
    const halos = shown.map(c => {
      const p = centers.get(c.id)!;
      const size = active ? 245 : 125;
      const label = clusterName(c);
      return `<g class="galaxy-neighborhood" style="--cluster-color:${color(c)}"><ellipse cx="${p.x}" cy="${p.y}" rx="${size}" ry="${size * .8}"/><text x="${p.x}" y="${p.y - size * .8 - 15}" text-anchor="middle">${escape(label.length > 31 ? label.slice(0, 28) + "…" : label)}</text><text class="galaxy-count" x="${p.x}" y="${p.y - size * .8 + 3}" text-anchor="middle">${c.members.length} pages · ${c.curated ? "curated" : c.isolated ? "unlinked" : "link topology"}</text></g>`;
    }).join("");
    const stars = [...positions].map(([id, p]) => {
      const c = clusters[membership.get(id)!], core = !c.isolated && id === c.core;
      const related = selectedNode && (id === selectedNode || adjacency.get(selectedNode)!.has(id));
      const dimmed = !matching(id) || (selectedNode !== null && !related);
      return `<g class="galaxy-star${core ? " is-core" : ""}${selectedNode === id ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}" style="--cluster-color:${color(c)}" transform="translate(${p.x} ${p.y})" role="button" tabindex="0" data-node="${escape(id)}" aria-label="${escape(`${name(id)}, ${core ? "core, " : ""}${adjacency.get(id)!.size} neighbors`)}"><title>${escape(name(id))}</title><circle class="galaxy-hit" r="18"/><circle class="galaxy-glow" r="${core ? 17 : 9}"/><circle class="galaxy-dot" r="${core ? 7 : 4}"/>${(selectedNode === id || (active && core)) ? `<text x="0" y="${core ? 30 : 22}" text-anchor="middle">${escape(name(id).length > 27 ? name(id).slice(0, 25) + "…" : name(id))}</text>` : ""}</g>`;
    }).join("");
    stage.innerHTML = nodes.length ? `<svg role="group" aria-label="Wiki link galaxy; each page is a keyboard selectable star" viewBox="0 0 1100 ${height}" xmlns="http://www.w3.org/2000/svg">${halos}${svgLinks}${!active && isolated.length ? `<text class="galaxy-shelf" x="42" y="${Math.max(340, rows * 300) + 16}">UNLINKED PAGES · ${isolated.length}</text>` : ""}${stars}</svg>` : `<div class="galaxy-empty"><h2>A quiet sky.</h2><p>Add Markdown pages and explicit wikilinks to give this galaxy its first stars.</p><a href="/?overview=1">Go to pages →</a></div>`;
    stage.hidden = listOnly;
    root.classList.toggle("is-list-view", listOnly);
    root.querySelector(".galaxy-breadcrumb")!.innerHTML = active ? `<button type="button" data-action="overview">← All constellations</button><span>${escape(clusterName(active))}</span>` : `<span>Galaxy overview</span>`;
    setView();
  }
  function renderSidebar() {
    if (query) {
      const hits = nodes.filter(n => matching(n.id));
      sidebar.innerHTML = `<div class="galaxy-panel-heading"><h2>Matching pages</h2><span>${hits.length}</span></div>${hits.map(n => button(n.id)).join("") || '<p class="galaxy-muted">No title or page ID matches.</p>'}`;
    } else if (selectedNode !== null) {
      const id = selectedNode, c = clusters[membership.get(id)!];
      const evidence = edges.filter(e => e.source === id || e.target === id);
      const problems = [
        ...(graph.missing_targets || []).filter(e => e.source === id).map(e => `<li>Unresolved target: <code>${escape(e.target)}</code></li>`),
        ...(graph.ambiguous_targets || []).filter(e => e.source === id).map(e => `<li>Ambiguous target: <code>${escape(e.target)}</code> (${e.candidates.length} candidates)</li>`),
      ];
      sidebar.innerHTML = `<button type="button" class="galaxy-back" data-action="cluster">← Neighborhood pages</button><div class="galaxy-selected-heading"><div class="galaxy-eyebrow">${c.isolated ? "UNLINKED PAGE" : c.core === id ? "NEIGHBORHOOD CORE" : "SELECTED PAGE"}</div><h2>${escape(name(id))}</h2><code>${escape(id)}</code>${article(id)}</div><div class="galaxy-panel-heading"><h3>Link evidence</h3><span>${evidence.length}</span></div><p class="galaxy-muted">Arrows show the source page and its declared link target.</p>${evidence.length ? `<ul class="galaxy-evidence">${evidence.map(e => `<li><div>${article(e.source, name(e.source))}<span aria-label="links to">→</span>${article(e.target, name(e.target))}</div><small>${escape(e.rel ? `Declared relation: ${e.rel}` : "Explicit wikilink")}${membership.get(e.source) !== membership.get(e.target) ? " · across neighborhoods" : ""}</small>${e.source !== e.target ? `<button type="button" data-node="${escape(e.source === id ? e.target : e.source)}">Inspect neighbor →</button>` : '<small>Self-link</small>'}</li>`).join("")}</ul>` : '<p class="galaxy-muted">No resolved links. This page is placed separately.</p>'}${problems.length ? `<details class="galaxy-problems"><summary>${problems.length} unresolved link${problems.length === 1 ? "" : "s"}</summary><ul>${problems.join("")}</ul></details>` : ""}`;
    } else if (selectedCluster !== null) {
      const c = clusters[selectedCluster];
      const crossing = bridges.filter(e => membership.get(e.source) === c.id || membership.get(e.target) === c.id);
      sidebar.innerHTML = `<div class="galaxy-panel-heading"><h2>${escape(clusterName(c))}</h2><span>${c.members.length} pages</span></div><p class="galaxy-muted">${c.isolated ? "This page has no resolved links to other pages." : c.curated ? "Curated in Markdown frontmatter. Select a page to inspect the actual links." : "Grouped by shortest link paths to this core. Select a page to inspect actual links."}</p>${c.members.map(button).join("")}${crossing.length ? `<details class="galaxy-bridge-list"><summary>${crossing.length} links across constellations</summary>${crossing.map(e => `<p>${article(e.source, name(e.source))} → ${article(e.target, name(e.target))}<small>${escape(e.rel || "wikilink")}</small></p>`).join("")}</details>` : ""}`;
    } else {
      sidebar.innerHTML = `<div class="galaxy-panel-heading"><h2>Choose a constellation</h2><span>${linked.length}</span></div><p class="galaxy-muted">Curated groups come from page metadata. Uncurated groups describe link topology only.</p>${linked.map(c => `<button type="button" class="galaxy-cluster" data-cluster="${c.id}" style="--cluster-color:${color(c)}"><i></i><span>${escape(clusterName(c))}<small>${c.members.length} pages · ${c.curated ? "curated" : "link topology"} · ${bridges.filter(e => membership.get(e.source) === c.id || membership.get(e.target) === c.id).length} cross-links</small></span><b>↗</b></button>`).join("")}${isolated.length ? `<div class="galaxy-panel-heading galaxy-unlinked-heading"><h3>Unlinked pages</h3><span>${isolated.length}</span></div><p class="galaxy-muted">These pages have no links to other pages.</p>${isolated.map(c => button(c.core)).join("")}` : ""}`;
    }
    const issues = (graph.missing_targets?.length || 0) + (graph.ambiguous_targets?.length || 0);
    status.textContent = selectedNode ? `${name(selectedNode)} selected. ${edges.filter(e => e.source === selectedNode || e.target === selectedNode).length} resolved links.` : `${bridges.length} explicit links cross constellations.${issues ? ` ${issues} unresolved targets are excluded from the map.` : ""}`;
  }
  const render = () => { renderMap(); renderSidebar(); };
  const select = (id: string) => {
    if (!byId.has(id)) return;
    const next = membership.get(id)!;
    if (selectedCluster !== next) { scale = 1; panX = panY = 0; }
    selectedCluster = next; selectedNode = id; query = "";
    root.querySelector<HTMLInputElement>("input")!.value = "";
    render();
  };
  const click = (event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-node],[data-cluster],[data-action],[data-open]");
    if (!target || !root.contains(target)) return;
    if (target.dataset.open !== undefined) {
      if (onOpen && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
        event.preventDefault(); event.stopPropagation(); onOpen(target.dataset.open);
      }
      return;
    }
    if (target.dataset.node !== undefined) {
      select(target.dataset.node);
      if (event.detail === 0) sidebar.querySelector<HTMLElement>(".galaxy-article")?.focus();
    }
    else if (target.dataset.cluster !== undefined) {
      selectedCluster = Number(target.dataset.cluster); selectedNode = null; scale = 1; panX = panY = 0; render();
      if (event.detail === 0) sidebar.querySelector<HTMLElement>(".galaxy-page")?.focus();
    } else switch (target.dataset.action) {
      case "overview": selectedCluster = selectedNode = null; scale = 1; panX = panY = 0; render(); break;
      case "cluster": selectedNode = null; render(); break;
      case "zoom-in": scale = Math.min(2.5, scale + .25); setView(); break;
      case "zoom-out": scale = Math.max(.75, scale - .25); setView(); break;
      case "reset": scale = 1; panX = panY = 0; setView(); break;
      case "list": listOnly = !listOnly; target.setAttribute("aria-pressed", String(listOnly)); target.textContent = listOnly ? "Map view" : "List view"; render(); break;
    }
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.matches(".galaxy-star") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); select(target.dataset.node!);
      sidebar.querySelector<HTMLElement>(".galaxy-article")?.focus();
    }
  };
  const input = () => {
    query = root.querySelector<HTMLInputElement>("input")!.value.trim().toLowerCase(); render();
  };
  let drag: { x: number; y: number; px: number; py: number; pointerId: number } | null = null;
  const pointerdown = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as Element).closest(".galaxy-star")) return;
    drag = { x: event.clientX, y: event.clientY, px: panX, py: panY, pointerId: event.pointerId };
    stage.setPointerCapture(event.pointerId);
  };
  const pointermove = (event: PointerEvent) => {
    if (!drag) return;
    const bounds = stage.getBoundingClientRect();
    panX = drag.px - (event.clientX - drag.x) * 1100 / bounds.width / scale;
    panY = drag.py - (event.clientY - drag.y) * height / bounds.height / scale;
    setView();
  };
  const pointerup = () => {
    if (drag && stage.hasPointerCapture(drag.pointerId)) stage.releasePointerCapture(drag.pointerId);
    drag = null;
  };
  root.addEventListener("click", click); root.addEventListener("keydown", keydown);
  root.querySelector("input")!.addEventListener("input", input);
  stage.addEventListener("pointerdown", pointerdown); stage.addEventListener("pointermove", pointermove);
  stage.addEventListener("pointerup", pointerup); stage.addEventListener("pointercancel", pointerup);
  render();
  return () => {
    root.removeEventListener("click", click); root.removeEventListener("keydown", keydown);
    root.querySelector("input")?.removeEventListener("input", input);
    stage.removeEventListener("pointerdown", pointerdown); stage.removeEventListener("pointermove", pointermove);
    stage.removeEventListener("pointerup", pointerup); stage.removeEventListener("pointercancel", pointerup);
  };
}
