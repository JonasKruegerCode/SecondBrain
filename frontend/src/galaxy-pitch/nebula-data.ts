import type { PitchEdge, PitchNode } from "./example";

export interface SkyStar {
  id: string;
  title: string;
  x: number;
  y: number;
  z: number;
  degree: number;
  groupLabel: string;
  source: "frontmatter" | "link_topology" | "unlinked";
  isolated: boolean;
  core: boolean;
  hue: number;
  out: { to: number; rel?: string }[];
  inn: { to: number; rel?: string }[];
}

export interface SkyEdge {
  a: number;
  b: number;
  bridge: boolean;
  rel?: string;
}

export interface SkyModel {
  stars: SkyStar[];
  edges: SkyEdge[];
  maxDegree: number;
  radius: number;
  counts: { nodes: number; edges: number; curated: number; topology: number; unlinked: number };
}

const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shuffle<T>(items: T[], rng: () => number) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

interface Spec {
  id: string;
  label: string;
  hub: string;
  hubTitle: string;
  count: number;
  curated: boolean;
  words: [string, string][];
}

const specs: Spec[] = [
  { id: "sky-navigation", label: "Sky & navigation", hub: "tide-clock", hubTitle: "Tide clock", count: 118, curated: true, words: [["harbor", "light"], ["star", "compass"], ["moon", "calendar"], ["night", "survey"], ["beacon", "watch"], ["tide", "table"], ["azimuth", "note"], ["reef", "fog"], ["keel", "log"], ["dune", "chart"], ["lantern", "bearing"], ["current", "sketch"]] },
  { id: "archive-practice", label: "Archive practice", hub: "field-notebook", hubTitle: "Field notebook", count: 136, curated: true, words: [["source", "slip"], ["observation", "method"], ["interpretation", "note"], ["oral", "history"], ["margin", "gloss"], ["folio", "index"], ["ink", "trial"], ["witness", "card"], ["shelf", "mark"], ["provenance", "note"], ["reading", "slip"], ["archive", "hour"]] },
  { id: "garden-year", label: "Garden year", hub: "harvest-calendar", hubTitle: "Harvest calendar", count: 102, curated: true, words: [["seed", "ledger"], ["frost", "note"], ["festival", "table"], ["salt", "marsh"], ["row", "plan"], ["compost", "log"], ["blossom", "count"], ["rain", "barrel"], ["hedge", "cut"], ["soil", "sample"], ["orchard", "map"], ["gleaning", "list"]] },
  { id: "coastal-kitchen", label: "Coastal kitchen", hub: "salt-kitchen", hubTitle: "Salt kitchen", count: 78, curated: true, words: [["shell", "broth"], ["kelp", "pan"], ["smoke", "rack"], ["citrus", "salt"], ["tide", "bread"], ["net", "mending"], ["pickle", "crock"], ["ember", "fish"], ["herb", "oil"], ["clay", "pot"]] },
  { id: "story-routes", label: "Story routes", hub: "mira-quill", hubTitle: "Mira Quill", count: 72, curated: true, words: [["lane", "name"], ["ferry", "tale"], ["market", "call"], ["winter", "verse"], ["map", "margin"], ["choir", "note"], ["letter", "fold"], ["harbor", "song"], ["path", "stone"], ["evening", "route"]] },
  { id: "lantern-year", label: "Lantern year", hub: "lantern-festival", hubTitle: "Lantern festival", count: 64, curated: true, words: [["wick", "trim"], ["paper", "float"], ["procession", "order"], ["oil", "measure"], ["spark", "count"], ["gate", "lamp"], ["night", "market"], ["chorus", "cue"], ["banner", "dye"], ["ash", "path"]] },
  { id: "workshop", label: "Workshop", hub: "sharpening-notes", hubTitle: "Sharpening notes", count: 92, curated: false, words: [["workbench", "sketch"], ["tool", "chest"], ["oil", "cloth"], ["clamp", "study"], ["edge", "angle"], ["hone", "log"], ["handle", "wrap"], ["rasp", "note"], ["bit", "drawer"], ["mallet", "face"]] },
  { id: "fiber-loft", label: "Fiber loft", hub: "warp-count", hubTitle: "Warp count", count: 70, curated: false, words: [["weft", "sample"], ["indigo", "vat"], ["loom", "tie"], ["fleece", "sort"], ["spindle", "note"], ["dye", "lot"], ["selvedge", "check"], ["bobbin", "map"], ["carding", "day"], ["tension", "log"]] },
  { id: "glass-room", label: "Glass room", hub: "anneal-log", hubTitle: "Anneal log", count: 48, curated: false, words: [["gather", "weight"], ["marver", "pass"], ["punty", "mark"], ["frit", "tray"], ["kiln", "shelf"], ["color", "bar"], ["crack", "note"], ["pipe", "turn"], ["mold", "line"], ["cullet", "bin"]] },
];

function pagesFor(spec: Spec, rng: () => number): PitchNode[] {
  const nodes: PitchNode[] = [];
  const seen = new Set<string>();
  const push = (id: string, title: string, anchor = false) => {
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({
      id,
      title,
      galaxy: spec.curated ? { group: spec.id, label: spec.label, anchor } : undefined,
    });
  };
  push(spec.hub, spec.hubTitle, true);
  const usedTitles = new Set(nodes.map(node => node.title));
  let n = 1;
  while (nodes.length < spec.count) {
    const pair = spec.words[Math.floor(rng() * spec.words.length)];
    const base = `${pair[0][0].toUpperCase()}${pair[0].slice(1)} ${pair[1]}`;
    let title = base;
    let salt = 2;
    while (usedTitles.has(title)) {
      title = `${base} ${salt}`;
      salt += 1;
    }
    usedTitles.add(title);
    const id = `${spec.id}-${pair[0]}-${pair[1]}-${n}`;
    n += 1;
    push(id, title);
  }
  return nodes;
}

function linkGroup(ids: string[], hub: string, rng: () => number, edges: PitchEdge[]) {
  const seen = new Set<string>();
  const add = (source: string, target: string, rel?: string) => {
    if (source === target) return;
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, type: "wikilink", rel });
  };
  const others = shuffle(ids.filter(id => id !== hub), rng);
  const hubLinks = Math.min(others.length, Math.max(18, Math.round(others.length * 0.24)));
  for (let i = 0; i < hubLinks; i++) add(hub, others[i]);
  others.slice(0, 4).forEach((secondary, index) => {
    const reach = 6 + index;
    for (let k = 0; k < reach; k++) add(secondary, others[Math.floor(rng() * others.length)]);
  });
  for (let i = 0; i < others.length; i++) {
    if (i % 2 === 0) add(others[i], others[(i + 1) % others.length]);
    if (rng() < 0.55) add(others[i], others[Math.floor(rng() * others.length)], rng() < 0.12 ? "see-also" : undefined);
  }
  const parent = new Map(ids.map(id => [id, id]));
  const find = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  edges.forEach(edge => {
    if (ids.includes(edge.source) && ids.includes(edge.target)) unite(edge.source, edge.target);
  });
  const groups = new Map<string, string[]>();
  ids.forEach(id => {
    const root = find(id);
    groups.set(root, [...(groups.get(root) || []), id]);
  });
  const parts = [...groups.values()];
  for (let i = 1; i < parts.length; i++) add(parts[0][0], parts[i][0]);
}

interface Point { x: number; y: number; z: number }

function layoutMembers(ids: string[], degree: Map<string, number>, rng: () => number) {
  const maxDegree = Math.max(1, ...ids.map(id => degree.get(id) || 0));
  const spread = 18 + Math.sqrt(ids.length) * 4.2;
  const pos = new Map<string, Point>();
  ids.forEach((id, index) => {
    const weight = (degree.get(id) || 0) / maxDegree;
    const angle = index * 2.399963229728653;
    const radius = spread * (0.12 + 0.9 * (1 - weight)) * (0.72 + rng() * 0.45);
    pos.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 });
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  const neighbors = ids.map(() => [] as number[]);
  // Filled by caller via edges? We only have degrees here. Attraction needs edges.
  void neighbors;
  void index;
  return { pos, spread, maxDegree };
}

function relax(
  ids: string[],
  pos: Map<string, Point>,
  links: [string, string][],
  degree: Map<string, number>,
  spread: number,
) {
  const maxDegree = Math.max(1, ...ids.map(id => degree.get(id) || 0));
  const at = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
  const linked = new Set(links.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  for (let iter = 0; iter < 56; iter++) {
    ids.forEach(id => at.set(id, { x: 0, y: 0 }));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.35) {
          dx = 0.35;
          dy = (i - j) * 0.01;
          dist = Math.hypot(dx, dy);
        }
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const mag = 34 / (dist * dist) - (linked.has(key) ? 0.075 * dist : 0);
        const ux = dx / dist;
        const uy = dy / dist;
        const fa = at.get(a)!;
        const fb = at.get(b)!;
        fa.x += ux * mag;
        fa.y += uy * mag;
        fb.x -= ux * mag;
        fb.y -= uy * mag;
      }
    }
    ids.forEach(id => {
      const p = pos.get(id)!;
      const pull = 0.012 + 0.16 * ((degree.get(id) || 0) / maxDegree);
      const force = at.get(id)!;
      let dx = (force.x - p.x * pull * 40) * 0.045;
      let dy = (force.y - p.y * pull * 40) * 0.045;
      const step = Math.hypot(dx, dy);
      if (step > 3.2) {
        dx = dx / step * 3.2;
        dy = dy / step * 3.2;
      }
      p.x += dx;
      p.y += dy;
    });
  }
  ids.forEach((id, index) => {
    const p = pos.get(id)!;
    const weight = (degree.get(id) || 0) / maxDegree;
    p.z = Math.sin(index * 1.618 + id.length) * spread * 0.28 * (1.05 - 0.75 * weight);
  });
}

export function buildSky(): SkyModel {
  const nodes: PitchNode[] = [];
  const edges: PitchEdge[] = [];
  const bySpec = new Map<string, string[]>();
  specs.forEach(spec => {
    const group = pagesFor(spec, mulberry32(hash(spec.id)));
    nodes.push(...group);
    const ids = group.map(node => node.id);
    bySpec.set(spec.id, ids);
    linkGroup(ids, spec.hub, mulberry32(hash(`${spec.id}:links`)), edges);
  });
  for (let i = 1; i <= 36; i++) {
    const n = String(i).padStart(2, "0");
    nodes.push({ id: `loose-leaf-${n}`, title: `Loose leaf ${n}` });
  }
  const bridges: [string, string, number][] = [
    ["sky-navigation", "archive-practice", 7],
    ["sky-navigation", "garden-year", 4],
    ["garden-year", "lantern-year", 6],
    ["archive-practice", "story-routes", 5],
    ["coastal-kitchen", "garden-year", 4],
    ["workshop", "archive-practice", 4],
    ["fiber-loft", "lantern-year", 3],
    ["glass-room", "workshop", 4],
    ["story-routes", "lantern-year", 3],
    ["coastal-kitchen", "sky-navigation", 2],
  ];
  const bridgeRng = mulberry32(0x0b61d9e);
  bridges.forEach(([left, right, count]) => {
    const a = bySpec.get(left)!;
    const b = bySpec.get(right)!;
    for (let i = 0; i < count; i++) {
      const source = a[Math.floor(bridgeRng() * Math.min(a.length, 8))];
      const target = b[Math.floor(bridgeRng() * Math.min(b.length, 10))];
      edges.push({ source, target, type: "wikilink", rel: i === 0 ? "see-also" : undefined });
    }
  });
  const unique = new Set<string>();
  const clean = edges.filter(edge => {
    if (edge.source === edge.target) return false;
    const key = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`;
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });
  const clusters: { key: string; label: string; source: SkyStar["source"]; core: string; members: string[]; isolated: boolean; curated: boolean }[] = specs.map(spec => ({
    key: spec.id,
    label: spec.label,
    source: spec.curated ? "frontmatter" as const : "link_topology" as const,
    core: spec.hub,
    members: bySpec.get(spec.id)!,
    isolated: false,
    curated: spec.curated,
  }));
  nodes.filter(node => node.id.startsWith("loose-leaf-")).forEach(node => {
    clusters.push({
      key: node.id,
      label: "Unlinked",
      source: "unlinked",
      core: node.id,
      members: [node.id],
      isolated: true,
      curated: false,
    });
  });
  const degree = new Map<string, number>(nodes.map(node => [node.id, 0]));
  const undirected = new Map<string, Set<string>>(nodes.map(node => [node.id, new Set()]));
  clean.forEach(edge => {
    undirected.get(edge.source)!.add(edge.target);
    undirected.get(edge.target)!.add(edge.source);
  });
  undirected.forEach((set, id) => degree.set(id, set.size));
  const local = new Map<string, Map<string, Point>>();
  const localLinks = new Map<string, [string, string][]>();
  clusters.forEach(cluster => {
    if (cluster.isolated) return;
    const box = layoutMembers(cluster.members, degree, mulberry32(hash(cluster.key)));
    const pairs = clean
      .filter(edge => cluster.members.includes(edge.source) && cluster.members.includes(edge.target))
      .map(edge => [edge.source, edge.target] as [string, string]);
    relax(cluster.members, box.pos, pairs, degree, box.spread);
    local.set(cluster.key, box.pos);
    localLinks.set(cluster.key, pairs);
  });
  const clouds = clusters.filter(cluster => !cluster.isolated);
  const center = new Map<string, Point>();
  const cloudRadius = new Map<string, number>();
  clouds.forEach(cluster => {
    const points = [...local.get(cluster.key)!.values()];
    const rms = Math.sqrt(points.reduce((sum, p) => sum + p.x * p.x + p.y * p.y, 0) / points.length);
    cloudRadius.set(cluster.key, Math.max(12, rms));
    const angle = center.size * 2.399963229728653;
    const ring = 70 + center.size * 6;
    center.set(cluster.key, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring * 0.82, z: 0 });
  });
  const keys = [...center.keys()];
  const bridgeWeight = new Map<string, number>();
  clean.forEach(edge => {
    const left = clusters.find(cluster => cluster.members.includes(edge.source));
    const right = clusters.find(cluster => cluster.members.includes(edge.target));
    if (!left || !right || left.key === right.key || left.isolated || right.isolated) return;
    const key = left.key < right.key ? `${left.key}|${right.key}` : `${right.key}|${left.key}`;
    bridgeWeight.set(key, (bridgeWeight.get(key) || 0) + 1);
  });
  for (let iter = 0; iter < 90; iter++) {
    const force = new Map(keys.map(key => [key, { x: 0, y: 0 }]));
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i];
        const b = keys[j];
        const pa = center.get(a)!;
        const pb = center.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
        const weight = bridgeWeight.get(pair) || 0;
        const desired = (cloudRadius.get(a)! + cloudRadius.get(b)!) * (weight ? 1.55 : 2.65);
        const mag = (dist - desired) * (weight ? 0.035 : 0.02);
        const ux = dx / dist;
        const uy = dy / dist;
        force.get(a)!.x -= ux * mag;
        force.get(a)!.y -= uy * mag;
        force.get(b)!.x += ux * mag;
        force.get(b)!.y += uy * mag;
      }
    }
    keys.forEach(key => {
      const p = center.get(key)!;
      const f = force.get(key)!;
      p.x = (p.x + f.x) * 0.992;
      p.y = (p.y + f.y) * 0.992;
    });
  }
  const stars: SkyStar[] = [];
  const indexOf = new Map<string, number>();
  const hueOf = new Map<string, number>();
  clouds.forEach((cluster, index) => hueOf.set(cluster.key, index % 9));
  const orderedNodes = [...nodes].sort((a, b) => compareId(a.id, b.id));
  orderedNodes.forEach(node => {
    const cluster = clusters.find(item => item.members.includes(node.id))!;
    const localPoint = local.get(cluster.key)?.get(node.id);
    const origin = center.get(cluster.key) || { x: 0, y: 0, z: 0 };
    const point = localPoint
      ? { x: origin.x + localPoint.x, y: origin.y + localPoint.y, z: origin.z + localPoint.z }
      : { x: 0, y: 0, z: 0 };
    indexOf.set(node.id, stars.length);
    stars.push({
      id: node.id,
      title: node.title,
      x: point.x,
      y: point.y,
      z: point.z,
      degree: degree.get(node.id) || 0,
      groupLabel: cluster.label || node.title,
      source: cluster.source,
      isolated: cluster.isolated,
      core: node.id === cluster.core,
      hue: hueOf.get(cluster.key) ?? 8,
      out: [],
      inn: [],
    });
  });
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let linkedCount = 0;
  stars.forEach(star => {
    if (star.isolated) return;
    cx += star.x;
    cy += star.y;
    cz += star.z;
    linkedCount += 1;
  });
  cx /= linkedCount;
  cy /= linkedCount;
  cz /= linkedCount;
  stars.forEach(star => {
    if (star.isolated) return;
    star.x -= cx;
    star.y -= cy;
    star.z -= cz;
  });
  let radius = 1;
  stars.forEach(star => {
    if (!star.isolated) radius = Math.max(radius, Math.hypot(star.x, star.y, star.z));
  });
  const scale = 100 / radius;
  stars.forEach(star => {
    if (star.isolated) return;
    star.x *= scale;
    star.y *= scale;
    star.z *= scale;
  });
  const loose = stars.filter(star => star.isolated);
  loose.forEach((star, index) => {
    const angle = index * 2.399963229728653 + 0.4;
    const dist = 118 + (index % 5) * 6.5;
    star.x = Math.cos(angle) * dist;
    star.y = Math.sin(angle) * dist * 0.78;
    star.z = ((index % 7) - 3) * 4;
    star.groupLabel = "Unlinked";
    star.hue = 9;
  });
  const skyEdges: SkyEdge[] = [];
  clean.forEach(edge => {
    const a = indexOf.get(edge.source)!;
    const b = indexOf.get(edge.target)!;
    const bridge = stars[a].groupLabel !== stars[b].groupLabel || stars[a].isolated || stars[b].isolated;
    skyEdges.push({ a, b, bridge, rel: edge.rel });
    stars[a].out.push({ to: b, rel: edge.rel });
    stars[b].inn.push({ to: a, rel: edge.rel });
  });
  const maxDegree = stars.reduce((max, star) => Math.max(max, star.degree), 0);
  return {
    stars,
    edges: skyEdges,
    maxDegree,
    radius: 100,
    counts: {
      nodes: stars.length,
      edges: skyEdges.length,
      curated: clusters.filter(cluster => cluster.curated).length,
      topology: clusters.filter(cluster => cluster.source === "link_topology").length,
      unlinked: clusters.filter(cluster => cluster.isolated).length,
    },
  };
}
