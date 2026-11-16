/* ============================================================
   SecondBrain — Variant C "Orbit Bento"
   Vanilla JS: galaxy canvas, nav, reveal-on-scroll, copy button
   ============================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ----------------------------------------------------------
     1. Navigation — sticky shadow + mobile drawer
     ---------------------------------------------------------- */
  function initNav() {
    var nav = document.querySelector(".nav");
    var toggle = document.querySelector(".nav-toggle");
    var drawer = document.getElementById("nav-drawer");

    if (nav) {
      var ticking = false;
      var update = function () {
        nav.classList.toggle("is-stuck", window.scrollY > 8);
        ticking = false;
      };
      update();
      window.addEventListener(
        "scroll",
        function () {
          if (!ticking) {
            ticking = true;
            window.requestAnimationFrame(update);
          }
        },
        { passive: true }
      );
    }

    if (!toggle || !drawer) return;

    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      drawer.hidden = !open;
    };

    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    drawer.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        toggle.focus();
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 860) setOpen(false);
    });
  }

  /* ----------------------------------------------------------
     2. Reveal on scroll
     ---------------------------------------------------------- */
  function initReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!items.length) return;

    if (reduceMotion.matches || !("IntersectionObserver" in window)) {
      for (var i = 0; i < items.length; i++) items[i].classList.add("is-visible");
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );

    for (var j = 0; j < items.length; j++) io.observe(items[j]);
  }

  /* ----------------------------------------------------------
     3. Copy-to-clipboard with accessible live feedback
     ---------------------------------------------------------- */
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function initCopy() {
    var buttons = document.querySelectorAll(".copy-btn");
    if (!buttons.length) return;

    Array.prototype.forEach.call(buttons, function (btn) {
      var label = btn.querySelector(".copy-label");
      var status = document.getElementById("copy-status");
      var resetTimer = null;

      btn.addEventListener("click", function () {
        var target = document.querySelector(btn.getAttribute("data-copy-target"));
        if (!target) return;
        var text = (target.textContent || "").trim();

        var finish = function (ok) {
          if (status) {
            status.textContent = ok
              ? "Copied! Paste it into your terminal."
              : "Copy failed — select the command and copy it manually.";
          }
          if (!ok) return;

          btn.classList.add("is-copied");
          if (label) label.textContent = "Copied!";

          window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(function () {
            btn.classList.remove("is-copied");
            if (label) label.textContent = "Copy";
            if (status) status.textContent = "";
          }, 2200);
        };

        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(
            function () {
              finish(true);
            },
            function () {
              finish(legacyCopy(text));
            }
          );
        } else {
          finish(legacyCopy(text));
        }
      });
    });
  }

  /* ----------------------------------------------------------
     4. Galaxy canvas — nebula / star map
     ---------------------------------------------------------- */
  function initGalaxy() {
    var canvas = document.getElementById("galaxy-canvas");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    var stage = canvas.closest(".stage") || canvas;

    // Star colours mirror the app's Galaxy palette.
    var COLORS = [
      [92, 222, 240],  // cyan
      [150, 170, 255], // periwinkle
      [255, 170, 120], // coral
      [178, 140, 255], // violet
      [255, 214, 120], // gold
      [120, 236, 190], // mint
      [255, 130, 190], // pink
      [196, 160, 255]  // lilac
    ];
    var N_CLUSTERS = 8, PER_CLUSTER = 36, FIELD = 70;

    var W = 1, H = 1, dpr = 1, cx = 0, cy = 0, rx = 1, ry = 1;
    var clusters = [], field = [], links = [], bridges = [], pulses = [];
    var sprites = COLORS.map(makeSprite);
    var white = makeSprite([235, 245, 255]);
    var nebula = document.createElement("canvas");
    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    var time = 0, last = 0, rafId = 0, running = false, visible = true, hidden = false, nextPulse = 1.2;

    function makeSprite(rgb) {
      var s = 64, c = document.createElement("canvas"); c.width = c.height = s;
      var g = c.getContext("2d"), grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      var col = rgb.join(",");
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.12, "rgba(" + col + ",0.95)");
      grd.addColorStop(0.34, "rgba(" + col + ",0.35)");
      grd.addColorStop(1, "rgba(" + col + ",0)");
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
      return c;
    }
    function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }

    function build() {
      clusters = []; links = []; bridges = [];
      for (var k = 0; k < N_CLUSTERS; k++) {
        var cl = {
          a: (k / N_CLUSTERS) * Math.PI * 2 + gauss() * 0.18,
          d: 0.78 + Math.random() * 0.22,
          c: k % COLORS.length,
          spread: 0.1 + Math.random() * 0.035,
          stars: []
        };
        var n = PER_CLUSTER - Math.floor(Math.random() * 8);
        for (var i = 0; i < n; i++) {
          cl.stars.push({
            ox: gauss() * cl.spread, oy: gauss() * cl.spread * 1.1,
            r: 0.9 + Math.random() * 2.1, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.1
          });
        }
        // nearest-neighbour "wiki links" inside the cluster
        for (var a = 0; a < cl.stars.length; a++) {
          var best = -1, bd = 1e9;
          for (var b = 0; b < cl.stars.length; b++) {
            if (a === b) continue;
            var dx = cl.stars[a].ox - cl.stars[b].ox, dy = cl.stars[a].oy - cl.stars[b].oy, dd = dx * dx + dy * dy;
            if (dd < bd) { bd = dd; best = b; }
          }
          if (best > a || Math.random() < 0.35) links.push([k, a, best]);
        }
        clusters.push(cl);
      }
      // the core cluster
      var core = { a: 0, d: 0, c: 4, spread: 0.09, stars: [], core: true };
      for (var j = 0; j < 40; j++) core.stars.push({ ox: gauss() * 0.16, oy: gauss() * 0.2, r: 0.9 + Math.random() * 2, ph: Math.random() * 6.28, sp: 0.4 + Math.random() });
      clusters.push(core);
      for (var m = 0; m < N_CLUSTERS; m++) {
        bridges.push([m, (m + 1) % N_CLUSTERS]);
        if (m % 2 === 0) bridges.push([m, N_CLUSTERS]);
      }
      field = [];
      for (var f = 0; f < FIELD; f++) field.push({ x: Math.random(), y: Math.random(), r: 0.3 + Math.random() * 0.9, ph: Math.random() * 6.28, sp: 0.3 + Math.random() * 1.2, z: 0.2 + Math.random() * 0.6 });
    }

    function paintNebula() {
      nebula.width = Math.round(W * dpr); nebula.height = Math.round(H * dpr);
      var g = nebula.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalCompositeOperation = "lighter";
      var blobs = clusters.map(function (cl) { return clusterCenter(cl, 0); });
      blobs.forEach(function (p, i) {
        var col = COLORS[clusters[i].c].join(","), R = Math.min(W, H) * (clusters[i].core ? 0.42 : 0.3);
        var grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
        grd.addColorStop(0, "rgba(" + col + "," + (clusters[i].core ? 0.26 : 0.22) + ")");
        grd.addColorStop(0.45, "rgba(" + col + ",0.08)");
        grd.addColorStop(1, "rgba(" + col + ",0)");
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
      });
      // faint galactic band
      g.save(); g.translate(cx, cy); g.rotate(-0.18); g.scale(1, 0.32);
      var band = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.55);
      band.addColorStop(0, "rgba(170,160,255,0.10)"); band.addColorStop(0.6, "rgba(90,200,230,0.04)"); band.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = band; g.beginPath(); g.arc(0, 0, W * 0.55, 0, 6.283); g.fill(); g.restore();
    }

    function layout() {
      var rect = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width)); H = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2;
      rx = Math.min(W * 0.4, H * 1.05); ry = H * 0.36;
      if (W < H) { rx = W * 0.36; ry = H * 0.34; }
      paintNebula();
      if (!running) draw(0);
    }

    function clusterCenter(cl, rot) {
      var a = cl.a + rot;
      return { x: cx + Math.cos(a) * rx * cl.d, y: cy + Math.sin(a) * ry * cl.d };
    }
    var scaleU = function () { return Math.min(W, H * 1.6); };

    function starPos(cl, s, c, t) {
      var u = scaleU();
      return { x: c.x + s.ox * u + Math.sin(t * s.sp + s.ph) * 1.6, y: c.y + s.oy * u * 0.62 + Math.cos(t * s.sp * 0.8 + s.ph) * 1.2 };
    }

    function draw(t) {
      var rot = t * 0.018;
      var px = pointer.x * 14, py = pointer.y * 10;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.9 + 0.1 * Math.sin(t * 0.4);
      ctx.drawImage(nebula, px * 0.4, py * 0.4, W, H);

      // background dust
      for (var f = 0; f < field.length; f++) {
        var fs = field[f];
        ctx.globalAlpha = (0.35 + 0.35 * Math.sin(t * fs.sp + fs.ph)) * fs.z + 0.08;
        ctx.fillStyle = "#dfe8ff";
        ctx.fillRect(fs.x * W + px * fs.z, fs.y * H + py * fs.z, fs.r + 0.4, fs.r + 0.4);
      }

      var centers = clusters.map(function (cl) {
        var c = clusterCenter(cl, cl.core ? 0 : rot);
        c.x += px; c.y += py; return c;
      });

      // long faint bridges between constellations
      ctx.lineWidth = 1;
      for (var b = 0; b < bridges.length; b++) {
        var A = centers[bridges[b][0]], B = centers[bridges[b][1]];
        var gr = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
        gr.addColorStop(0, "rgba(" + COLORS[clusters[bridges[b][0]].c].join(",") + ",0.14)");
        gr.addColorStop(1, "rgba(" + COLORS[clusters[bridges[b][1]].c].join(",") + ",0.14)");
        ctx.globalAlpha = 1; ctx.strokeStyle = gr;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }

      // intra-cluster links
      for (var l = 0; l < links.length; l++) {
        var cl = clusters[links[l][0]], c0 = centers[links[l][0]];
        var p1 = starPos(cl, cl.stars[links[l][1]], c0, t), p2 = starPos(cl, cl.stars[links[l][2]], c0, t);
        ctx.globalAlpha = 0.34; ctx.strokeStyle = "rgb(" + COLORS[cl.c].join(",") + ")";
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }

      // stars
      for (var k = 0; k < clusters.length; k++) {
        var C = clusters[k], cc = centers[k], spr = sprites[C.c];
        for (var i = 0; i < C.stars.length; i++) {
          var s = C.stars[i], p = starPos(C, s, cc, t);
          var tw = 0.7 + 0.3 * Math.sin(t * s.sp * 1.7 + s.ph), size = s.r * 9.5;
          ctx.globalAlpha = 0.95 * tw;
          ctx.drawImage(spr, p.x - size / 2, p.y - size / 2, size, size);
        }
      }

      // pulses: an agent writing a page travels along a bridge
      for (var q = pulses.length - 1; q >= 0; q--) {
        var P = pulses[q]; P.k += 0.012;
        if (P.k >= 1) { pulses.splice(q, 1); continue; }
        var a1 = centers[bridges[P.b][0]], a2 = centers[bridges[P.b][1]];
        var x = a1.x + (a2.x - a1.x) * P.k, y = a1.y + (a2.y - a1.y) * P.k, sz = 26 * Math.sin(P.k * Math.PI) + 6;
        ctx.globalAlpha = Math.sin(P.k * Math.PI);
        ctx.drawImage(white, x - sz / 2, y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    }

    function frame(now) {
      if (!running) return;
      if (!last) last = now;
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      time += dt;
      nextPulse -= dt;
      if (nextPulse <= 0) { pulses.push({ b: Math.floor(Math.random() * bridges.length), k: 0 }); nextPulse = 1.4 + Math.random() * 2.2; }
      pointer.x += (pointer.tx - pointer.x) * 0.05; pointer.y += (pointer.ty - pointer.y) * 0.05;
      draw(time);
      rafId = window.requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      if (reduceMotion.matches) { draw(0); return; }
      if (hidden || !visible) return;
      running = true; last = 0; rafId = window.requestAnimationFrame(frame);
    }
    function stop() { running = false; if (rafId) window.cancelAnimationFrame(rafId); rafId = 0; }

    build();
    stage.classList.add("has-canvas");
    if ("ResizeObserver" in window) new ResizeObserver(layout).observe(canvas);
    else window.addEventListener("resize", layout);
    layout();

    stage.addEventListener("pointermove", function (e) {
      var r = stage.getBoundingClientRect();
      pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    }, { passive: true });
    stage.addEventListener("pointerleave", function () { pointer.tx = 0; pointer.ty = 0; }, { passive: true });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting; if (visible) start(); else stop();
      }, { threshold: 0.01 }).observe(canvas);
    }
    document.addEventListener("visibilitychange", function () { hidden = document.hidden; if (hidden) stop(); else start(); });
    if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", function () { stop(); draw(0); start(); });
    start();
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */

  /* Hero stage grows towards full width while it scrolls into view */
  function initStageScroll() {
    var stage = document.querySelector(".stage");
    if (!stage || reduceMotion.matches) return;
    var ticking = false;
    function update() {
      ticking = false;
      var r = stage.getBoundingClientRect(), vh = window.innerHeight;
      var p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.9)));
      stage.style.setProperty("--grow", p.toFixed(3));
    }
    window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  function boot() {
    initNav();
    initReveal();
    initCopy();
    initGalaxy();
    initStageScroll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
