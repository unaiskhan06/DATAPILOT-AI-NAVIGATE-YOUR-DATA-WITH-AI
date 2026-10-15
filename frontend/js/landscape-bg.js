/* =========================================================================
   DataPilot AI — Procedural scrolling landscape background
   Dependency-free <canvas> effect: a wireframe terrain generated from value
   noise, projected in perspective and scrolling toward the horizon.
   Colours are read from the theme tokens in css/style.css.
   ========================================================================= */
(function () {
  "use strict";

  const CANVAS_ID = "landscapeBg";

  /* ---- Grid / projection tuning ---- */
  const COLS = 44;          // segments across
  const ROWS = 40;          // segments into the distance
  const HORIZON = 0.44;     // horizon line, as a fraction of canvas height
  const D_NEAR = 1.0;       // depth of the nearest row
  const D_FAR = 9.0;        // depth of the row at the horizon
  const D_CURVE = 1.9;      // >1 compresses distant rows toward the horizon
  const X_SPAN = 2.25;      // horizontal spread (multiples of canvas width)
  const H_SPAN = 0.52;      // terrain height (fraction of canvas height)
  const SPEED = 1.6;        // world rows travelled per second
  const NOISE_FREQ = 0.13;  // terrain feature size
  const VALLEY = 1.7;       // >1 flattens the centre so hero text stays legible
  const MAX_ALPHA = 0.5;
  const MAX_DPR = 2;

  const canvas = document.getElementById(CANVAS_ID);
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  /* ---------------- Theme colours ---------------- */
  function parseHex(hex, fallback) {
    const m = /^#?([a-f\d]{6})$/i.exec((hex || "").trim());
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  let NEAR_RGB = [59, 125, 246];   // --accent
  let FAR_RGB = [106, 61, 246];    // --accent-2

  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    NEAR_RGB = parseHex(cs.getPropertyValue("--accent"), NEAR_RGB);
    FAR_RGB = parseHex(cs.getPropertyValue("--accent-2"), FAR_RGB);
  }

  /* ---------------- Value noise ---------------- */
  const SEED = 1337;

  function hash2(ix, iy, seed) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  function valueNoise(x, y, seed) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smoothstep(x - x0), fy = smoothstep(y - y0);
    const v00 = hash2(x0, y0, seed), v10 = hash2(x0 + 1, y0, seed);
    const v01 = hash2(x0, y0 + 1, seed), v11 = hash2(x0 + 1, y0 + 1, seed);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  }

  function fbm(x, y) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < 3; o++) {
      sum += valueNoise(x * freq, y * freq, SEED + o * 101) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  /* Terrain height at a grid column and an integer world row. */
  function terrainAt(c, worldRow) {
    const u = c / COLS;
    const edge = Math.abs(u - 0.5) * 2;            // 0 at centre, 1 at edges
    const mask = Math.pow(edge, VALLEY);
    let n = fbm(c * NOISE_FREQ, worldRow * NOISE_FREQ);
    n = n * n * 1.15;                              // sharpen the ridges
    return n * mask;
  }

  /* Integer world rows are cached; fractional scroll interpolates between them. */
  const rowCache = new Map();

  function heightRow(worldRowInt) {
    let row = rowCache.get(worldRowInt);
    if (row) return row;
    row = new Float32Array(COLS + 1);
    for (let c = 0; c <= COLS; c++) row[c] = terrainAt(c, worldRowInt);
    rowCache.set(worldRowInt, row);
    return row;
  }

  function pruneCache(lo, hi) {
    if (rowCache.size < 240) return;
    for (const k of rowCache.keys()) {
      if (k < lo - 4 || k > hi + 4) rowCache.delete(k);
    }
  }

  /* ---------------- Geometry buffers ---------------- */
  const VERTS = (ROWS + 1) * (COLS + 1);
  const xs = new Float32Array(VERTS);
  const ys = new Float32Array(VERTS);
  const idx = (r, c) => r * (COLS + 1) + c;

  let W = 0, H = 0, dpr = 1;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* Depth helpers, precomputed per row. */
  const depthT = new Float32Array(ROWS + 1);
  const persp = new Float32Array(ROWS + 1);
  for (let r = 0; r <= ROWS; r++) {
    const t = r / ROWS;
    depthT[r] = t;
    persp[r] = 1 / (D_NEAR + (D_FAR - D_NEAR) * Math.pow(t, D_CURVE));
  }

  function buildGeometry(scroll) {
    const horizonY = H * HORIZON;
    const ySpan = H * 0.98 - horizonY;
    const xSpan = W * X_SPAN;
    const hSpan = H * H_SPAN;
    const cx = W / 2;

    const base = Math.floor(scroll);
    const frac = scroll - base;
    pruneCache(base, base + ROWS + 1);

    for (let r = 0; r <= ROWS; r++) {
      const p = persp[r];
      const rowA = heightRow(base + r);
      const rowB = heightRow(base + r + 1);
      const yBase = horizonY + p * ySpan;
      for (let c = 0; c <= COLS; c++) {
        const h = rowA[c] + (rowB[c] - rowA[c]) * frac;
        const i = idx(r, c);
        xs[i] = cx + (c / COLS - 0.5) * p * xSpan;
        ys[i] = yBase - h * p * hSpan;
      }
    }
  }

  function strokeStyleFor(r) {
    const t = depthT[r];
    const fade = Math.pow(1 - t, 1.6);
    const rr = Math.round(NEAR_RGB[0] + (FAR_RGB[0] - NEAR_RGB[0]) * t);
    const gg = Math.round(NEAR_RGB[1] + (FAR_RGB[1] - NEAR_RGB[1]) * t);
    const bb = Math.round(NEAR_RGB[2] + (FAR_RGB[2] - NEAR_RGB[2]) * t);
    return `rgba(${rr},${gg},${bb},${(fade * MAX_ALPHA).toFixed(3)})`;
  }

  function drawHorizonGlow() {
    const horizonY = H * HORIZON;
    const radius = Math.max(W, H) * 0.55;
    const g = ctx.createRadialGradient(W / 2, horizonY, 0, W / 2, horizonY, radius);
    g.addColorStop(0, `rgba(${FAR_RGB[0]},${FAR_RGB[1]},${FAR_RGB[2]},0.13)`);
    g.addColorStop(1, `rgba(${FAR_RGB[0]},${FAR_RGB[1]},${FAR_RGB[2]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function draw(scroll) {
    ctx.clearRect(0, 0, W, H);
    buildGeometry(scroll);
    drawHorizonGlow();

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    /* Lines running across the terrain — one stroke per depth row. */
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      for (let c = 0; c <= COLS; c++) {
        const i = idx(r, c);
        if (c === 0) ctx.moveTo(xs[i], ys[i]);
        else ctx.lineTo(xs[i], ys[i]);
      }
      ctx.strokeStyle = strokeStyleFor(r);
      ctx.lineWidth = 0.6 + (1 - depthT[r]) * 0.9;
      ctx.stroke();
    }

    /* Lines running into the distance, batched per row so depth colour holds. */
    for (let r = 0; r < ROWS; r++) {
      ctx.beginPath();
      for (let c = 0; c <= COLS; c++) {
        const a = idx(r, c), b = idx(r + 1, c);
        ctx.moveTo(xs[a], ys[a]);
        ctx.lineTo(xs[b], ys[b]);
      }
      ctx.strokeStyle = strokeStyleFor(r);
      ctx.lineWidth = (0.6 + (1 - depthT[r]) * 0.9) * 0.75;
      ctx.stroke();
    }
  }

  /* ---------------- Loop ---------------- */
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let scroll = 0;
  let last = 0;
  let rafId = 0;
  let visible = true;
  let running = false;

  function frame(now) {
    rafId = 0;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    scroll += SPEED * dt;
    draw(scroll);
    if (running) rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running || !visible || reduceMotion.matches) return;
    running = true;
    last = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function renderStatic() {
    if (W && H) draw(scroll);
  }

  function init() {
    readTokens();
    if (!resize()) return;
    if (reduceMotion.matches) renderStatic();
    else start();
  }

  /* Redraw on size change; keep the animation state intact. */
  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (resize() && !running) renderStatic();
    }, 120);
  }

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(onResize).observe(canvas);
  } else {
    window.addEventListener("resize", onResize);
  }

  /* Pause when the hero scrolls out of view or the tab is hidden. */
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
      else stop();
    }, { threshold: 0 }).observe(canvas);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) { stop(); renderStatic(); }
    else start();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
