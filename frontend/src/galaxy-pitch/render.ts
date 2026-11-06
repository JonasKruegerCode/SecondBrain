import { renderGalaxy, type Graph } from "../galaxy";
import "./pitch.css";
import {
  buildFixture, checkFixture, clusterTitle, crossEdges, directed, internalEdges, kindLabel, relationLabel,
  type PitchCluster, type PitchEdge,
} from "./example";

type PitchView = "current" | "field" | "stage" | "lens";
type ThemeName = "light" | "dark";

const WORLD_W = 1200;
const WORLD_H = 780;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

interface PitchState {
  view: PitchView;
  theme: ThemeName;
  density: boolean;
  query: string;
  curated: boolean;
  topology: boolean;
  unlinked: boolean;
  selected: string | null;
  focusKey: string | null;
  bridge: string | null;
  zoom: number;
  panX: number;
  panY: number;
  userAdjusted: boolean;
  fieldReady: boolean;
  status: string;
}

export function renderGalaxyPitch(main: HTMLElement): () => void {
  const state: PitchState = {
    view: "current",
    theme: "light",
    density: false,
    query: "",
    curated: true,
    topology: true,
    unlinked: true,
    selected: null,
    focusKey: null,
    bridge: null,
    zoom: 0.72,
    panX: 24,
    panY: 16,
    userAdjusted: false,
    fieldReady: false,
    status: "Example fixture ready. Nothing here is read from your wiki.",
  };
  let fixture = buildFixture(false);
  let stopGalaxy: (() => void) | undefined;
  const root = document.createElement("section");
  root.className = "gp";
  root.dataset.theme = "light";
  root.innerHTML = `<p class="gp-live sr-only" aria-live="polite"></p><div class="gp-body"></div>`;
  main.replaceChildren(root);
  const body = root.querySelector<HTMLElement>(".gp-body")!;
  const live = root.querySelector<HTMLElement>(".gp-live")!;

  const refreshFixture = () => {
    fixture = buildFixture(state.density);
    const problems = checkFixture(fixture);
    if (problems.length) state.status = `Example fixture failed its own checks: ${problems.join(", ")}.`;
  };
  const query = () => state.query.trim().toLowerCase();
  const pageMatch = (id: string, q = query()) => {
    if (!q) return true;
    const node = fixture.byId.get(id);
    return !!node && `${node.title} ${id}`.toLowerCase().includes(q);
  };
  const kindOn = (cluster: PitchCluster) => cluster.curated ? state.curated : cluster.isolated ? state.unlinked : state.topology;
  const clusterMatch = (cluster: PitchCluster, q = query()) => !q || clusterTitle(cluster, fixture.byId).toLowerCase().includes(q) || cluster.members.some(id => pageMatch(id, q));
  const visibleClusters = () => fixture.clusters.filter(cluster => kindOn(cluster) && clusterMatch(cluster));
  const toneOf = (cluster: PitchCluster) => {
    if (cluster.isolated) return "shelf";
    if (!cluster.curated) return "topo";
    return String(fixture.clusters.filter(item => item.curated).findIndex(item => item.id === cluster.id) % 3);
  };
  const bridgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const say = (message: string) => { state.status = message; if (live.textContent !== message) live.textContent = message; };
  const titleOf = (id: string) => fixture.byId.get(id)?.title || id;

  const sanitize = () => {
    if (state.selected && !fixture.byId.has(state.selected)) state.selected = null;
    const selectedCluster = state.selected ? fixture.membership.get(state.selected) : undefined;
    if (selectedCluster && !kindOn(selectedCluster)) state.selected = null;
    if (state.focusKey && !fixture.clusters.some(cluster => cluster.key === state.focusKey && kindOn(cluster))) state.focusKey = null;
    if (state.bridge) {
      const [left, right] = state.bridge.split(":").map(Number);
      const a = fixture.clusters.find(cluster => cluster.id === left);
      const b = fixture.clusters.find(cluster => cluster.id === right);
      if (!a || !b || !kindOn(a) || !kindOn(b)) state.bridge = null;
    }
  };

  const edgeButton = (edge: PitchEdge, emphasize: "source" | "target") => {
    const id = emphasize === "source" ? edge.source : edge.target;
    const other = emphasize === "source" ? edge.target : edge.source;
    const cluster = fixture.membership.get(other);
    const where = cluster ? `${clusterTitle(cluster, fixture.byId)} · ${kindLabel(cluster)}` : "outside this snapshot";
    return `<button type="button" data-select="${esc(id)}" ${state.selected === id ? 'aria-pressed="true"' : ""}><span>${esc(titleOf(edge.source))} → ${esc(titleOf(edge.target))}</span><small>${esc(relationLabel(edge))} · ${esc(where)}</small></button>`;
  };

  const pageDetail = (id: string) => {
    const node = fixture.byId.get(id);
    const cluster = fixture.membership.get(id);
    if (!node || !cluster) return "";
    const outgoing = directed(fixture, id, "out");
    const incoming = directed(fixture, id, "in");
    const peers = cluster.members.filter(member => member !== id && !fixture.neighbors.get(id)!.has(member));
    const peerNames = peers.slice(0, 4).map(peer => esc(titleOf(peer))).join(", ");
    const kind = cluster.curated
      ? "Membership comes from galaxy_group frontmatter. It is not a similarity score and not a link."
      : cluster.isolated
        ? "This page has no explicit link in the example snapshot, so it stays on the shelf."
        : "This neighborhood is derived from explicit links. The frame is a navigation aid, not a curated topic.";
    const hiddenBySearch = query() && !pageMatch(id) ? `<p>The index is filtered. This page stays open so its links remain readable.</p>` : "";
    return `${hiddenBySearch}<p class="gp-kindline">${esc(kindLabel(cluster))}</p><h2>${esc(node.title)}</h2><code>${esc(node.id)}</code><p>${esc(clusterTitle(cluster, fixture.byId))}. ${esc(kind)} ${node.id === cluster.core ? "This page is the core: a curated anchor, or the topology rule’s local hub." : ""}</p><p>${fixture.neighbors.get(id)!.size} pages share an explicit link with this one, in either direction.</p><h3>Outgoing</h3>${outgoing.length ? `<ul class="gp-linklist">${outgoing.map(edge => `<li>${edgeButton(edge, "target")}</li>`).join("")}</ul>` : "<p>No outgoing explicit link.</p>"}<h3>Incoming</h3>${incoming.length ? `<ul class="gp-linklist">${incoming.map(edge => `<li>${edgeButton(edge, "source")}</li>`).join("")}</ul>` : "<p>No incoming explicit link.</p>"}${peers.length ? `<h3>Same group, no explicit link</h3><p>${peerNames}${peers.length > 4 ? ` and ${peers.length - 4} more` : ""}. These names are listed, not connected, because the snapshot has no Markdown link.</p>` : ""}<p>Article text is not part of this example.</p>`;
  };

  const bridgeDetail = (key: string) => {
    const [left, right] = key.split(":").map(Number);
    const a = fixture.clusters.find(cluster => cluster.id === left);
    const b = fixture.clusters.find(cluster => cluster.id === right);
    if (!a || !b) return "";
    const edges = crossEdges(fixture, a, b);
    return `<h2>Links between groups</h2><p>${edges.length} directed explicit link${edges.length === 1 ? "" : "s"} between pages in ${esc(clusterTitle(a, fixture.byId))} and ${esc(clusterTitle(b, fixture.byId))}. The count is not an edge between the two cores, and it is not a similarity.</p><ul class="gp-linklist">${edges.map(edge => `<li>${edgeButton(edge, "target")}</li>`).join("")}</ul>`;
  };

  const legend = (view: PitchView) => {
    if (view === "current") return "";
    const bridge = view === "field"
      ? `<li><i class="gp-swatch bridge"></i>Dashed count: directed explicit links between groups</li>`
      : `<li><i class="gp-swatch bridge"></i>Bridge chip: opens those explicit links</li>`;
    const lines = view === "lens"
      ? `<li><i class="gp-swatch"></i>Arrow: direction of one explicit link</li>`
      : `<li><i class="gp-swatch"></i>Solid line: one explicit Markdown link</li>${bridge}`;
    return `<ul class="gp-legend">${lines}<li><i class="gp-swatch frame"></i>Curated frame, from frontmatter</li><li><i class="gp-swatch topo"></i>Link neighborhood, from topology</li><li><i class="gp-swatch shelf"></i>Unlinked shelf</li></ul>`;
  };

  const tools = () => {
    const theme = state.view === "current" ? "" : `<button type="button" data-theme="light" aria-pressed="${state.theme === "light"}">Light</button><button type="button" data-theme="dark" aria-pressed="${state.theme === "dark"}">Dark</button>`;
    const filters = state.view === "current" ? "" : `<button type="button" data-kind="curated" aria-pressed="${state.curated}">Curated</button><button type="button" data-kind="topology" aria-pressed="${state.topology}">Neighborhoods</button><button type="button" data-kind="unlinked" aria-pressed="${state.unlinked}">Unlinked</button><input class="gp-search" type="search" value="${esc(state.query)}" placeholder="Title or page ID" aria-label="Find a page in the example" autocomplete="off">`;
    const zoom = state.view === "field" && window.innerWidth >= 860
      ? `<button type="button" data-action="zoom-out" aria-label="Zoom out">−</button><button type="button" data-action="zoom-in" aria-label="Zoom in">+</button><button type="button" data-action="fit">Fit</button>`
      : "";
    return `<div class="gp-tools">${theme}<button type="button" data-density aria-pressed="${state.density}">${state.density ? "Density preview on" : "Density preview"}</button>${filters}${zoom}</div>`;
  };

  const chrome = (copy: string) => `<p class="gp-banner"><strong>Example fixture.</strong> Page names, links and counts describe only this fictional snapshot. They are not your wiki and not live measurements.${state.density ? " Density preview adds 36 fictional pages named Example plot to Garden year. Four have an explicit link; the other 32 belong only by frontmatter." : ""}</p><div class="gp-intro"><p class="gp-kicker">DESIGN PROTOTYPE · /galaxy-pitch</p><h1>Three ways to read the galaxy</h1><p>${copy}</p></div><div class="gp-tabs" role="tablist" aria-label="Galaxy directions"><button type="button" role="tab" data-view="current" aria-selected="${state.view === "current"}">Current</button><button type="button" role="tab" data-view="field" aria-selected="${state.view === "field"}">Glass field</button><button type="button" role="tab" data-view="stage" aria-selected="${state.view === "stage"}">Constellation stage</button><button type="button" role="tab" data-view="lens" aria-selected="${state.view === "lens"}">Reading lens</button></div>${tools()}`;

  const memberButtons = (ids: string[]) => {
    const q = query();
    const shown = ids.filter(id => pageMatch(id, q) || !q);
    const hidden = ids.length - shown.length;
    return `${shown.map(id => {
      const cluster = fixture.membership.get(id)!;
      return `<li><button type="button" data-select="${esc(id)}" aria-pressed="${state.selected === id}"><span>${esc(titleOf(id))}${id === cluster.core ? " · core" : ""}</span><small>${fixture.neighbors.get(id)!.size} explicit neighbor${fixture.neighbors.get(id)!.size === 1 ? "" : "s"} · ${esc(id)}</small></button></li>`;
    }).join("")}${hidden ? `<li><p>${hidden} hidden by search.</p></li>` : ""}`;
  };

  const fieldHtml = () => {
    const compact = window.innerWidth < 860;
    const focus = fixture.clusters.find(cluster => cluster.key === state.focusKey && !cluster.isolated) || null;
    const inspector = `<aside class="gp-inspector" aria-label="Details">${state.bridge ? bridgeDetail(state.bridge) : state.selected ? pageDetail(state.selected) : focus ? `<button type="button" class="gp-back" data-action="overview">← All constellations</button><h2>${esc(clusterTitle(focus, fixture.byId))}</h2><p>${esc(kindLabel(focus))}. ${focus.curated ? "Opening this frame shows pages. A line appears only for an explicit link." : "Core chosen by the link-topology rule. A page linked to almost the whole component stays an ordinary member when it can."}</p><p>${internalEdges(fixture, focus).length} explicit links stay inside. ${fixture.edges.filter(edge => { const s = fixture.membership.get(edge.source); const t = fixture.membership.get(edge.target); return s && t && ((s.id === focus.id) !== (t.id === focus.id)); }).length} directed links cross the frame.</p><ul class="gp-memberlist">${memberButtons(focus.members)}</ul>` : `<h2>Overview</h2><p>Each frame is a navigation group. Open one to read its pages. Dashed labels count explicit links between groups.</p>`}</aside>`;
    if (compact) {
      const items = visibleClusters().filter(cluster => !cluster.isolated).map(cluster => `<button type="button" class="gp-flow-item" data-tone="${toneOf(cluster)}" data-focus="${esc(cluster.key)}" aria-pressed="${state.focusKey === cluster.key}"><small>${esc(kindLabel(cluster))}</small><strong>${esc(clusterTitle(cluster, fixture.byId))}</strong><span>${cluster.members.length} pages · core ${esc(titleOf(cluster.core))}</span></button>`).join("");
      const shelf = visibleClusters().filter(cluster => cluster.isolated);
      return `${legend("field")}<div class="gp-layout"><div class="gp-flow">${items || `<p class="gp-empty">No constellation matches these filters.</p>`}${shelf.length ? `<div class="gp-shelf" style="--z:1"><p>Unlinked shelf</p><div class="gp-shelf-row">${shelf.map(cluster => `<button type="button" data-select="${esc(cluster.core)}">${esc(titleOf(cluster.core))}</button>`).join("")}</div></div>` : ""}<p class="gp-note">On a narrow screen this direction stacks the frames. Pan and zoom stay on a wider display so the labels do not shrink into the map.</p></div>${inspector}</div>`;
    }
    const positions = new Map<string, { x: number; y: number }>();
    let nodes = "";
    let lines = "";
    if (focus) {
      const base = focus.members.length > 12 ? neighborhood(focus) : focus.members;
      const extra = state.selected && focus.members.includes(state.selected) ? [...fixture.neighbors.get(state.selected)!] : [];
      const ids = [...new Set([...base, ...extra])];
      positions.set(focus.core, { x: 600, y: 390 });
      const rest = ids.filter(id => id !== focus.core);
      const radius = 220 + rest.length * 16;
      rest.forEach((id, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(rest.length, 1);
        positions.set(id, { x: 600 + Math.cos(angle) * radius, y: 390 + Math.sin(angle) * radius * 0.92 });
      });
      nodes = [...positions].map(([id, point]) => nodeButton(id, point)).join("");
      lines = linkLines(positions);
    } else {
      const clusters = visibleClusters().filter(cluster => !cluster.isolated);
      const anchors = overviewAnchors(clusters.length);
      clusters.forEach((cluster, index) => positions.set(cluster.key, anchors[index]));
      nodes = clusters.map(cluster => {
        const point = positions.get(cluster.key)!;
        const matches = query() ? cluster.members.filter(id => pageMatch(id)).length : 0;
        return `<button type="button" class="gp-disc${query() && !matches && !clusterTitle(cluster, fixture.byId).toLowerCase().includes(query()) ? " is-dim" : ""}" data-tone="${toneOf(cluster)}" data-focus="${esc(cluster.key)}" style="left:${point.x}px;top:${point.y}px;--z:${state.zoom}"><small>${esc(kindLabel(cluster))}</small><strong>${esc(clusterTitle(cluster, fixture.byId))}</strong><em>Core: ${esc(titleOf(cluster.core))}</em><span>${cluster.members.length} pages${matches ? ` · ${matches} match` : ""}</span></button>`;
      }).join("");
      const pairs = new Map<string, { a: PitchCluster; b: PitchCluster; edges: PitchEdge[] }>();
      for (const edge of fixture.edges) {
        const source = fixture.membership.get(edge.source);
        const target = fixture.membership.get(edge.target);
        if (!source || !target || source.id === target.id || source.isolated || target.isolated) continue;
        if (!positions.has(source.key) || !positions.has(target.key)) continue;
        const key = bridgeKey(source.id, target.id);
        const pair = pairs.get(key) || { a: source, b: target, edges: [] };
        pair.edges.push(edge);
        pairs.set(key, pair);
      }
      lines = [...pairs.values()].map(pair => {
        const a = positions.get(pair.a.key)!;
        const b = positions.get(pair.b.key)!;
        return `<line class="gp-lines is-bridge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${pair.edges.length} explicit links between ${esc(clusterTitle(pair.a, fixture.byId))} and ${esc(clusterTitle(pair.b, fixture.byId))}</title></line>`;
      }).join("");
      nodes += [...pairs.values()].map(pair => {
        const a = positions.get(pair.a.key)!;
        const b = positions.get(pair.b.key)!;
        const toward = pair.a.id < pair.b.id ? 0.42 : 0.58;
        const x = a.x + (b.x - a.x) * toward;
        const y = a.y + (b.y - a.y) * toward;
        return `<button type="button" class="gp-bridge" data-bridge="${bridgeKey(pair.a.id, pair.b.id)}" style="left:${x}px;top:${y}px;--z:${state.zoom}">${pair.edges.length} explicit link${pair.edges.length === 1 ? "" : "s"}</button>`;
      }).join("");
      const shelf = visibleClusters().filter(cluster => cluster.isolated);
      if (shelf.length) nodes += `<div class="gp-shelf" style="left:90px;top:690px;width:1020px;--z:${state.zoom}"><p>Unlinked shelf · no explicit links</p><div class="gp-shelf-row">${shelf.map(cluster => `<button type="button" data-select="${esc(cluster.core)}" aria-pressed="${state.selected === cluster.core}">${esc(titleOf(cluster.core))}</button>`).join("")}</div></div>`;
    }
    const note = focus && focus.members.length > 12 ? `<p class="gp-note">This constellation has ${focus.members.length} pages. The map draws the core and, after a choice, that page’s explicit neighbors. The list keeps every page. Pages without a line are not linked.</p>` : "";
    return `${legend("field")}${note}<div class="gp-layout"><div class="gp-field-viewport" data-fitted="${state.fieldReady}"><div class="gp-world" style="transform:translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})"><svg viewBox="0 0 ${WORLD_W} ${WORLD_H}" aria-hidden="true">${lines}</svg>${nodes}</div></div>${inspector}</div>`;
  };

  const neighborhood = (cluster: PitchCluster) => {
    const ids = new Set<string>([cluster.core]);
    if (state.selected && cluster.members.includes(state.selected)) {
      ids.add(state.selected);
      fixture.neighbors.get(state.selected)!.forEach(id => { if (cluster.members.includes(id)) ids.add(id); });
    }
    return [...ids];
  };

  const nodeButton = (id: string, point: { x: number; y: number }) => {
    const cluster = fixture.membership.get(id)!;
    const selected = state.selected === id;
    const dim = !!state.selected && !selected && !fixture.neighbors.get(state.selected)!.has(id);
    const inThisFrame = cluster.key === state.focusKey;
    const kicker = inThisFrame
      ? (id === cluster.core ? "Core of this frame" : "In this frame")
      : clusterTitle(cluster, fixture.byId);
    return `<button type="button" class="gp-node${inThisFrame && id === cluster.core ? " is-core" : ""}${dim ? " is-dim" : ""}" data-tone="${toneOf(cluster)}" data-select="${esc(id)}" aria-pressed="${selected}" style="left:${point.x}px;top:${point.y}px;--z:${state.zoom}"><small>${esc(kicker)}</small><strong>${esc(titleOf(id))}</strong><em>${fixture.neighbors.get(id)!.size} explicit neighbors</em></button>`;
  };

  const linkLines = (positions: Map<string, { x: number; y: number }>) => fixture.edges.map(edge => {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) return "";
    const cross = fixture.membership.get(edge.source)?.id !== fixture.membership.get(edge.target)?.id;
    const active = state.selected === edge.source || state.selected === edge.target;
    return `<line class="gp-lines${cross ? " is-bridge" : ""}${active ? " is-active" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${esc(titleOf(edge.source))} → ${esc(titleOf(edge.target))} (${esc(relationLabel(edge))})</title></line>`;
  }).join("");

  const stageHtml = () => {
    const focus = fixture.clusters.find(cluster => cluster.key === state.focusKey) || null;
    if (focus && !focus.isolated) {
      const ids = focus.members.length > 12 ? neighborhood(focus) : focus.members;
      const placed = ring(ids, focus.core, 640, 520);
      const buttons = [...placed].map(([id, point]) => {
        const dim = !!state.selected && state.selected !== id && !fixture.neighbors.get(state.selected)!.has(id);
        return `<button type="button" class="gp-abs${dim ? " is-dim" : ""}" data-select="${esc(id)}" aria-pressed="${state.selected === id}" style="left:${point.x / 640 * 100}%;top:${point.y / 520 * 100}%"><strong>${esc(titleOf(id))}</strong><small>${id === focus.core ? "Core · " : ""}${fixture.neighbors.get(id)!.size} neighbors</small></button>`;
      }).join("");
      const lines = [...placed.keys()].flatMap(source => directed(fixture, source, "out").map(edge => {
        const a = placed.get(edge.source);
        const b = placed.get(edge.target);
        if (!a || !b) return "";
        const active = state.selected === edge.source || state.selected === edge.target;
        const touchesCore = edge.source === focus.core || edge.target === focus.core;
        if (touchesCore) return `<line class="gp-lines${active ? " is-active" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>`;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const vx = midX - 320;
        const vy = midY - 260;
        const length = Math.hypot(vx, vy) || 1;
        const bendX = midX + vx / length * 80;
        const bendY = midY + vy / length * 80;
        return `<path class="gp-lines${active ? " is-active" : ""}" d="M ${a.x} ${a.y} Q ${bendX} ${bendY} ${b.x} ${b.y}"></path>`;
      })).join("");
      const leaving = fixture.edges.filter(edge => {
        const source = fixture.membership.get(edge.source);
        const target = fixture.membership.get(edge.target);
        return source && target && ((source.id === focus.id) !== (target.id === focus.id));
      });
      const leavingHtml = leaving.length
        ? `<ul class="gp-linklist">${leaving.map(edge => `<li>${edgeButton(edge, fixture.membership.get(edge.source)?.id === focus.id ? "target" : "source")}</li>`).join("")}</ul>`
        : "<p>No explicit link leaves this frame.</p>";
      const roomNote = focus.members.length > 12
        ? `Only a subset is drawn: the core, and after a choice that page's explicit neighbors. All ${focus.members.length} pages stay in the list.`
        : "Dimmed pages share the constellation and have no explicit link to the selection.";
      const roomDetail = state.selected
        ? pageDetail(state.selected)
        : `<h2>Choose a page</h2><p>${roomNote}</p><h3>Links that leave this frame</h3>${leavingHtml}`;
      return `${legend("stage")}<div class="gp-room"><div class="gp-room-list"><button type="button" class="gp-back" data-action="overview">← All constellations</button><h2>${esc(clusterTitle(focus, fixture.byId))}</h2><p class="gp-room-copy">${esc(kindLabel(focus))}. ${focus.members.length} pages. Lines inside the room are explicit links only.</p><ul class="gp-memberlist">${memberButtons(focus.members)}</ul></div><div><div class="gp-room-map" data-tone="${toneOf(focus)}"><svg viewBox="0 0 640 520" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>${buttons}</div><div class="gp-inspector">${roomDetail}</div></div></div>`;
    }
    const cards = visibleClusters().filter(cluster => !cluster.isolated).map(cluster => {
      const others = fixture.clusters.filter(other => !other.isolated && other.id !== cluster.id && kindOn(other));
      const chips = others.map(other => {
        const edges = crossEdges(fixture, cluster, other);
        if (!edges.length) return "";
        return `<button type="button" class="gp-chip" data-bridge="${bridgeKey(cluster.id, other.id)}">${edges.length} explicit link${edges.length === 1 ? "" : "s"} with ${esc(clusterTitle(other, fixture.byId))}</button>`;
      }).join("");
      const preview = cluster.members.slice(0, 4);
      return `<article class="gp-stage-card${query() && !clusterMatch(cluster) ? " is-dim" : ""}" data-tone="${toneOf(cluster)}"><p class="gp-kind">${esc(kindLabel(cluster))}</p><h2><button type="button" data-focus="${esc(cluster.key)}">${esc(clusterTitle(cluster, fixture.byId))}</button></h2><p>Core: ${esc(titleOf(cluster.core))}. ${cluster.curated ? "Anchor from frontmatter." : "Local hub from the topology rule."} ${cluster.members.length} pages.</p><ul>${preview.map(id => `<li><button type="button" data-select="${esc(id)}" data-focus="${esc(cluster.key)}">${esc(titleOf(id))}</button></li>`).join("")}${cluster.members.length > 4 ? `<li>${cluster.members.length - 4} more in this frame</li>` : ""}</ul><div class="gp-minirow">${chips || "<span>No explicit link leaves this frame.</span>"}</div></article>`;
    }).join("");
    const shelf = visibleClusters().filter(cluster => cluster.isolated);
    const shelfCard = shelf.length ? `<article class="gp-stage-card gp-shelf-card" data-tone="shelf"><p class="gp-kind">Unlinked shelf</p><h2>No orbit</h2><p>These pages have no explicit link in the example. They are not given a fake constellation.</p><ul>${shelf.map(cluster => `<li><button type="button" data-select="${esc(cluster.core)}">${esc(titleOf(cluster.core))}</button></li>`).join("")}</ul></article>` : "";
    const below = state.bridge ? `<div class="gp-inspector">${bridgeDetail(state.bridge)}</div>` : state.selected ? `<div class="gp-inspector">${pageDetail(state.selected)}</div>` : "";
    return `${legend("stage")}<div class="gp-stage-well"><div class="gp-stage-grid">${cards || `<p class="gp-empty">No constellation matches these filters.</p>`}${shelfCard}</div></div>${below}`;
  };

  const lensHtml = () => {
    const groups = visibleClusters();
    const sections = (["curated", "topology", "unlinked"] as const).map(kind => {
      const clusters = groups.filter(cluster => kind === "curated" ? cluster.curated : kind === "unlinked" ? cluster.isolated : !cluster.curated && !cluster.isolated);
      if (!clusters.length) return "";
      const heading = kind === "curated" ? "Curated constellations" : kind === "topology" ? "Link neighborhoods" : "Unlinked shelf";
      return `<h3>${heading}</h3>${clusters.map(cluster => {
        const open = (state.selected && cluster.members.includes(state.selected)) || (!!query() && cluster.members.some(id => pageMatch(id))) || cluster.members.length <= 6;
        return `<details ${open ? "open" : ""}><summary>${esc(clusterTitle(cluster, fixture.byId))}<span class="gp-kindline">${cluster.members.length} pages · ${esc(kindLabel(cluster))}</span></summary>${cluster.members.filter(id => pageMatch(id)).map(id => `<button type="button" data-select="${esc(id)}" aria-pressed="${state.selected === id}">${esc(titleOf(id))}${id === cluster.core && !cluster.isolated ? " · core" : ""}</button>`).join("")}</details>`;
      }).join("")}`;
    }).join("");
    const selected = state.selected && fixture.byId.has(state.selected) ? state.selected : null;
    const hops = selected ? fixture.edges.filter(edge => edge.source === selected || edge.target === selected).map(edge => {
      const outbound = edge.source === selected;
      const other = outbound ? edge.target : edge.source;
      const cluster = fixture.membership.get(other);
      return `<li><span class="gp-dir" aria-hidden="true">${outbound ? "→" : "←"}</span><button type="button" data-select="${esc(other)}"><strong>${esc(titleOf(other))}</strong><small>${outbound ? "Outgoing" : "Incoming"} · ${esc(relationLabel(edge))}${cluster ? ` · ${esc(clusterTitle(cluster, fixture.byId))}` : ""}</small></button></li>`;
    }).join("") : "";
    const diagram = selected
      ? `<div class="gp-hops"><h2>One hop</h2><p>Only explicit neighbors. The arrow is the link direction. A shared constellation does not add a row.</p><ul>${hops}</ul></div>`
      : `<div class="gp-hops"><p class="gp-empty">Choose a page. This column lists only that page’s explicit links, with direction.</p></div>`;
    return `${legend("lens")}<div class="gp-lens"><div class="gp-lens-col gp-index"><h2>Index</h2>${sections || `<p class="gp-empty">No pages match.</p>`}</div><div class="gp-lens-col gp-read">${selected ? pageDetail(selected) : `<h2>Read a link before you draw it.</h2><p>The index is the overview. Outgoing and incoming lists keep direction and relation. The small diagram never turns a shared group into a line.</p>`}</div><div class="gp-lens-col">${diagram}</div></div>`;
  };

  const paint = () => {
    sanitize();
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    const searchFocused = !!active?.classList.contains("gp-search");
    const caret = active && searchFocused ? active.selectionStart : null;
    root.dataset.theme = state.view === "current" ? "light" : state.theme;
    const copy = state.view === "current"
      ? "The current Galaxy, pointed at the example snapshot. The light page, dark map and light inspector are the split under review."
      : state.view === "field"
        ? "One pannable field. Frames group pages for navigation. Solid lines are explicit links. Dashed counts combine real links between frames."
        : state.view === "stage"
          ? "Constellations as a readable stage. Open a card to see its pages. Chips open the explicit links behind a count."
          : "An index, a directed reading column, and a one-hop diagram. Grouping is a heading, never a line.";
    const view = state.view === "current"
      ? `<p class="gp-note">Theme and filters below belong to the proposals. This tab keeps today’s renderer, including its own search, so the comparison stays honest.</p><div class="gp-current-host"></div>`
      : state.view === "field" ? fieldHtml() : state.view === "stage" ? stageHtml() : lensHtml();
    stopGalaxy?.();
    stopGalaxy = undefined;
    body.innerHTML = `${chrome(copy)}<div class="gp-workspace" data-pitch="${state.view}">${view}</div>`;
    if (state.view === "current") mountCurrent();
    if (searchFocused) {
      const input = body.querySelector<HTMLInputElement>(".gp-search");
      input?.focus();
      if (input && caret !== null) input.setSelectionRange(caret, caret);
    }
    if (live.textContent !== state.status) live.textContent = state.status;
    if (state.view === "field") requestAnimationFrame(ensureFieldFit);
  };

  const mountCurrent = () => {
    const host = body.querySelector<HTMLElement>(".gp-current-host");
    if (!host) return;
    const graph: Graph = {
      nodes: fixture.nodes.map(node => ({ id: node.id, title: node.title, galaxy: node.galaxy })),
      edges: fixture.edges.map(edge => ({ source: edge.source, target: edge.target, type: edge.type, rel: edge.rel })),
      groups: fixture.clusters.map(cluster => ({ id: cluster.id, core: cluster.core, members: [...cluster.members], isolated: cluster.isolated, curated: cluster.curated, label: cluster.label })),
      revision: "example",
      status: "example fixture",
    };
    stopGalaxy = renderGalaxy(host, graph, id => say(`Example fixture: “${titleOf(id)}” has no article body in this prototype.`));
    host.addEventListener("click", event => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor || anchor.dataset.open !== undefined) return;
      event.preventDefault();
      event.stopPropagation();
      say("This prototype does not leave for the live wiki.");
    }, true);
  };

  const ensureFieldFit = () => {
    if (state.view !== "field" || window.innerWidth < 860 || state.fieldReady) return;
    const viewport = body.querySelector<HTMLElement>(".gp-field-viewport");
    if (!viewport?.clientWidth) return;
    const zoom = Math.min(viewport.clientWidth / WORLD_W, viewport.clientHeight / WORLD_H) * 0.94;
    state.zoom = zoom;
    state.panX = (viewport.clientWidth - WORLD_W * zoom) / 2;
    state.panY = (viewport.clientHeight - WORLD_H * zoom) / 2;
    state.fieldReady = true;
    paint();
  };

  const zoomAt = (viewport: HTMLElement, clientX: number, clientY: number, factor: number) => {
    const rect = viewport.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const next = Math.max(0.35, Math.min(2.6, state.zoom * factor));
    const scale = next / state.zoom;
    state.panX = cx - (cx - state.panX) * scale;
    state.panY = cy - (cy - state.panY) * scale;
    state.zoom = next;
    state.userAdjusted = true;
    state.fieldReady = true;
    paint();
  };

  const selectPage = (id: string, focusToo: string | null) => {
    const cluster = fixture.membership.get(id);
    state.selected = id;
    state.bridge = null;
    const nextFocus = focusToo || (state.view !== "lens" && cluster && !cluster.isolated ? cluster.key : state.focusKey);
    if (nextFocus !== state.focusKey) {
      state.focusKey = nextFocus;
      state.fieldReady = false;
      state.userAdjusted = false;
    }
    if (cluster?.isolated && state.view !== "lens") {
      state.focusKey = null;
      state.fieldReady = false;
      state.userAdjusted = false;
    }
    say(`${titleOf(id)}. ${cluster ? kindLabel(cluster) : ""}. ${directed(fixture, id, "out").length} outgoing and ${directed(fixture, id, "in").length} incoming explicit links.`);
    paint();
  };

  let drag: { id: number; x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;
  let suppressClick = false;
  const onPointerDown = (event: PointerEvent) => {
    if (state.view !== "field" || window.innerWidth < 860) return;
    const viewport = (event.target as HTMLElement).closest<HTMLElement>(".gp-field-viewport");
    if (!viewport || (event.target as HTMLElement).closest("button")) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: false };
    viewport.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    state.panX = drag.panX + dx;
    state.panY = drag.panY + dy;
    state.userAdjusted = true;
    const world = body.querySelector<HTMLElement>(".gp-world");
    if (world) world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
  };
  const onWheel = (event: WheelEvent) => {
    const viewport = (event.target as HTMLElement).closest<HTMLElement>(".gp-field-viewport");
    if (!viewport || state.view !== "field" || window.innerWidth < 860) return;
    event.preventDefault();
    zoomAt(viewport, event.clientX, event.clientY, event.deltaY > 0 ? 0.9 : 1.12);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const current = (event.target as HTMLElement).closest<HTMLElement>(".gp-node, .gp-disc, .gp-abs, .gp-flow-item");
    if (!current || !root.contains(current)) return;
    const nodes = [...body.querySelectorAll<HTMLElement>(".gp-node, .gp-disc, .gp-abs, .gp-flow-item")];
    const origin = current.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let score = Infinity;
    for (const node of nodes) {
      if (node === current) continue;
      const box = node.getBoundingClientRect();
      const dx = box.left + box.width / 2 - (origin.left + origin.width / 2);
      const dy = box.top + box.height / 2 - (origin.top + origin.height / 2);
      const forward = event.key === "ArrowLeft" ? -dx : event.key === "ArrowRight" ? dx : event.key === "ArrowUp" ? -dy : dy;
      if (forward < 8) continue;
      const sideways = event.key === "ArrowLeft" || event.key === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
      const next = forward + sideways * 1.4;
      if (next < score) { score = next; best = node; }
    }
    if (best) { event.preventDefault(); best.focus(); }
  };
  const onClick = (event: MouseEvent) => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-view], [data-theme], [data-density], [data-kind], [data-action], [data-focus], [data-select], [data-bridge]");
    if (!target || !root.contains(target)) return;
    if (target.dataset.view) {
      state.view = target.dataset.view as PitchView;
      state.selected = null;
      state.focusKey = null;
      state.bridge = null;
      state.fieldReady = false;
      state.userAdjusted = false;
      say(state.view === "current" ? "Showing the current Galaxy renderer with the example snapshot." : `Showing the ${state.view} prototype.`);
      paint();
      return;
    }
    if (target.dataset.theme) { state.theme = target.dataset.theme as ThemeName; paint(); return; }
    if (target.dataset.density !== undefined) {
      state.density = !state.density;
      refreshFixture();
      state.fieldReady = false;
      say(state.density ? "Density preview is on. 36 fictional Example plot pages joined Garden year." : "Density preview is off. The small example snapshot is restored.");
      paint();
      return;
    }
    if (target.dataset.kind) {
      const kind = target.dataset.kind;
      if (kind === "curated") state.curated = !state.curated;
      if (kind === "topology") state.topology = !state.topology;
      if (kind === "unlinked") state.unlinked = !state.unlinked;
      paint();
      return;
    }
    if (target.dataset.action === "overview") {
      state.focusKey = null;
      state.selected = null;
      state.bridge = null;
      state.fieldReady = false;
      state.userAdjusted = false;
      say("Back at the overview.");
      paint();
      return;
    }
    if (target.dataset.action === "fit" || target.dataset.action === "zoom-in" || target.dataset.action === "zoom-out") {
      const viewport = body.querySelector<HTMLElement>(".gp-field-viewport");
      if (!viewport) return;
      if (target.dataset.action === "fit") { state.fieldReady = false; state.userAdjusted = false; ensureFieldFit(); return; }
      const rect = viewport.getBoundingClientRect();
      zoomAt(viewport, rect.left + rect.width / 2, rect.top + rect.height / 2, target.dataset.action === "zoom-in" ? 1.15 : 0.87);
      return;
    }
    if (target.dataset.bridge) {
      state.bridge = target.dataset.bridge;
      state.selected = null;
      say("Showing the explicit links behind this count.");
      paint();
      return;
    }
    if (target.dataset.select || target.dataset.focus) {
      if (target.dataset.select) selectPage(target.dataset.select, target.dataset.focus || null);
      else {
        state.focusKey = target.dataset.focus || null;
        state.selected = null;
        state.bridge = null;
        state.fieldReady = false;
        state.userAdjusted = false;
        const cluster = fixture.clusters.find(item => item.key === state.focusKey);
        say(cluster ? `${clusterTitle(cluster, fixture.byId)}. ${kindLabel(cluster)}.` : "Overview.");
        paint();
      }
    }
  };
  const onInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (!input.classList.contains("gp-search")) return;
    state.query = input.value;
    paint();
  };
  const onResize = () => { if (state.view === "field") { state.fieldReady = false; paint(); } };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  window.addEventListener("resize", onResize);
  refreshFixture();
  paint();
  return () => {
    stopGalaxy?.();
    window.removeEventListener("resize", onResize);
    root.remove();
  };
}

function overviewAnchors(count: number): { x: number; y: number }[] {
  if (count <= 1) return [{ x: 600, y: 320 }];
  if (count === 2) return [{ x: 380, y: 320 }, { x: 820, y: 320 }];
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return { x: 600 + Math.cos(angle) * 320, y: 320 + Math.sin(angle) * 175 };
  });
}

function ring(ids: string[], core: string, width: number, height: number) {
  const positions = new Map<string, { x: number; y: number }>();
  const rest = ids.filter(id => id !== core);
  const cx = width / 2;
  const cy = height / 2;
  positions.set(core, { x: cx, y: cy });
  const radius = Math.min(width, height) * 0.34;
  rest.forEach((id, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(rest.length, 1);
    positions.set(id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  });
  return positions;
}
