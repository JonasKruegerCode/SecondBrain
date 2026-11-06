import "./nebula.css";
import { buildSky, type SkyStar } from "./nebula-data";

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
  [168, 176, 196],
];

interface Camera {
  yaw: number;
  pitch: number;
  distance: number;
  panX: number;
  panY: number;
  focal: number;
}

interface Projected {
  x: number;
  y: number;
  s: number;
  depth: number;
}

export function renderNebula(main: HTMLElement): () => void {
  const root = document.createElement("section");
  root.className = "nebula";
  root.innerHTML = `<canvas aria-hidden="true"></canvas><div class="nebula-top"><p class="nebula-flag">Example nebula · fictional graph · not your wiki</p><h1>A cloud of real pages</h1><p class="nebula-quiet">Every point is one example page. Brighter means more explicit links. Color clouds are navigation groups, already open.</p></div><form class="nebula-search" role="search"><input type="search" aria-label="Find an example page" placeholder="Find a page" autocomplete="off"></form><div class="nebula-tools"><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-home aria-label="Reset view">⌂</button></div><a class="nebula-link" href="/galaxy-pitch?drafts=1">Earlier studies</a><aside class="nebula-sheet" aria-label="Selected page"></aside><p class="nebula-live sr-only" aria-live="polite"></p>`;
  main.replaceChildren(root);
  const canvas = root.querySelector("canvas")!;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const flag = root.querySelector(".nebula-flag")!;
  const sheet = root.querySelector<HTMLElement>(".nebula-sheet")!;
  const live = root.querySelector(".nebula-live")!;
  const search = root.querySelector<HTMLInputElement>("input")!;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const started = performance.now();
  const sky = buildSky();
  const layoutMs = performance.now() - started;
  const sprites = PALETTE.map(tintSprite);
  const width = () => canvas.clientWidth || window.innerWidth;
  const height = () => canvas.clientHeight || window.innerHeight;
  const home: Camera = { yaw: 0.42, pitch: 0.52, distance: 280, panX: 0, panY: 0, focal: 520 };
  const cam: Camera = { ...home };
  let homeDistance = 280;
  let selected = -1;
  let query = "";
  let frame = 0;
  let fps = 0;
  let running = true;
  let last = performance.now();
  let lastInput = performance.now();
  let raf = 0;
  const projected: Projected[] = sky.stars.map(() => ({ x: 0, y: 0, s: 1, depth: 1 }));
  const glowSize: number[] = sky.stars.map(() => 2);
  const clouds = new Map<string, number[]>();
  sky.stars.forEach((star, index) => {
    if (star.isolated) return;
    const list = clouds.get(star.groupLabel);
    if (list) list.push(index);
    else clouds.set(star.groupLabel, [index]);
  });

  const project = (star: SkyStar, shot = cam): Projected => {
    const cy = Math.cos(shot.yaw);
    const sy = Math.sin(shot.yaw);
    const x1 = star.x * cy - star.z * sy;
    const z1 = star.x * sy + star.z * cy;
    const cp = Math.cos(shot.pitch);
    const sp = Math.sin(shot.pitch);
    const y1 = star.y * cp - z1 * sp;
    const z2 = star.y * sp + z1 * cp;
    const depth = Math.max(36, shot.distance - z2);
    const s = shot.focal / depth;
    return { x: width() / 2 + x1 * s + shot.panX, y: height() / 2 + y1 * s + shot.panY, s, depth };
  };

  const fit = () => {
    const probe = { ...cam, panX: 0, panY: 0, distance: 100 };
    let maxReach = 1;
    sky.stars.forEach(star => {
      if (star.isolated) return;
      const p = project(star, probe);
      maxReach = Math.max(maxReach, Math.hypot(p.x - width() / 2, p.y - height() / 2));
    });
    const want = Math.min(width(), height()) * (width() < 700 ? 0.46 : 0.58);
    homeDistance = 100 * (maxReach / want);
    home.distance = homeDistance;
    cam.distance = homeDistance;
    cam.panX = 0;
    cam.panY = 0;
    cam.yaw = home.yaw;
  };

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width() * dpr));
    canvas.height = Math.max(1, Math.floor(height() * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const paint = () => {
    const w = width();
    const h = height();
    const backdrop = ctx.createRadialGradient(w * 0.5, h * 0.42, 20, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    backdrop.addColorStop(0, "#1a2040");
    backdrop.addColorStop(0.42, "#101426");
    backdrop.addColorStop(1, "#05060d");
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, w, h);
    const origin = project({ ...sky.stars[0], x: 0, y: 0, z: 0 });
    const coreWash = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, Math.min(w, h) * 0.42);
    coreWash.addColorStop(0, "rgba(126, 146, 210, 0.18)");
    coreWash.addColorStop(1, "rgba(126, 146, 210, 0)");
    ctx.fillStyle = coreWash;
    ctx.fillRect(0, 0, w, h);

    sky.stars.forEach((star, index) => { projected[index] = project(star); });
    const closeness = homeDistance / cam.distance;
    ctx.globalCompositeOperation = "lighter";
    clouds.forEach(members => {
      let sx = 0;
      let sy = 0;
      let reach = 0;
      members.forEach(index => {
        const p = projected[index];
        sx += p.x;
        sy += p.y;
      });
      sx /= members.length;
      sy /= members.length;
      members.forEach(index => {
        const p = projected[index];
        reach = Math.max(reach, Math.hypot(p.x - sx, p.y - sy));
      });
      const radius = Math.max(48, reach * 1.45);
      const rgb = PALETTE[sky.stars[members[0]].hue] || PALETTE[0];
      const elongated = sky.stars[members[0]].source === "link_topology";
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(elongated ? 1.28 : 1, elongated ? 0.78 : 1);
      wash(ctx, 0, 0, radius, rgb, 0.34);
      wash(ctx, radius * 0.2, -radius * 0.14, radius * 0.66, rgb, 0.42);
      wash(ctx, -radius * 0.22, radius * 0.1, radius * 0.48, rgb, 0.2);
      wash(ctx, 0, 0, radius * 0.28, [255, 244, 230], 0.08);
      ctx.restore();
    });

    ctx.globalCompositeOperation = "source-over";
    const internalAlpha = Math.max(0.07, Math.min(0.55, 0.08 * closeness));
    const bridgeAlpha = Math.max(0.22, Math.min(0.8, 0.24 + closeness * 0.06));
    ctx.lineWidth = Math.max(0.6, Math.min(1.6, 0.7 * Math.sqrt(closeness)));
    const buckets = new Map<string, typeof sky.edges>();
    sky.edges.forEach(edge => {
      const key = edge.bridge ? "bridge" : String(sky.stars[edge.a].hue);
      let list = buckets.get(key);
      if (!list) buckets.set(key, list = []);
      list.push(edge);
    });
    buckets.forEach((edges, key) => {
      const rgb = key === "bridge" ? [255, 214, 176] : PALETTE[Number(key)] || PALETTE[9];
      ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${key === "bridge" ? bridgeAlpha : internalAlpha})`;
      ctx.beginPath();
      edges.forEach(edge => {
        const a = projected[edge.a];
        const b = projected[edge.b];
        if (!a || !b) return;
        if ((a.x < -80 && b.x < -80) || (a.x > w + 80 && b.x > w + 80) || (a.y < -80 && b.y < -80) || (a.y > h + 80 && b.y > h + 80)) return;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      });
      ctx.stroke();
    });
    if (selected >= 0) {
      ctx.strokeStyle = "rgba(255, 246, 230, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const from = projected[selected];
      sky.stars[selected].out.forEach(link => {
        const to = projected[link.to];
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
      });
      sky.stars[selected].inn.forEach(link => {
        const to = projected[link.to];
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(from.x, from.y);
      });
      ctx.stroke();
    }

    const order = sky.stars.map((_, index) => index).sort((a, b) => projected[b].depth - projected[a].depth);
    const homeScale = cam.focal / homeDistance;
    ctx.globalCompositeOperation = "lighter";
    order.forEach(index => {
      const star = sky.stars[index];
      const p = projected[index];
      const match = !query || `${star.title} ${star.id}`.toLowerCase().includes(query);
      const related = selected < 0 || index === selected || sky.stars[selected].out.some(link => link.to === index) || sky.stars[selected].inn.some(link => link.to === index);
      const prominence = Math.pow(star.degree / sky.maxDegree, 0.62);
      const relative = (p.s) / homeScale;
      const glow = (star.isolated ? 2.2 : 3.4 + prominence * 30) * Math.max(0.45, Math.min(relative, 5));
      glowSize[index] = glow;
      ctx.globalAlpha = (match ? 1 : 0.08) * (related ? 1 : 0.28) * (star.isolated ? 0.55 : 1);
      const sprite = sprites[star.hue] || sprites[9];
      ctx.drawImage(sprite, p.x - glow, p.y - glow, glow * 2, glow * 2);
    });
    ctx.globalCompositeOperation = "source-over";
    order.forEach(index => {
      const star = sky.stars[index];
      const p = projected[index];
      const match = !query || `${star.title} ${star.id}`.toLowerCase().includes(query);
      const related = selected < 0 || index === selected || sky.stars[selected].out.some(link => link.to === index) || sky.stars[selected].inn.some(link => link.to === index);
      const prominence = Math.pow(star.degree / sky.maxDegree, 0.62);
      const relative = p.s / homeScale;
      const core = (star.isolated ? 0.7 : 0.85 + prominence * 2.5) * Math.sqrt(Math.max(0.4, Math.min(relative, 4)));
      ctx.globalAlpha = (match ? 1 : 0.12) * (related ? 1 : 0.45);
      ctx.fillStyle = prominence > 0.45 ? "#fffaf2" : "#f3f6ff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, core), 0, Math.PI * 2);
      ctx.fill();
      if (prominence > 0.55 && related && match) {
        ctx.globalAlpha *= 0.45;
        ctx.strokeStyle = "#fff6ea";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - core * 4.2, p.y);
        ctx.lineTo(p.x + core * 4.2, p.y);
        ctx.moveTo(p.x, p.y - core * 4.2);
        ctx.lineTo(p.x, p.y + core * 4.2);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
    const ranked = sky.stars.map((star, index) => ({ star, index })).sort((a, b) => b.star.degree - a.star.degree);
    const labelLimit = closeness > 1.7 ? 34 : 10;
    const degreeFloor = closeness > 1.7 ? 6 : 18;
    const taken: { x: number; y: number; w: number }[] = [];
    ctx.font = "600 13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    let labeled = 0;
    ranked.forEach(({ star, index }) => {
      if (labeled >= labelLimit) return;
      if (star.degree < degreeFloor && index !== selected) return;
      if (star.isolated && index !== selected) return;
      const p = projected[index];
      if (p.x < 24 || p.y < 108 || p.x > w - 28 || p.y > h - 72) return;
      const textWidth = ctx.measureText(star.title).width;
      if (taken.some(spot => Math.abs(spot.x - p.x) < (spot.w + textWidth) * 0.5 + 16 && Math.abs(spot.y - p.y) < 20)) return;
      const match = !query || `${star.title} ${star.id}`.toLowerCase().includes(query);
      if (query && !match) return;
      taken.push({ x: p.x, y: p.y, w: textWidth });
      labeled += 1;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(5, 8, 16, 0.88)";
      ctx.strokeText(star.title, p.x + 8, p.y - 10);
      ctx.fillStyle = "#f5f8ff";
      ctx.fillText(star.title, p.x + 8, p.y - 10);
    });

    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  };

  const pick = (x: number, y: number) => {
    let best = -1;
    let score = Infinity;
    projected.forEach((point, index) => {
      const reach = Math.max(18, glowSize[index] * 0.45);
      const dist = Math.hypot(point.x - x, point.y - y);
      if (dist <= reach && dist < score) {
        score = dist;
        best = index;
      }
    });
    return best;
  };

  const showSheet = (index: number) => {
    selected = index;
    if (index < 0) {
      sheet.classList.remove("open");
      sheet.innerHTML = "";
      root.classList.remove("sheet-open");
      return;
    }
    const star = sky.stars[index];
    const kind = star.isolated
      ? "Unlinked. This example page has no explicit link, so it sits outside the clouds."
      : star.source === "frontmatter"
        ? `Curated constellation “${star.groupLabel}”. Membership comes from frontmatter, not from similarity.`
        : `Link neighborhood “${star.groupLabel}”. These pages are tied by explicit links and have no curated name.`;
    const links = [
      ...star.out.map(link => ({ way: "→", other: link.to, rel: link.rel })),
      ...star.inn.map(link => ({ way: "←", other: link.to, rel: link.rel })),
    ].sort((a, b) => sky.stars[b.other].degree - sky.stars[a.other].degree).slice(0, 6);
    sheet.innerHTML = `<button type="button" class="nebula-close" data-close aria-label="Close details">×</button><p class="nebula-kicker">${star.isolated ? "Unlinked" : star.source === "frontmatter" ? "Curated" : "Link neighborhood"}</p><h2>${escapeHtml(star.title)}</h2><p>Degree ${star.degree}: explicit links to ${star.degree} other example page${star.degree === 1 ? "" : "s"}. Brightness and size follow this count, not importance or similarity.</p><p>${kind} ${star.isolated ? "" : "Pages with more links are pulled toward the middle of their cloud."}</p>${links.length ? `<h3>Explicit links</h3><ul>${links.map(link => `<li><button type="button" data-focus="${sky.stars[link.other].id}"><span>${link.way} ${escapeHtml(sky.stars[link.other].title)}</span><small>${link.rel || "Markdown link"} · degree ${sky.stars[link.other].degree}</small></button></li>`).join("")}</ul>` : ""}`;
    sheet.classList.add("open");
    root.classList.add("sheet-open");
    live.textContent = `${star.title}. Degree ${star.degree}. ${kind}`;
  };

  const frameStar = (index: number, animate: boolean) => {
    const star = sky.stars[index];
    const destDistance = Math.max(homeDistance * 0.22, Math.min(homeDistance * 0.48, cam.distance));
    const saved = { ...cam };
    cam.distance = destDistance;
    cam.panX = 0;
    cam.panY = 0;
    const point = project(star);
    const panX = width() / 2 - point.x;
    const panY = height() / 2 - point.y - Math.min(90, height() * 0.06);
    cam.distance = saved.distance;
    cam.panX = saved.panX;
    cam.panY = saved.panY;
    showSheet(index);
    glide({ distance: destDistance, panX, panY }, animate && !reduced);
  };

  let glideRaf = 0;
  const glide = (dest: { distance: number; panX: number; panY: number }, animate: boolean) => {
    cancelAnimationFrame(glideRaf);
    if (!animate) {
      cam.distance = dest.distance;
      cam.panX = dest.panX;
      cam.panY = dest.panY;
      paint();
      return;
    }
    const from = { distance: cam.distance, panX: cam.panX, panY: cam.panY };
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 420);
      const e = 1 - (1 - t) * (1 - t);
      cam.distance = from.distance + (dest.distance - from.distance) * e;
      cam.panX = from.panX + (dest.panX - from.panX) * e;
      cam.panY = from.panY + (dest.panY - from.panY) * e;
      paint();
      if (t < 1) glideRaf = requestAnimationFrame(step);
    };
    glideRaf = requestAnimationFrame(step);
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    const next = Math.max(homeDistance * 0.16, Math.min(homeDistance * 2.5, cam.distance / factor));
    const applied = cam.distance / next;
    const cx = sx - width() / 2;
    const cy = sy - height() / 2;
    cam.panX = cx - (cx - cam.panX) * applied;
    cam.panY = cy - (cy - cam.panY) * applied;
    cam.distance = next;
  };

  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min(40, now - last);
    last = now;
    frame += 1;
    if (!reduced && now - lastInput > 1600 && !pointers.size) cam.yaw += 0.000012 * dt;
    if (frame === 1) {
      const sampleStart = now;
      let samples = 0;
      const sample = (stamp: number) => {
        samples += 1;
        paint();
        if (stamp - sampleStart < 900) requestAnimationFrame(sample);
        else {
          fps = samples / ((stamp - sampleStart) / 1000);
          flag.textContent = `Example nebula · ${sky.counts.nodes} fictional pages · ${sky.counts.edges} explicit links · ${fps.toFixed(0)} fps measured in this view · not your wiki`;
          root.dataset.fps = fps.toFixed(1);
          root.dataset.layoutMs = layoutMs.toFixed(0);
          paint();
          if (!reduced) raf = requestAnimationFrame(loop);
        }
      };
      raf = requestAnimationFrame(sample);
      return;
    }
    paint();
    raf = requestAnimationFrame(loop);
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest("button, input, a, .nebula-sheet")) return;
    lastInput = performance.now();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* The pointer can already be gone. */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    drag = { x: event.clientX, y: event.clientY, panX: cam.panX, panY: cam.panY, moved: false };
  };
  const onPointerMove = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    lastInput = performance.now();
    if (pointers.size >= 2) {
      const [first, second] = [...pointers.values()];
      const dist = Math.hypot(first.x - second.x, first.y - second.y) || 1;
      const prev = pinchDist || dist;
      zoomAt((first.x + second.x) / 2, (first.y + second.y) / 2, dist / prev);
      pinchDist = dist;
      if (drag) drag.moved = true;
      return;
    }
    pinchDist = 0;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    cam.panX = drag.panX + dx;
    cam.panY = drag.panY + dy;
    paint();
  };
  let pinchDist = 0;
  const onPointerUp = (event: PointerEvent) => {
    const start = drag;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    drag = null;
    if (!start || start.moved) return;
    const rect = canvas.getBoundingClientRect();
    const index = pick(event.clientX - rect.left, event.clientY - rect.top);
    if (index < 0) showSheet(-1);
    else frameStar(index, true);
    paint();
  };
  const onWheel = (event: WheelEvent) => {
    if ((event.target as HTMLElement).closest(".nebula-sheet")) return;
    event.preventDefault();
    lastInput = performance.now();
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0011));
    paint();
  };
  const focusId = (id: string, animate = true) => {
    const index = sky.stars.findIndex(star => star.id === id);
    if (index < 0) return;
    frameStar(index, animate);
    paint();
  };
  root.addEventListener("click", event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-zoom], [data-home], [data-close], [data-focus]");
    if (!target) return;
    lastInput = performance.now();
    if (target.dataset.close !== undefined) { showSheet(-1); paint(); return; }
    if (target.dataset.home !== undefined) {
      glide({ distance: homeDistance, panX: 0, panY: 0 }, !reduced);
      if (!reduced) cam.yaw = home.yaw;
      showSheet(-1);
      return;
    }
    if (target.dataset.zoom) {
      zoomAt(width() / 2, height() / 2, target.dataset.zoom === "in" ? 1.28 : 0.78);
      paint();
      return;
    }
    if (target.dataset.focus) focusId(target.dataset.focus);
  });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    paint();
  });
  search.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const found = sky.stars.findIndex(star => `${star.title} ${star.id}`.toLowerCase().includes(query) && query);
    if (found >= 0) focusId(sky.stars[found].id);
  });
  window.addEventListener("keydown", onKey);
  function onKey(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return;
    lastInput = performance.now();
    if (event.key === "+" || event.key === "=") zoomAt(width() / 2, height() / 2, 1.2);
    else if (event.key === "-" || event.key === "_") zoomAt(width() / 2, height() / 2, 0.84);
    else if (event.key === "ArrowLeft") cam.panX += 40;
    else if (event.key === "ArrowRight") cam.panX -= 40;
    else if (event.key === "ArrowUp") cam.panY += 40;
    else if (event.key === "ArrowDown") cam.panY -= 40;
    else if (event.key === "Escape") showSheet(-1);
    else return;
    event.preventDefault();
    paint();
  }
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  root.addEventListener("wheel", onWheel, { passive: false });
  const onResize = () => { resize(); paint(); };
  window.addEventListener("resize", onResize);
  const api = {
    focus: focusId,
    project(id: string) {
      const star = sky.stars.find(item => item.id === id);
      return star ? project(star) : null;
    },
    get zoom() { return homeDistance / cam.distance; },
    sky,
    fps: () => fps,
  };
  (window as unknown as { __nebula?: typeof api }).__nebula = api;
  resize();
  fit();
  paint();
  raf = requestAnimationFrame(loop);
  return () => {
    running = false;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(glideRaf);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    delete (window as unknown as { __nebula?: typeof api }).__nebula;
    root.remove();
  };
}

function wash(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rgb: [number, number, number], alpha: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`);
  gradient.addColorStop(0.45, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha * 0.35})`);
  gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function tintSprite(rgb: [number, number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.08, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.85)`);
  gradient.addColorStop(0.22, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.28)`);
  gradient.addColorStop(0.55, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.05)`);
  gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return canvas;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
