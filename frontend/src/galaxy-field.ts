/**
 * Nebula field for the live Galaxy. Layout uses the snapshot's real groups
 * and explicit links. Brightness is undirected degree, not importance.
 */

export interface FieldCluster {
  id: number;
  core: string;
  members: string[];
  isolated: boolean;
  curated: boolean;
  label?: string;
}

export interface FieldModel {
  stars: FieldStar[];
  edges: { a: number; b: number; bridge: boolean; len: number }[];
  maxDegree: number;
}

export interface FieldStar {
  id: string;
  title: string;
  x: number;
  y: number;
  z: number;
  degree: number;
  hue: number;
  isolated: boolean;
  core: boolean;
  curated: boolean;
  groupLabel: string;
  groupId: number;
}

interface Point { x: number; y: number; z: number }

function paintedTitle(title: string) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const parts = [...segmenter.segment(title)].map(part => part.segment);
  if (parts.length <= 25) return title;
  return `${parts.slice(0, 25).join("")}…`;
}

function hashUnit(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const PALETTE: [number, number, number][] = [
  [72, 210, 214],
  [176, 146, 255],
  [242, 186, 96],
  [255, 128, 168],
  [126, 170, 255],
  [138, 214, 156],
  [255, 150, 102],
  [196, 150, 236],
  [104, 206, 186],
];

function localPositions(ids: string[], degree: Map<string, number>, links: [string, string][]) {
  const maxDegree = Math.max(1, ...ids.map(id => degree.get(id) || 0));
  const spread = 18 + Math.sqrt(ids.length) * 6.2;
  const pos = new Map<string, Point>();
  // A filled disk, not a ring: area-uniform radius, angle from the page id,
  // and a strong inward bias for pages with more explicit links.
  ids.forEach(id => {
    const weight = (degree.get(id) || 0) / maxDegree;
    const angle = hashUnit(id) * Math.PI * 2;
    const disk = Math.sqrt(hashUnit(`${id}#`));
    const radius = spread * (0.05 + 0.95 * disk * (1 - 0.82 * weight));
    pos.set(id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      z: (hashUnit(`${id}z`) - 0.5) * spread * 0.28 * (1.08 - 0.7 * weight),
    });
  });
  const neighbors = new Map<string, string[]>(ids.map(id => [id, []]));
  links.forEach(([a, b]) => {
    if (a !== b && neighbors.has(a) && neighbors.has(b)) {
      neighbors.get(a)!.push(b);
      neighbors.get(b)!.push(a);
    }
  });
  const cell = Math.max(8, spread / Math.max(3, Math.sqrt(ids.length)) * 1.35);
  // Bounded for every size. There is no ring shortcut past a node count.
  const iterations = ids.length > 240 ? 24 : 28;
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map<string, string[]>();
    ids.forEach(id => {
      const point = pos.get(id)!;
      const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(id);
      else grid.set(key, [id]);
    });
    const force = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
    ids.forEach(id => {
      const point = pos.get(id)!;
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      let seen = 0;
      for (let ox = -1; ox <= 1 && seen < 22; ox++) {
        for (let oy = -1; oy <= 1 && seen < 22; oy++) {
          const bucket = grid.get(`${cx + ox}:${cy + oy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === id || seen >= 22) continue;
            seen += 1;
            const neighbor = pos.get(other)!;
            let dx = point.x - neighbor.x;
            let dy = point.y - neighbor.y;
            let dist = Math.hypot(dx, dy);
            if (dist < 0.45) { dx = 0.45; dy = 0.05; dist = Math.hypot(dx, dy); }
            const mag = (cell * cell * 0.72) / (dist * dist);
            force.get(id)!.x += dx / dist * mag;
            force.get(id)!.y += dy / dist * mag;
          }
        }
      }
      for (const other of neighbors.get(id)!) {
        const neighbor = pos.get(other)!;
        const dx = neighbor.x - point.x;
        const dy = neighbor.y - point.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const mag = (dist - cell * 0.95) * 0.16;
        force.get(id)!.x += dx / dist * mag;
        force.get(id)!.y += dy / dist * mag;
      }
      const weight = (degree.get(id) || 0) / maxDegree;
      force.get(id)!.x -= point.x * (0.02 + 0.16 * weight);
      force.get(id)!.y -= point.y * (0.02 + 0.16 * weight);
    });
    ids.forEach(id => {
      const point = pos.get(id)!;
      const push = force.get(id)!;
      let dx = push.x * 0.05;
      let dy = push.y * 0.05;
      const step = Math.hypot(dx, dy);
      const cap = cell * 0.42;
      if (step > cap) { dx = dx / step * cap; dy = dy / step * cap; }
      point.x += dx;
      point.y += dy;
    });
  }
  return pos;
}

export function layoutGalaxyField(
  nodes: { id: string; title: string }[],
  edges: { source: string; target: string }[],
  clusters: FieldCluster[],
  adjacency: Map<string, Set<string>>,
): FieldModel {
  edges = [...edges].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
  const degree = new Map(nodes.map(node => [node.id, adjacency.get(node.id)?.size || 0]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const locals = new Map<number, Map<string, Point>>();
  const radii = new Map<number, number>();
  clusters.forEach(cluster => {
    if (cluster.isolated) return;
    const pairs = edges
      .filter(edge => cluster.members.includes(edge.source) && cluster.members.includes(edge.target) && edge.source !== edge.target)
      .map(edge => [edge.source, edge.target] as [string, string]);
    const pos = localPositions(cluster.members, degree, pairs);
    locals.set(cluster.id, pos);
    let extent = 12;
    pos.forEach(point => { extent = Math.max(extent, Math.hypot(point.x, point.y)); });
    radii.set(cluster.id, extent);
  });
  const clouds = clusters.filter(cluster => !cluster.isolated);
  const center = new Map<number, Point>();
  const ordered = [...clouds].sort((a, b) => (radii.get(b.id) || 0) - (radii.get(a.id) || 0) || a.id - b.id);
  const bridgeCount = new Map<string, number>();
  const owner = new Map<string, number>();
  clusters.forEach(cluster => cluster.members.forEach(id => owner.set(id, cluster.id)));
  edges.forEach(edge => {
    const a = owner.get(edge.source);
    const b = owner.get(edge.target);
    if (a === undefined || b === undefined || a === b) return;
    const left = clusters.find(cluster => cluster.id === a);
    const right = clusters.find(cluster => cluster.id === b);
    if (!left || !right || left.isolated || right.isolated) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    bridgeCount.set(key, (bridgeCount.get(key) || 0) + 1);
  });
  // Largest cloud stays central. The others sit on a golden spiral just
  // outside it, then a bounded push keeps their disks from stacking.
  ordered.forEach((cluster, index) => {
    if (index === 0) {
      center.set(cluster.id, { x: 0, y: 0, z: 0 });
      return;
    }
    const angle = index * 2.399963229728653;
    const dist = (radii.get(ordered[0].id) || 20) * 0.35 + (radii.get(cluster.id) || 12) + index * 18;
    center.set(cluster.id, {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist * 0.78,
      z: ((index % 5) - 2) * 10,
    });
  });
  for (let iter = 0; iter < 24; iter++) {
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i].id;
        const b = ordered[j].id;
        const pa = center.get(a)!;
        const pb = center.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const linked = bridgeCount.get(key) || 0;
        const minDist = ((radii.get(a) || 12) + (radii.get(b) || 12)) * (linked ? 0.78 : 1.05);
        if (dist >= minDist) continue;
        const push = (minDist - dist) * 0.5;
        const ux = dx / dist;
        const uy = dy / dist;
        pa.x += ux * push;
        pa.y += uy * push;
        pb.x -= ux * push;
        pb.y -= uy * push;
      }
    }
  }
  const stars: FieldStar[] = [];
  const indexOf = new Map<string, number>();
  nodes.forEach(node => {
    const cluster = clusters.find(item => item.members.includes(node.id));
    if (!cluster) return;
    const local = locals.get(cluster.id)?.get(node.id);
    const origin = center.get(cluster.id);
    indexOf.set(node.id, stars.length);
    stars.push({
      id: node.id,
      title: byId.get(node.id)?.title || node.id,
      x: origin && local ? origin.x + local.x : 0,
      y: origin && local ? origin.y + local.y : 0,
      z: local?.z || 0,
      degree: degree.get(node.id) || 0,
      hue: cluster.isolated ? 9 : cluster.id % PALETTE.length,
      isolated: cluster.isolated,
      core: !cluster.isolated && node.id === cluster.core,
      curated: cluster.curated,
      groupLabel: cluster.label || byId.get(cluster.core)?.title || cluster.core,
      groupId: cluster.id,
    });
  });
  let cx = 0;
  let cy = 0;
  let linked = 0;
  stars.forEach(star => {
    if (star.isolated) return;
    cx += star.x; cy += star.y; linked += 1;
  });
  if (linked) { cx /= linked; cy /= linked; }
  let radius = 1;
  stars.forEach(star => {
    if (star.isolated) return;
    star.x -= cx; star.y -= cy;
    radius = Math.max(radius, Math.hypot(star.x, star.y));
  });
  const scale = 100 / radius;
  stars.forEach(star => {
    if (star.isolated) return;
    star.x *= scale; star.y *= scale; star.z *= scale;
  });
  const loose = stars.filter(star => star.isolated);
  loose.forEach((star, index) => {
    const angle = index * 2.399963229728653 + 0.35;
    const dist = 122 + (index % 5) * 7;
    star.x = Math.cos(angle) * dist;
    star.y = Math.sin(angle) * dist * 0.8;
    star.z = ((index % 7) - 3) * 3.5;
  });
  const drawn = edges.flatMap(edge => {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    return [{ a, b, bridge: stars[a].groupId !== stars[b].groupId, len: Math.hypot(stars[a].x - stars[b].x, stars[a].y - stars[b].y) }];
  });
  return { stars, edges: drawn, maxDegree: stars.reduce((max, star) => Math.max(max, star.degree), 1) };
}

interface Camera { yaw: number; pitch: number; distance: number; panX: number; panY: number; focal: number }
interface Shot { x: number; y: number; depth: number; s: number }

export interface GalaxyField {
  paint(): void;
  resize(): void;
  setCamera(camera: { scale: number; panX: number; panY: number }): void;
  getCamera(): { scale: number; panX: number; panY: number };
  setView(view: { selected: string | null; query: string; focusGroup: number | null }): void;
  zoomBy(factor: number, clientX?: number, clientY?: number): void;
  reset(): void;
  nearest(id: string, direction: { x: number; y: number }): string | null;
  reveal(id: string): void;
  destroy(): void;
}

export function mountGalaxyField(host: HTMLElement, model: FieldModel, options: { reducedMotion: boolean; onSelect: (id: string) => void }): GalaxyField {
  host.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const stars = document.createElement("div");
  stars.className = "galaxy-stars";
  const labels = document.createElement("div");
  labels.className = "galaxy-labels";
  labels.setAttribute("aria-hidden", "true");
  host.append(canvas, stars, labels);
  host.dataset.reducedMotion = options.reducedMotion ? "1" : "0";
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const sprites = [...PALETTE, [168, 176, 196] as [number, number, number]].map(tint);
  const home: Camera = { yaw: 0.22, pitch: 0.18, distance: 260, panX: 0, panY: 0, focal: 480 };
  const cam: Camera = { ...home };
  let homeDistance = 260;
  let homePanX = 0;
  let homePanY = 0;
  let fitted = false;
  let pendingScale = 1;
  let pendingPanX = 0;
  let pendingPanY = 0;
  let selected: string | null = null;
  let query = "";
  let focusGroup: number | null = null;
  const shots = new Map<string, Shot>();
  const buttons = new Map<string, HTMLButtonElement>();
  model.stars.forEach(star => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `galaxy-star${star.core ? " is-core" : ""}`;
    button.dataset.node = star.id;
    button.title = star.title;
    button.dataset.x = star.x.toFixed(3);
    button.dataset.y = star.y.toFixed(3);
    button.setAttribute("aria-label", `${star.title}, ${star.core ? "core, " : ""}${star.degree} explicit link${star.degree === 1 ? "" : "s"}`);
    button.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space plus = -");
    button.tabIndex = -1;
    stars.append(button);
    buttons.set(star.id, button);
  });

  const project = (star: FieldStar, shot = cam): Shot => {
    const cy = Math.cos(shot.yaw);
    const sy = Math.sin(shot.yaw);
    const x1 = star.x * cy - star.z * sy;
    const z1 = star.x * sy + star.z * cy;
    const cp = Math.cos(shot.pitch);
    const sp = Math.sin(shot.pitch);
    const y1 = star.y * cp - z1 * sp;
    const z2 = star.y * sp + z1 * cp;
    const depth = Math.max(32, shot.distance - z2);
    const s = shot.focal / depth;
    return { x: host.clientWidth / 2 + x1 * s + shot.panX, y: host.clientHeight / 2 + y1 * s + shot.panY, depth, s };
  };

  const fit = () => {
    if (!host.clientWidth || !host.clientHeight) return;
    const probe = { ...cam, panX: 0, panY: 0, distance: 100 };
    let reach = 1;
    model.stars.forEach(star => {
      const point = project(star, probe);
      reach = Math.max(reach, Math.hypot(point.x - host.clientWidth / 2, point.y - host.clientHeight / 2));
    });
    const want = Math.min(host.clientWidth, host.clientHeight) * (host.clientWidth < 700 ? 0.5 : 0.58);
    homeDistance = 100 * (reach / Math.max(40, want));
    if (!fitted) {
      fitted = true;
      let distance = homeDistance / Math.max(0.75, Math.min(4, pendingScale));
      let panX = pendingPanX;
      let panY = pendingPanY;
      if (!pendingPanX && !pendingPanY) {
        const margin = 36;
        for (let attempt = 0; attempt < 8; attempt++) {
          const shot = { ...cam, distance, panX: 0, panY: 0 };
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          model.stars.forEach(star => {
            if (star.isolated) return;
            const point = project(star, shot);
            minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
          });
          const spanX = Math.max(1, maxX - minX);
          const spanY = Math.max(1, maxY - minY);
          const roomX = Math.max(80, host.clientWidth - margin * 2);
          const roomY = Math.max(80, host.clientHeight - margin * 2);
          if (spanX > roomX || spanY > roomY) {
            distance *= Math.max(spanX / roomX, spanY / roomY) * 1.05;
            continue;
          }
          panX = (host.clientWidth - minX - maxX) / 2;
          panY = (host.clientHeight - minY - maxY) / 2;
          break;
        }
        homeDistance = distance * Math.max(0.75, Math.min(4, pendingScale));
      }
      cam.distance = distance;
      cam.panX = panX;
      cam.panY = panY;
      homePanX = panX;
      homePanY = panY;
    }
    home.distance = homeDistance;
  };
  const groups = new Map<number, FieldStar[]>();
  model.stars.forEach(star => {
    if (star.isolated) return;
    const list = groups.get(star.groupId);
    if (list) list.push(star);
    else groups.set(star.groupId, [star]);
  });

  const paint = () => {
    fit();
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const backdrop = ctx.createRadialGradient(width * 0.5, height * 0.42, 10, width * 0.5, height * 0.55, Math.max(width, height) * 0.75);
    backdrop.addColorStop(0, "#1a2144");
    backdrop.addColorStop(0.5, "#101426");
    backdrop.addColorStop(1, "#070a14");
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);
    model.stars.forEach(star => shots.set(star.id, project(star)));
    const closeness = homeDistance / cam.distance;
    ctx.globalCompositeOperation = "lighter";
    groups.forEach(members => {
      let sx = 0;
      let sy = 0;
      members.forEach(star => { const p = shots.get(star.id)!; sx += p.x; sy += p.y; });
      sx /= members.length; sy /= members.length;
      let radius = 36;
      members.forEach(star => { radius = Math.max(radius, Math.hypot(shots.get(star.id)!.x - sx, shots.get(star.id)!.y - sy)); });
      radius *= 1.38;
      const rgb = PALETTE[members[0].hue] || PALETTE[0];
      const focused = focusGroup === null || members[0].groupId === focusGroup;
      ctx.save();
      ctx.globalAlpha = focused ? 1 : 0.78;
      ctx.translate(sx, sy);
      if (!members[0].curated) ctx.scale(1.22, 0.78);
      blob(ctx, 0, 0, radius, rgb, 0.32);
      blob(ctx, radius * 0.18, -radius * 0.1, radius * 0.58, rgb, 0.36);
      ctx.restore();
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const internal = Math.max(0.05, Math.min(0.42, 0.05 * closeness));
    const bridge = Math.max(0.16, Math.min(0.72, 0.18 + closeness * 0.08));
    const maxScreen = 18 + closeness * 26;
    const internalEdges = model.edges.filter(edge => !edge.bridge).length;
    const crowded = internalEdges > model.stars.length * 4;
    const filamentBudget = crowded ? Math.round(16 + closeness * 20) : Math.round(70 + closeness * 90);
    const bridgeBudget = Math.round(24 + closeness * 36);
    ctx.lineWidth = Math.max(0.55, Math.min(1.35, 0.55 * Math.sqrt(closeness)));
    const filaments: { x1: number; y1: number; x2: number; y2: number; screen: number }[] = [];
    const chords: { x1: number; y1: number; x2: number; y2: number; screen: number }[] = [];
    model.edges.forEach(edge => {
      const a = shots.get(model.stars[edge.a].id)!;
      const b = shots.get(model.stars[edge.b].id)!;
      const screen = Math.hypot(a.x - b.x, a.y - b.y);
      if (screen < 3) return;
      const row = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, screen };
      if (edge.bridge) {
        if (screen > 70 + closeness * 80 && closeness < 1.4) return;
        chords.push(row);
        return;
      }
      const hubby = model.stars[edge.a].degree > 12 || model.stars[edge.b].degree > 12;
      if (hubby && closeness < 1.75) return;
      if (screen > maxScreen) return;
      filaments.push(row);
    });
    filaments.sort((p, q) => p.screen - q.screen);
    chords.sort((p, q) => p.screen - q.screen);
    ctx.beginPath();
    ctx.strokeStyle = `rgba(186, 210, 230, ${internal})`;
    filaments.slice(0, filamentBudget).forEach(edge => {
      ctx.moveTo(edge.x1, edge.y1);
      ctx.lineTo(edge.x2, edge.y2);
    });
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 214, 176, ${bridge})`;
    chords.slice(0, bridgeBudget).forEach(edge => {
      ctx.moveTo(edge.x1, edge.y1);
      ctx.lineTo(edge.x2, edge.y2);
    });
    ctx.stroke();
    if (selected) {
      ctx.strokeStyle = "rgba(255, 248, 236, 0.92)";
      ctx.lineWidth = 1.45;
      ctx.beginPath();
      const from = shots.get(selected)!;
      model.edges.forEach(edge => {
        const left = model.stars[edge.a].id;
        const right = model.stars[edge.b].id;
        if (left !== selected && right !== selected) return;
        const other = shots.get(left === selected ? right : left)!;
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(other.x, other.y);
      });
      ctx.stroke();
    }
    const homeScale = cam.focal / homeDistance;
    const order = [...model.stars].sort((a, b) => shots.get(b.id)!.depth - shots.get(a.id)!.depth);
    ctx.globalCompositeOperation = "lighter";
    order.forEach(star => {
      const point = shots.get(star.id)!;
      const match = !query || `${star.title} ${star.id}`.toLowerCase().includes(query);
      const related = !selected || star.id === selected || model.edges.some(edge => {
        const left = model.stars[edge.a].id;
        const right = model.stars[edge.b].id;
        return (left === selected && right === star.id) || (right === selected && left === star.id);
      });
      const prominence = Math.pow(star.degree / model.maxDegree, 0.62);
      const relative = Math.max(0.45, Math.min(point.s / homeScale, 5));
      const glow = (star.isolated ? 2.4 : 3.2 + prominence * 28) * relative;
      ctx.globalAlpha = (match ? 1 : 0.07) * (related ? 1 : 0.3) * (star.isolated ? 0.5 : 1);
      const sprite = sprites[star.hue] || sprites[sprites.length - 1];
      ctx.drawImage(sprite, point.x - glow, point.y - glow, glow * 2, glow * 2);
      const button = buttons.get(star.id)!;
      const size = Math.max(28, Math.min(46, glow * 0.7));
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
      button.style.width = `${size}px`;
      button.style.height = `${size}px`;
      button.classList.toggle("is-selected", star.id === selected);
      button.classList.toggle("is-dimmed", !match || (!!selected && !related));
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    const ranked = [...model.stars].sort((a, b) => {
      const priority = (star: FieldStar) => star.id === selected ? 0 : star.core ? 1 : 2;
      return priority(a) - priority(b) || b.degree - a.degree;
    });
    const floor = closeness > 1.65 ? 5 : 8;
    const limit = closeness > 1.65 ? 28 : 8;
    const taken: { x: number; y: number; w: number }[] = [];
    let labeled = 0;
    buttons.forEach(button => { delete button.dataset.label; });
    labels.replaceChildren();
    ranked.forEach(star => {
      if (star.isolated) return;
      if (!star.core && star.id !== selected && (labeled >= limit || star.degree < floor)) return;
      const point = shots.get(star.id)!;
      if (point.x < 8 || point.y < 16 || point.x > width - 8 || point.y > height - 8) return;
      const text = paintedTitle(star.title);
      const textWidth = ctx.measureText(text).width;
      if (taken.some(spot => Math.abs(spot.x - point.x) < (spot.w + textWidth) / 2 + 14 && Math.abs(spot.y - point.y) < 18)) return;
      if (query && !`${star.title} ${star.id}`.toLowerCase().includes(query)) return;
      taken.push({ x: point.x, y: point.y, w: textWidth });
      labeled += 1;
      buttons.get(star.id)!.dataset.label = text;
      const name = document.createElement("span");
      name.className = "galaxy-painted-label";
      name.dataset.node = star.id;
      name.textContent = text;
      name.style.left = `${point.x + 10}px`;
      name.style.top = `${point.y - 12}px`;
      labels.append(name);
    });
    const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.72);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
    host.dataset.zoom = (homeDistance / cam.distance).toFixed(3);
    host.dataset.pan = `${cam.panX.toFixed(1)},${cam.panY.toFixed(1)}`;
  };

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const rect = host.getBoundingClientRect();
    const sx = clientX ?? rect.left + rect.width / 2;
    const sy = clientY ?? rect.top + rect.height / 2;
    const next = Math.max(homeDistance * 0.18, Math.min(homeDistance * 2.6, cam.distance / factor));
    const applied = cam.distance / next;
    const cx = sx - rect.left - host.clientWidth / 2;
    const cy = sy - rect.top - host.clientHeight / 2;
    cam.panX = cx - (cx - cam.panX) * applied;
    cam.panY = cy - (cy - cam.panY) * applied;
    cam.distance = next;
    paint();
  };

  let pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;
  let pinch = 0;
  let suppressClick = false;
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    drag = { x: event.clientX, y: event.clientY, panX: cam.panX, panY: cam.panY, moved: pointers.size > 1 };
  };
  const pointerMove = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const previous = pinch || dist;
      zoomAt(dist / previous, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = dist;
      if (drag) drag.moved = true;
      return;
    }
    pinch = 0;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) {
      drag.moved = true;
      try { host.setPointerCapture(event.pointerId); } catch { /* already released */ }
    }
    cam.panX = drag.panX + dx;
    cam.panY = drag.panY + dy;
    paint();
  };
  const pointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = 0;
    const moved = drag?.moved;
    drag = null;
    if (moved) suppressClick = true;
  };
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0011), event.clientX, event.clientY);
  };
  host.addEventListener("pointerdown", pointerDown);
  host.addEventListener("pointermove", pointerMove);
  host.addEventListener("pointerup", pointerUp);
  host.addEventListener("pointercancel", pointerUp);
  host.addEventListener("click", onClick, true);
  host.addEventListener("wheel", onWheel, { passive: false });
  return {
    paint,
    resize: paint,
    setCamera(camera) {
      pendingScale = Math.max(0.75, Math.min(4, camera.scale || 1));
      pendingPanX = camera.panX;
      pendingPanY = camera.panY;
      if (fitted) {
        cam.distance = homeDistance / pendingScale;
        cam.panX = pendingPanX || homePanX;
        cam.panY = pendingPanY || homePanY;
      }
      paint();
    },
    getCamera: () => ({ scale: homeDistance / cam.distance, panX: cam.panX, panY: cam.panY }),
    setView(view) {
      selected = view.selected;
      query = view.query;
      focusGroup = view.focusGroup;
      paint();
    },
    zoomBy: (factor, x, y) => zoomAt(factor, x, y),
    reset() {
      cam.distance = homeDistance;
      cam.panX = homePanX;
      cam.panY = homePanY;
      cam.yaw = home.yaw;
      paint();
    },
    nearest(id, direction) {
      const origin = shots.get(id);
      if (!origin) return null;
      let best: string | null = null;
      let score = Infinity;
      shots.forEach((point, key) => {
        if (key === id) return;
        const dx = point.x - origin.x;
        const dy = point.y - origin.y;
        const forward = dx * direction.x + dy * direction.y;
        if (forward <= 4) return;
        const lateral = Math.abs(dx * direction.y - dy * direction.x);
        const next = forward + lateral * 1.6;
        if (next < score) { score = next; best = key; }
      });
      return best;
    },
    reveal(id) {
      const point = shots.get(id);
      if (!point || !host.clientWidth) return;
      const margin = 48;
      cam.panX += Math.max(0, margin - point.x) - Math.max(0, point.x - (host.clientWidth - margin));
      cam.panY += Math.max(0, margin - point.y) - Math.max(0, point.y - (host.clientHeight - margin));
      paint();
    },
    destroy() {
      host.removeEventListener("pointerdown", pointerDown);
      host.removeEventListener("pointermove", pointerMove);
      host.removeEventListener("pointerup", pointerUp);
      host.removeEventListener("pointercancel", pointerUp);
      host.removeEventListener("click", onClick, true);
      host.removeEventListener("wheel", onWheel);
    },
  };
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rgb: [number, number, number], alpha: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`);
  gradient.addColorStop(0.5, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha * 0.28})`);
  gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function tint(rgb: [number, number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.8)`);
  gradient.addColorStop(0.28, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.22)`);
  gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 96, 96);
  return canvas;
}
