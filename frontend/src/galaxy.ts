import "./galaxy.css";
import { layoutGalaxyField, mountGalaxyField, type GalaxyField } from "./galaxy-field";

export interface Graph {
  nodes: { id: string; title: string; galaxy?: { group: string; label?: string; anchor?: boolean } }[];
  edges: { source: string; target: string; type: string; rel?: string }[];
  groups?: Cluster[];
  revision?: string | null;
  status?: string;
  missing_targets?: { source: string; target: string }[];
  ambiguous_targets?: { source: string; target: string; candidates: string[] }[];
}
type Cluster = { id: number; core: string; members: string[]; isolated: boolean; curated: boolean; label?: string };
export interface GalaxyViewState {
  selectedNode: string | null;
  clusterCore: string | null;
  query: string;
  scale: number;
  panX: number;
  panY: number;
  sidebarScroll: number;
}
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
export function renderGalaxy(main: HTMLElement, graph: Graph, onOpen?: (id: string) => void,
  options: { initialPage?: string; initialState?: GalaxyViewState; onLeave?: (state: GalaxyViewState) => void } = {}): () => void {
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
  // Older graph servers can still render; current REST/MCP share server groups.
  const legacyGroups = (): Cluster[] => {
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
    return clusters;
  };
  const clusters = graph.groups?.map(group => ({ ...group, members: [...group.members] })) || legacyGroups();
  const membership = new Map<string, number>();
  clusters.forEach(cluster => cluster.members.forEach(id => membership.set(id, cluster.id)));
  const linked = clusters.filter(c => !c.isolated), isolated = clusters.filter(c => c.isolated);
  const bridges = edges.filter(e => membership.get(e.source) !== membership.get(e.target));
  const largeGraph = nodes.length > 250 || edges.length > 800;
  let selectedCluster: number | null = null, selectedNode: string | null = null, query = "";
  let scale = 1, panX = 0, panY = 0;
  const previous = options.initialState;
  if (previous) {
    // Resolve stable page IDs against the freshly read graph. A deleted page
    // must not restore an invalid selection or an obsolete cluster index.
    if (previous.selectedNode && byId.has(previous.selectedNode)) {
      selectedNode = previous.selectedNode;
      selectedCluster = membership.get(selectedNode)!;
    } else if (previous.clusterCore && byId.has(previous.clusterCore)) {
      selectedCluster = membership.get(previous.clusterCore)!;
    }
    query = previous.query;
    scale = Math.max(.75, Math.min(selectedCluster === null ? 2.5 : 4, previous.scale));
    panX = previous.panX; panY = previous.panY;
  } else if (options.initialPage && byId.has(options.initialPage)) {
    // A direct article entry is resolved against this snapshot, not a title or
    // an old cluster number. Existing visit state wins on history return.
    selectedNode = options.initialPage;
    selectedCluster = membership.get(selectedNode)!;
  }
  const missingEntry = !!options.initialPage && !byId.has(options.initialPage);
  if (missingEntry && previous?.selectedNode === options.initialPage) {
    selectedNode = null; selectedCluster = null; query = "";
    scale = 1; panX = 0; panY = 0;
  }
  // A single roving tab stop keeps a large graph out of the page's tab sequence.
  // Arrow keys move spatially; the list remains the complete alternative.
  let rovingNode = selectedNode || (selectedCluster === null
    ? linked[0]?.core || isolated[0]?.core : clusters[selectedCluster]?.core) || null;
  const uid = `galaxy-${Math.random().toString(36).slice(2, 9)}`;
  const name = (id: string) => byId.get(id)?.title || id;
  const clusterName = (cluster: Cluster) => cluster.label || name(cluster.core);
  const article = (id: string, label = "Open article ↗") => `<a class="galaxy-article" data-open="${escape(id)}" href="/wiki/${encodeURIComponent(id)}">${escape(label)}</a>`;
  const matching = (id: string) => !query || `${name(id)} ${id}`.toLowerCase().includes(query);
  const color = (c: Cluster) => c.isolated ? "#a6afc2" : colors[c.id % colors.length];
  const button = (id: string) => `<button type="button" class="galaxy-page${selectedNode === id ? " is-selected" : ""}" data-node="${escape(id)}" aria-pressed="${selectedNode === id}"><i style="--cluster-color:${color(clusters[membership.get(id)!])}"></i><span>${escape(name(id))}<small>${adjacency.get(id)!.size} neighbor${adjacency.get(id)!.size === 1 ? "" : "s"}</small></span><b>→</b></button>`;
  main.innerHTML = `<section class="galaxy" aria-labelledby="${uid}-title"><div class="galaxy-heading"><div><div class="galaxy-eyebrow">YOUR WIKI, IN ORBIT</div><h1 id="${uid}-title">Follow a connection.</h1><p>Explore curated constellations and honest link neighborhoods. Pick a page to see the evidence.</p></div><a class="galaxy-return" href="/?overview=1">Page overview ↗</a></div><div class="galaxy-snapshot"><span><i></i>${nodes.length} pages</span><span>${edges.length} explicit links</span><span>${linked.length} constellation${linked.length === 1 ? "" : "s"}</span><span>${isolated.length} unlinked</span><span class="galaxy-revision">Snapshot ${escape(graph.revision?.slice(0, 8) || "empty")} · ${escape(graph.status || "unknown")}</span><a class="galaxy-refresh" href="/galaxy">Refresh snapshot ↻</a></div>${largeGraph ? '<p class="galaxy-scale-note">Large snapshot: every page is still a star. Brighter stars have more explicit links. Search and the side panel name every page.</p>' : ""}<div class="galaxy-workspace"><div class="galaxy-map"><div class="galaxy-mapbar"><div class="galaxy-breadcrumb"></div><div class="galaxy-controls"><button type="button" data-action="zoom-out" aria-label="Zoom out">−</button><button type="button" data-action="zoom-in" aria-label="Zoom in">+</button><button type="button" data-action="reset">Reset</button></div></div><p class="galaxy-density-note" hidden aria-live="polite"></p><div class="galaxy-stage"></div><ul class="galaxy-bridge-index sr-only"></ul><div class="galaxy-mapnote"><span><i class="galaxy-legend-link"></i>Explicit Markdown link</span><span><i class="galaxy-legend-bridge"></i>Link across constellations</span><span>Drag or touch to pan · Arrow keys move between stars · Enter to inspect · + / − to zoom</span></div><details class="galaxy-method"><summary>How this map is arranged</summary><p>Pages with <code>galaxy_group</code> frontmatter form named, curated constellations; <code>galaxy_anchor: true</code> selects their core. Other pages fall back to deterministic link-topology neighborhoods. Broad connectors linked to at least 80% of a component are left as ordinary stars where possible. Unlinked pages have their own shelf. Positions and colors help navigation; they do not invent topics, relevance, or dependencies. Lines are resolved links from this Markdown snapshot. Link direction and declared relation are shown as evidence. This map stays at the shown revision until you refresh it.</p></details></div><aside class="galaxy-sidebar" aria-label="Explore pages"><label class="galaxy-search"><span>Find a page in this snapshot</span><input type="search" placeholder="Title or page ID…" aria-label="Find a page in this snapshot"></label><div class="galaxy-sidebar-content"></div></aside></div><div class="galaxy-status" aria-live="polite"></div></section>`;
  const root = main.querySelector<HTMLElement>(".galaxy")!;
  const refresh = root.querySelector<HTMLAnchorElement>(".galaxy-refresh")!;
  refresh.href = options.initialPage ? `/galaxy?page=${encodeURIComponent(options.initialPage)}` : "/galaxy";
  if (missingEntry) {
    const notice = document.createElement("p");
    notice.className = "galaxy-entry-notice";
    notice.setAttribute("role", "status");
    // Do not echo an arbitrary URL parameter or imply an invented node.
    notice.textContent = "This page is not in the current snapshot. Explore the available pages.";
    root.querySelector(".galaxy-snapshot")!.after(notice);
  }
  const stage = root.querySelector<HTMLElement>(".galaxy-stage")!;
  const sidebar = root.querySelector<HTMLElement>(".galaxy-sidebar-content")!;
  const status = root.querySelector<HTMLElement>(".galaxy-status")!;
  const syncRovingTabStop = () => {
    const stars = [...stage.querySelectorAll<HTMLElement>(".galaxy-star")];
    if (!stars.length) return;
    if (!stars.some(star => star.dataset.node === rovingNode)) {
      rovingNode = selectedNode && stars.some(star => star.dataset.node === selectedNode)
        ? selectedNode : stars[0].dataset.node || null;
    }
    stars.forEach(star => { star.tabIndex = star.dataset.node === rovingNode ? 0 : -1; });
  };
  root.querySelector(".galaxy-method p")!.append(document.createTextNode(" Brightness and size follow the number of explicit neighbors. Warmer threads are individual links that cross groups, not similarity and not one edge between the cores. Select a page to read direction and relation."));
  root.querySelector(".galaxy-mapnote span:last-child")!.append(document.createTextNode(" · Use the page list for closely spaced stars."));
  const fieldModel = nodes.length ? layoutGalaxyField(nodes, edges, clusters, adjacency) : null;
  const field: GalaxyField | null = fieldModel ? mountGalaxyField(stage, fieldModel, {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    onSelect: () => undefined,
  }) : null;
  if (!field && !nodes.length) stage.innerHTML = `<div class="galaxy-empty"><h2>A quiet sky.</h2><p>Add Markdown pages and explicit wikilinks to give this galaxy its first stars.</p><a href="/?overview=1">Go to pages →</a></div>`;
  const setView = () => { field?.setCamera({ scale, panX, panY }); };
  let cameraReady = false;
  function renderMap() {
    const active = selectedCluster === null ? null : clusters[selectedCluster];
    stage.hidden = false;
    root.querySelector(".galaxy-breadcrumb")!.innerHTML = active ? `<button type="button" data-action="overview">← All constellations</button><span>${escape(clusterName(active))}</span>` : `<span>Galaxy</span>`;
    if (!field) return;
    if (!cameraReady) {
      field.setCamera({ scale, panX, panY });
      cameraReady = true;
    } else {
      const live = field.getCamera();
      scale = live.scale; panX = live.panX; panY = live.panY;
    }
    field.resize();
    field.setView({ selected: selectedNode, query, focusGroup: selectedCluster });
    const pairs = new Map<string, { a: string; b: string; n: number }>();
    bridges.forEach(edge => {
      const leftName = clusterName(clusters[membership.get(edge.source)!]);
      const rightName = clusterName(clusters[membership.get(edge.target)!]);
      const [a, b] = leftName < rightName ? [leftName, rightName] : [rightName, leftName];
      const key = `${a}\0${b}`;
      const row = pairs.get(key) || { a, b, n: 0 };
      row.n += 1;
      pairs.set(key, row);
    });
    const index = root.querySelector(".galaxy-bridge-index");
    if (index) index.innerHTML = [...pairs.values()]
      .sort((p, q) => p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0)
      .map(row => `<li>${row.n} explicit link${row.n === 1 ? "" : "s"} between ${escape(row.a)} and ${escape(row.b)}</li>`).join("");
    const internalLinks = edges.filter(edge => edge.source !== edge.target && membership.get(edge.source) === membership.get(edge.target)).length;
    stage.dataset.internalLinks = String(internalLinks);
    stage.dataset.bridgeLinks = String(bridges.length);
    const densityNote = root.querySelector<HTMLElement>(".galaxy-density-note");
    if (densityNote) {
      const inside = active ? edges.filter(edge => membership.get(edge.source) === active.id && membership.get(edge.target) === active.id).length : 0;
      if (active && inside > 80) {
        densityNote.hidden = false;
        densityNote.textContent = `Dense constellation: showing stars for all ${active.members.length} pages. Direct links within this constellation are drawn as you zoom, and in full when a page or the core is selected.`;
      } else densityNote.hidden = true;
    }
    syncRovingTabStop();
  }
  let searchMarkup: string | null = null;
  function renderSidebar() {
    if (query) {
      const hits = nodes.filter(n => matching(n.id));
      const markup = `<div class="galaxy-panel-heading"><h2>Matching pages</h2><span>${hits.length}</span></div>${hits.map(n => button(n.id)).join("") || '<p class="galaxy-muted">No title or page ID matches.</p>'}`;
      // Consecutive prefixes often have identical results. Keep those buttons
      // mounted; replacing hundreds of identical rows still incurs layout work.
      if (markup !== searchMarkup) sidebar.innerHTML = markup;
      searchMarkup = markup;
    } else if (selectedNode !== null) {
      searchMarkup = null;
      const id = selectedNode, c = clusters[membership.get(id)!];
      const evidence = edges.filter(e => e.source === id || e.target === id);
      const problems = [
        ...(graph.missing_targets || []).filter(e => e.source === id).map(e => `<li>Unresolved target: <code>${escape(e.target)}</code></li>`),
        ...(graph.ambiguous_targets || []).filter(e => e.source === id).map(e => `<li>Ambiguous target: <code>${escape(e.target)}</code> (${e.candidates.length} candidates)</li>`),
      ];
      sidebar.innerHTML = `<button type="button" class="galaxy-back" data-action="cluster">← Neighborhood pages</button><div class="galaxy-selected-heading"><div class="galaxy-eyebrow">${c.isolated ? "UNLINKED PAGE" : c.core === id ? "NEIGHBORHOOD CORE" : "SELECTED PAGE"}</div><h2>${escape(name(id))}</h2><code>${escape(id)}</code>${article(id)}</div><div class="galaxy-panel-heading"><h3>Link evidence</h3><span>${evidence.length}</span></div><p class="galaxy-muted">Arrows show the source page and its declared link target. Brightness on the map is ${adjacency.get(id)!.size} explicit neighbor${adjacency.get(id)!.size === 1 ? "" : "s"}, not importance.</p>${evidence.length ? `<ul class="galaxy-evidence">${evidence.map(e => `<li><div>${article(e.source, name(e.source))}<span role="img" aria-label="links to">→</span>${article(e.target, name(e.target))}</div><small>${escape(e.rel ? `Declared relation: ${e.rel}` : "Explicit wikilink")}${membership.get(e.source) !== membership.get(e.target) ? " · across neighborhoods" : ""}</small>${e.source !== e.target ? `<button type="button" data-node="${escape(e.source === id ? e.target : e.source)}">Inspect neighbor →</button>` : '<small>Self-link</small>'}</li>`).join("")}</ul>` : '<p class="galaxy-muted">No resolved links. This page is placed separately.</p>'}${problems.length ? `<details class="galaxy-problems"><summary>${problems.length} unresolved link${problems.length === 1 ? "" : "s"}</summary><ul>${problems.join("")}</ul></details>` : ""}`;
    } else if (selectedCluster !== null) {
      searchMarkup = null;
      const c = clusters[selectedCluster];
      const crossing = bridges.filter(e => membership.get(e.source) === c.id || membership.get(e.target) === c.id);
      sidebar.innerHTML = `<div class="galaxy-panel-heading"><h2>${escape(clusterName(c))}</h2><span>${c.members.length} pages</span></div><p class="galaxy-muted">${c.isolated ? "This page has no resolved links to other pages." : c.curated ? "Curated in Markdown frontmatter. Select a page to inspect the actual links." : "Grouped by shortest link paths to this core. Select a page to inspect actual links."}</p>${c.members.map(button).join("")}${crossing.length ? `<details class="galaxy-bridge-list"><summary>${crossing.length} links across constellations</summary>${crossing.map(e => `<p>${article(e.source, name(e.source))} → ${article(e.target, name(e.target))}<small>${escape(e.rel || "wikilink")}</small></p>`).join("")}</details>` : ""}`;
    } else {
      searchMarkup = null;
      sidebar.innerHTML = `<div class="galaxy-panel-heading"><h2>Choose a constellation</h2><span>${linked.length}</span></div><p class="galaxy-muted">Curated groups come from page metadata. Uncurated groups describe link topology only.</p>${linked.map(c => `<button type="button" class="galaxy-cluster" data-cluster="${c.id}" style="--cluster-color:${color(c)}"><i></i><span>${escape(clusterName(c))}<small>${c.members.length} pages · ${c.curated ? "curated" : "link topology"} · ${bridges.filter(e => membership.get(e.source) === c.id || membership.get(e.target) === c.id).length} cross-links</small></span><b>↗</b></button>`).join("")}${isolated.length ? `<div class="galaxy-panel-heading galaxy-unlinked-heading"><h3>Unlinked pages</h3><span>${isolated.length}</span></div><p class="galaxy-muted">These pages have no links to other pages.</p>${isolated.map(c => button(c.core)).join("")}` : ""}`;
    }
    // New list/detail content starts at its heading. Keyboard return handling
    // can then reveal the originating page explicitly instead of retaining an
    // unrelated offset from the previous constellation list.
    sidebar.scrollTop = 0;
    const issues = (graph.missing_targets?.length || 0) + (graph.ambiguous_targets?.length || 0);
    status.textContent = selectedNode ? `${name(selectedNode)} selected. ${edges.filter(e => e.source === selectedNode || e.target === selectedNode).length} resolved links.` : `${bridges.length} explicit links cross constellations.${issues ? ` ${issues} unresolved targets are excluded from the map.` : ""}`;
  }
  const render = () => { renderMap(); renderSidebar(); };
  const select = (id: string) => {
    if (!byId.has(id)) return;
    const next = membership.get(id)!;
    if (selectedCluster !== next) { scale = 1; panX = panY = 0; }
    selectedCluster = next; selectedNode = id; rovingNode = id; query = "";
    root.querySelector<HTMLInputElement>("input")!.value = "";
    render();
  };
  const revealMobile = (element: HTMLElement) => {
    if (window.matchMedia("(max-width: 680px)").matches) {
      element.scrollIntoView({ block: "start", behavior: "instant" });
    }
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
      const id = target.dataset.node;
      const fromStar = target.classList.contains("galaxy-star");
      const fromPage = target.classList.contains("galaxy-page");
      const fromSidebarButton = target.tagName === "BUTTON" && !fromStar;
      const mobile = window.matchMedia("(max-width: 680px)").matches;
      select(id);
      // A desktop star click keeps focus on that star. Sidebar controls and
      // a narrow-screen star click move focus to the evidence.
      if (event.detail === 0 || fromPage || fromSidebarButton || (fromStar && mobile)) {
        sidebar.querySelector<HTMLElement>(".galaxy-article")?.focus({ preventScroll: true });
      } else if (fromStar) {
        [...stage.querySelectorAll<HTMLElement>(".galaxy-star")]
          .find(star => star.dataset.node === id)?.focus({ preventScroll: true });
      }
      if (event.detail !== 0 && mobile && (fromStar || fromPage)) revealMobile(sidebar.parentElement!);
    }
    else if (target.dataset.cluster !== undefined) {
      selectedCluster = Number(target.dataset.cluster); selectedNode = null; rovingNode = clusters[selectedCluster].core; scale = 1; panX = panY = 0; render();
      const touchNavigation = event.detail !== 0 && window.matchMedia("(max-width: 680px)").matches;
      if (touchNavigation) {
        // On a stacked mobile layout, reveal the map itself rather than the
        // taller map-plus-sidebar workspace. Keep focus on its real core star.
        stage.querySelector<HTMLElement>('.galaxy-star[tabindex="0"]')?.focus({ preventScroll: true });
        revealMobile(root.querySelector<HTMLElement>(".galaxy-map")!);
      } else {
        // Keyboard users can continue directly into the complete page list.
        sidebar.querySelector<HTMLElement>(".galaxy-page")?.focus({ preventScroll: true });
      }
    } else switch (target.dataset.action) {
      case "overview": {
        const previous = selectedCluster;
        selectedCluster = selectedNode = null;
        rovingNode = previous === null ? rovingNode : clusters[previous].core;
        scale = 1; panX = panY = 0; render();
        if (previous !== null) {
          const cluster = sidebar.querySelector<HTMLElement>(`[data-cluster="${previous}"]`);
          const unlinked = [...sidebar.querySelectorAll<HTMLElement>("[data-node]")].find(el => el.dataset.node === clusters[previous].core);
          (cluster || unlinked || root.querySelector<HTMLInputElement>("input"))?.focus({ preventScroll: true });
          if (event.detail !== 0 && window.matchMedia("(max-width: 680px)").matches) revealMobile(sidebar.parentElement!);
        }
        break;
      }
      case "cluster": {
        const previous = selectedNode;
        selectedNode = null; render();
        const page = [...sidebar.querySelectorAll<HTMLElement>("[data-node]")].find(el => el.dataset.node === previous);
        (page || root.querySelector<HTMLInputElement>("input"))?.focus({ preventScroll: true });
        if (event.detail !== 0 && window.matchMedia("(max-width: 680px)").matches) revealMobile(sidebar.parentElement!);
        break;
      }
      case "zoom-in": scale = Math.min(selectedCluster === null ? 2.5 : 4, scale + .25); setView(); break;
      case "zoom-out": scale = Math.max(.75, scale - .25); setView(); break;
      case "reset": scale = 1; panX = panY = 0; setView(); break;
    }
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (!field || !target.matches(".galaxy-star") || event.ctrlKey || event.metaKey || event.altKey) {
      if (target.matches?.(".galaxy-star") && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); select(target.dataset.node!);
        sidebar.querySelector<HTMLElement>(".galaxy-article")?.focus();
      }
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const direction = event.key === "ArrowLeft" ? { x: -1, y: 0 }
        : event.key === "ArrowRight" ? { x: 1, y: 0 }
        : event.key === "ArrowUp" ? { x: 0, y: -1 } : { x: 0, y: 1 };
      const nextId = field.nearest(target.dataset.node || "", direction);
      const next = [...stage.querySelectorAll<HTMLElement>(".galaxy-star")].find(star => star.dataset.node === nextId);
      if (next) {
        event.preventDefault();
        rovingNode = next.dataset.node || null;
        syncRovingTabStop();
        next.focus();
      }
      return;
    }
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      scale = Math.max(.75, Math.min(4, scale + (event.key === "-" ? -.25 : .25)));
      setView();
      field.reveal(target.dataset.node || "");
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); select(target.dataset.node!);
      sidebar.querySelector<HTMLElement>(".galaxy-article")?.focus();
    }
  };
  const focusin = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    if (!target.matches?.(".galaxy-star")) return;
    rovingNode = target.dataset.node || rovingNode;
    syncRovingTabStop();
    field?.reveal(target.dataset.node || "");
  };
  const input = () => {
    query = root.querySelector<HTMLInputElement>("input")!.value.trim().toLowerCase();
    field?.setView({ selected: selectedNode, query, focusGroup: selectedCluster });
    renderSidebar();
  };
  root.addEventListener("click", click); root.addEventListener("keydown", keydown); root.addEventListener("focusin", focusin);
  root.querySelector("input")!.addEventListener("input", input);
  render();
  root.querySelector<HTMLInputElement>("input")!.value = query;
  sidebar.scrollTop = previous?.sidebarScroll || 0;
  const resize = new ResizeObserver(() => { field?.resize(); });
  resize.observe(stage);
  return () => {
    const camera = field?.getCamera();
    options.onLeave?.({
      selectedNode,
      clusterCore: selectedCluster === null ? null : clusters[selectedCluster].core,
      query, scale: camera?.scale ?? scale, panX: camera?.panX ?? panX, panY: camera?.panY ?? panY,
      sidebarScroll: sidebar.scrollTop,
    });
    resize.disconnect();
    field?.destroy();
    root.removeEventListener("click", click); root.removeEventListener("keydown", keydown); root.removeEventListener("focusin", focusin);
    root.querySelector("input")?.removeEventListener("input", input);
  };
}

