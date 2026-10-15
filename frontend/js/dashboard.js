/* dashboard.js — Power BI-style dashboard studio */

let profile = null;
let charts = {};      // id -> Chart instance
let widgets = [];     // {id, spec}
let widgetSeq = 0;
let drillFilters = []; // [{column, value}] — click-to-filter from chart slices
let refreshTimer = null;
let embedMode = false;
let readOnly = false;
let dashboardLogo = null; // dataURL of the user's own dataset logo (e.g. a brand logo)

const PALETTE = ["#3b7df6", "#6a3df6", "#2ea4c4", "#9b5cf6", "#3bc9db", "#845ef7", "#4dabf7", "#b197fc", "#228be6", "#5c7cfa"];

/* Colour helpers: lighten/darken a hex colour and build shade palettes */
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = pct < 0 ? 0 : 255;
  const p = Math.abs(pct);
  r = Math.round(r + (t - r) * p);
  g = Math.round(g + (t - g) * p);
  b = Math.round(b + (t - b) * p);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function makeShades(base, n) {
  const steps = [0, 0.25, -0.2, 0.45, -0.35, 0.6, 0.12, -0.1, 0.35, -0.28];
  return Array.from({ length: n }, (_, i) => shade(base, steps[i % steps.length]));
}

Chart.defaults.font.family = "Poppins, sans-serif";
Chart.defaults.color = "#6b7594";

/* ---------------- Init ---------------- */
async function init() {
  const params = new URLSearchParams(window.location.search);
  const urlSid = params.get("sid");
  if (urlSid) Session.set(urlSid);
  embedMode = params.get("embed") === "1";
  if (embedMode) document.body.classList.add("embed-mode");
  // Read-only view (shared links): can view/filter, but not edit or save.
  readOnly = embedMode || params.get("view") === "1";
  if (readOnly) document.body.classList.add("view-mode");

  // Shared / embedded read-only views are public — no login required.
  if (!readOnly && !(await requireLogin())) return;
  if (!Session.get()) return showNoData();
  try {
    profile = await api("/api/profile");
  } catch (_) {
    return showNoData();
  }
  document.getElementById("noData").classList.add("hidden");
  document.getElementById("dashArea").classList.remove("hidden");
  document.getElementById("fileName").textContent = Session.filename();
  if (readOnly && !embedMode) {
    const banner = document.createElement("div");
    banner.className = "readonly-banner neo";
    banner.innerHTML = `<i data-lucide="eye" style="width:15px"></i> Read-only shared view — you can explore and filter, but changes won't be saved.`;
    const area = document.getElementById("dashArea");
    area.insertBefore(banner, area.firstChild);
  }
  renderKpis();
  populateModalSelects();
  loadDashboardLogo();
  initStudio();
  if (!embedMode) await loadRecommendations();
  const restored = await loadLayout();
  if (!restored) await autoBuild();
  if (window.lucide) lucide.createIcons();
}

/* ---------------- Layout persistence (powers share links) ---------------- */
let layoutSaveTimer = null;
let restoringLayout = false;

function serializeWidgets() {
  return widgets.map((w) => {
    const s = Object.assign({}, w.spec);
    if (s.selected instanceof Set) s.selected = [...s.selected];
    const card = document.getElementById(w.id);
    if (card) {
      if (card.style.width) s.cardW = parseInt(card.style.width, 10);
      if (card.style.height) s.cardH = parseInt(card.style.height, 10);
      if (card.style.left) s.cardX = parseFloat(card.style.left);
      if (card.style.top) s.cardY = parseFloat(card.style.top);
    }
    return s;
  });
}

function persistLayout() {
  if (readOnly || restoringLayout) return;
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(async () => {
    try {
      await api("/api/layout", {
        method: "POST",
        body: { widgets: serializeWidgets(), format: pageFormat },
      });
    } catch (_) {}
  }, 500);
}

async function loadLayout() {
  let specs;
  try {
    const data = await api("/api/layout");
    specs = data.widgets;
    if (data.format) {
      pageFormat = normalizePageFormat(data.format);
      syncFormatInputs();
      applyPageFormat();
    }
  } catch (_) { return false; }
  if (!specs || !specs.length) return false;

  restoringLayout = true;
  try {
    for (const spec of specs) {
      if (spec.kind === "visual") await addVisualWidget(spec);
      else if (spec.kind === "kpi") await addKpiWidget(spec);
      else if (spec.kind === "slicer") {
        await addSlicerWidget(spec.column);
        const w = widgets[widgets.length - 1];
        if (w && Array.isArray(spec.selected) && spec.selected.length) {
          w.spec.selected = new Set(spec.selected);
          const card = document.getElementById(w.id);
          if (card) card.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = w.spec.selected.has(cb.value); });
        }
      }
      else if (spec.kind === "pivot") await addPivotWidget(spec);
      else if (spec.kind === "geo") await addGeoWidget(spec);
      else if (spec.kind === "insight") addInsightWidget(spec);
      else await addWidget(spec);

      const restored = widgets[widgets.length - 1];
      if (typeof spec.showBackground === "boolean") restored.spec.showBackground = spec.showBackground;
      if (Number.isFinite(spec.cardX) && Number.isFinite(spec.cardY)) {
        Object.assign(restored.spec, { cardX: spec.cardX, cardY: spec.cardY });
      }

      if (spec.cardW || spec.cardH) {
        const card = document.getElementById(widgets[widgets.length - 1].id);
        if (card) {
          if (spec.cardW) card.style.width = `${spec.cardW}px`;
          if (spec.cardH) card.style.height = `${spec.cardH}px`;
          card.style.gridColumn = "span 12";
          const wid = card.id;
          if (charts[wid]) setTimeout(() => charts[wid].resize(), 50);
        }
      }
    }
  } finally {
    restoringLayout = false;
  }
  renderChartBackgroundControls();
  if (widgets.some((w) => Number.isFinite(w.spec.cardX))) enableFreeLayout();
  if (widgets.some((w) => isSlicerSpec(w.spec) && w.spec.selected && w.spec.selected.size)) await refreshAll();
  return true;
}

/* ---------------- Dataset logo (top-left, always included in exports) ---------------- */
function logoStorageKey() {
  return `dp_logo:${Session.get()}`;
}
function loadDashboardLogo() {
  dashboardLogo = localStorage.getItem(logoStorageKey());
  renderDashboardLogo();
}
function renderDashboardLogo() {
  const img = document.getElementById("dashLogoImg");
  const uploadLabel = document.getElementById("dashLogoUploadLabel");
  const removeBtn = document.getElementById("logoRemoveBtn");
  if (dashboardLogo) {
    img.src = dashboardLogo;
    img.classList.remove("hidden");
    uploadLabel.classList.add("hidden");
    removeBtn.classList.remove("hidden");
  } else {
    img.classList.add("hidden");
    img.src = "";
    uploadLabel.classList.remove("hidden");
    removeBtn.classList.add("hidden");
  }
}
document.getElementById("logoInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!["image/png", "image/jpeg"].includes(file.type)) return toast("Only PNG or JPG logos are supported", "err");
  if (file.size > 2 * 1024 * 1024) return toast("Logo must be under 2MB", "err");
  const reader = new FileReader();
  reader.onload = () => {
    dashboardLogo = reader.result;
    try { localStorage.setItem(logoStorageKey(), dashboardLogo); } catch (_) {}
    renderDashboardLogo();
    toast("Logo added");
  };
  reader.readAsDataURL(file);
});
document.getElementById("logoRemoveBtn").addEventListener("click", () => {
  dashboardLogo = null;
  localStorage.removeItem(logoStorageKey());
  renderDashboardLogo();
  toast("Logo removed");
});

function showNoData() {
  document.getElementById("noData").classList.remove("hidden");
  document.getElementById("dashArea").classList.add("hidden");
  if (window.lucide) lucide.createIcons();
}

/* ---------------- KPIs ---------------- */
function renderKpis() {
  const numeric = profile.columns.filter((c) => c.kind === "numeric");
  const kpis = [
    { l: "Total rows", v: profile.total_rows.toLocaleString() },
    { l: "Columns", v: profile.total_cols },
    { l: "Numeric fields", v: numeric.length },
    { l: "Data quality", v: dataQuality() + "%" },
  ];
  document.getElementById("kpiRow").innerHTML = kpis
    .map((k) => `<div class="kpi-card neo"><div class="kpi-v gradient-text">${k.v}</div><div class="kpi-l">${k.l}</div></div>`)
    .join("");
}

function dataQuality() {
  const cells = profile.total_rows * profile.total_cols || 1;
  return Math.max(0, Math.round((1 - profile.total_missing / cells) * 100));
}

/* ---------------- Recommendations ---------------- */
async function loadRecommendations() {
  try {
    const data = await api("/api/recommend");
    const grid = document.getElementById("recGrid");
    if (!data.recommendations.length) {
      grid.innerHTML = `<p class="muted">No recommendations available for this dataset.</p>`;
      return;
    }
    grid.innerHTML = data.recommendations
      .map(
        (r, i) => `<div class="rec-card neo" data-rec='${encodeURIComponent(JSON.stringify(r))}'>
          <div class="rec-top">
            <span class="rec-type">${r.type}</span>
            <span class="rec-score">${r.score}%</span>
          </div>
          <h4>${r.title}</h4>
          <p>${r.reason}</p>
        </div>`
      )
      .join("");
    grid.querySelectorAll(".rec-card").forEach((card) => {
      card.addEventListener("click", () => {
        const rec = JSON.parse(decodeURIComponent(card.dataset.rec));
        addWidget(rec);
        toast(`Added: ${rec.title}`);
      });
    });
  } catch (err) { toast(err.message, "err"); }
}

/* ---------------- Slicers / global filters ---------------- */
function isSlicerSpec(spec) {
  return spec.kind === "slicer" ||
    (spec.kind === "visual" && (spec.type === "slicer" || spec.type === "button_slicer"));
}

function activeFilters() {
  const slicerFilters = widgets
    .filter((w) => isSlicerSpec(w.spec) && w.spec.selected && w.spec.selected.size)
    .map((w) => ({ column: w.spec.column, values: [...w.spec.selected] }));
  const drill = drillFilters.map((d) => ({ column: d.column, values: [d.value] }));
  return [...slicerFilters, ...drill];
}

async function refreshAll() {
  for (const w of widgets) {
    if (w.spec.kind === "visual") {
      // Slicers keep their own selection — no need to re-query their values.
      if (!isSlicerSpec(w.spec) && w.spec.type !== "image") await renderVisualWidget(w.id, w.spec);
    }
    else if (w.spec.kind === "kpi") await renderKpiValue(w.id, w.spec);
    else if (w.spec.kind === "pivot") await renderPivot(w.id, w.spec);
    else if (w.spec.kind === "geo") await renderGeo(w.id, w.spec);
    else if (w.spec.kind !== "slicer") await renderChart(w.id, w.spec);
  }
}

/* ---------------- Drill-down (click a bar/pie slice to filter) ---------------- */
function renderDrillBar() {
  const bar = document.getElementById("drillBar");
  if (!drillFilters.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML =
    `<span class="drill-label"><i data-lucide="filter" style="width:14px"></i> Drill-down:</span>` +
    drillFilters
      .map(
        (d, i) => `<span class="drill-chip">${escapeAttr(d.column)} = ${escapeAttr(d.value)}
          <button data-i="${i}" title="Remove"><i data-lucide="x" style="width:12px"></i></button></span>`
      )
      .join("") +
    `<button class="btn btn-sm" id="drillClearAll">Clear all</button>`;
  bar.querySelectorAll("button[data-i]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      drillFilters.splice(Number(btn.dataset.i), 1);
      renderDrillBar();
      await refreshAll();
    });
  });
  const clearAll = document.getElementById("drillClearAll");
  if (clearAll) clearAll.addEventListener("click", async () => {
    drillFilters = [];
    renderDrillBar();
    await refreshAll();
  });
  if (window.lucide) lucide.createIcons();
}

async function addDrillFilter(column, value) {
  if (drillFilters.some((d) => d.column === column && d.value === value)) return;
  drillFilters.push({ column, value });
  renderDrillBar();
  await refreshAll();
}

/* ---------------- Widgets ---------------- */
function spanClass(type) {
  if (type === "pie" || type === "doughnut") return "span-4";
  if (type === "scatter" || type === "line") return "span-6";
  return "span-6";
}

async function addWidget(spec) {
  const id = "w" + widgetSeq++;
  spec = Object.assign({ type: "bar", agg: "count", title: "Chart", color: PALETTE[0] }, spec);
  widgets.push({ id, spec });

  const card = document.createElement("div");
  card.className = `viz-card neo ${spanClass(spec.type)}`;
  card.id = id;
  card.innerHTML = `
    <div class="viz-head">
      <h4>${spec.title}</h4>
      ${vizActionsHTML({ chart: true, color: spec.color })}
    </div>
    <div class="viz-body"><canvas></canvas></div>`;
  appendDashboardCard(card);
  wireVizToolbar(card, id);
  addResizeHandle(card, id);

  card.querySelector('[data-act="remove"]').addEventListener("click", () => removeWidget(id));
  card.querySelector('[data-act="png"]').addEventListener("click", () => downloadChartPng(id, spec.title));
  card.querySelector(".chart-color").addEventListener("input", (e) => {
    spec.color = e.target.value;
    if (charts[id] && charts[id].__payload) {
      const cfg = buildChartConfig(spec, charts[id].__payload);
      charts[id].data = cfg.data;
      charts[id].update();
    }
    persistLayout();
  });

  await renderChart(id, spec);
  persistLayout();
  if (window.lucide) lucide.createIcons();
}

/* ---- KPI card widget ---- */
async function addKpiWidget(spec) {
  const id = "w" + widgetSeq++;
  spec = Object.assign({ kind: "kpi", agg: "sum", title: "KPI", goal: null }, spec);
  widgets.push({ id, spec });

  const card = document.createElement("div");
  card.className = "kpi-card neo widget-kpi" + (spec.goal ? " has-goal" : "");
  card.id = id;
  card.innerHTML = spec.goal
    ? `<div class="viz-actions kpi-remove">
        <button class="btn btn-icon btn-sm" data-act="remove" title="Remove"><i data-lucide="x" style="width:14px"></i></button>
      </div>
      <div class="kpi-ring" data-kpi-ring>
        <div class="kpi-ring-inner">
          <div class="kpi-v-sm gradient-text" data-kpi-value>—</div>
        </div>
      </div>
      <div class="kpi-l">${spec.title}</div>
      <div class="kpi-goal-note" data-kpi-goal-note></div>`
    : `<div class="viz-actions kpi-remove">
        <button class="btn btn-icon btn-sm" data-act="remove" title="Remove"><i data-lucide="x" style="width:14px"></i></button>
      </div>
      <div class="kpi-v gradient-text" data-kpi-value>—</div>
      <div class="kpi-l">${spec.title}</div>`;
  appendDashboardCard(card);
  card.querySelector('[data-act="remove"]').addEventListener("click", () => removeWidget(id));

  await renderKpiValue(id, spec);
  persistLayout();
  if (window.lucide) lucide.createIcons();
}

function formatKpi(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

async function renderKpiValue(id, spec) {
  const el = document.querySelector(`#${id} [data-kpi-value]`);
  if (!el) return;
  try {
    const data = await api("/api/kpi", {
      method: "POST",
      body: { column: spec.column, agg: spec.agg, filters: activeFilters() },
    });
    el.textContent = formatKpi(data.value);

    if (spec.goal) {
      const ring = document.querySelector(`#${id} [data-kpi-ring]`);
      const note = document.querySelector(`#${id} [data-kpi-goal-note]`);
      const val = typeof data.value === "number" ? data.value : 0;
      const pct = Math.max(0, Math.min(100, Math.round((val / spec.goal) * 100)));
      const color = pct >= 100 ? "#2fbf71" : pct >= 60 ? "#f6a623" : "#e5484d";
      if (ring) ring.style.background = `conic-gradient(${color} ${pct * 3.6}deg, rgba(120,110,180,.18) 0deg)`;
      if (note) note.textContent = `${pct}% of goal (${formatKpi(spec.goal)})`;
    }
  } catch (err) { el.textContent = "—"; }
}

/* ---- Slicer widget ---- */
async function addSlicerWidget(column) {
  const id = "w" + widgetSeq++;
  const spec = { kind: "slicer", column, selected: new Set(), title: `Filter: ${column}` };
  widgets.push({ id, spec });

  const card = document.createElement("div");
  card.className = "viz-card neo slicer-card span-4";
  card.id = id;
  card.innerHTML = `
    <div class="viz-head">
      <h4><i data-lucide="filter" style="width:15px"></i> ${column}</h4>
      ${vizActionsHTML({ clear: true })}
    </div>
    <div class="slicer-body"><span class="muted" style="font-size:.82rem;">Loading values…</span></div>`;
  appendDashboardCard(card);
  wireVizToolbar(card, id);
  addResizeHandle(card, id);

  card.querySelector('[data-act="remove"]').addEventListener("click", async () => {
    removeWidget(id);
    await refreshAll();
  });
  card.querySelector('[data-act="clear"]').addEventListener("click", async () => {
    spec.selected.clear();
    card.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = false));
    persistLayout();
    await refreshAll();
  });

  try {
    const data = await api(`/api/column-values?col=${encodeURIComponent(column)}`);
    const body = card.querySelector(".slicer-body");
    if (!data.values.length) {
      body.innerHTML = `<span class="muted" style="font-size:.82rem;">No values found.</span>`;
    } else {
      body.innerHTML = data.values
        .map((v) => `<label class="slicer-item"><input type="checkbox" value="${escapeAttr(v)}" /> <span>${escapeAttr(v)}</span></label>`)
        .join("");
      body.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.addEventListener("change", async () => {
          if (cb.checked) spec.selected.add(cb.value);
          else spec.selected.delete(cb.value);
          persistLayout();
          await refreshAll();
        });
      });
    }
  } catch (err) { toast(err.message, "err"); }
  if (window.lucide) lucide.createIcons();
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* =========================================================================
   Shared widget toolbar — appears on hover; colour / download / remove live
   inside the "More options" menu so the card stays clean.
   ========================================================================= */
function vizActionsHTML(opts = {}) {
  const { chart = false, color = PALETTE[0], edit = false, clear = false } = opts;
  return `
    <div class="viz-actions">
      ${clear ? `<button class="viz-act" data-act="clear" title="Clear selection"><i data-lucide="rotate-ccw" style="width:14px"></i></button>` : ""}
      ${edit ? `<button class="viz-act" data-act="edit" title="Edit visual"><i data-lucide="pencil" style="width:14px"></i></button>` : ""}
      <button class="viz-act" data-act="focus" title="Focus mode"><i data-lucide="maximize-2" style="width:14px"></i></button>
      <button class="viz-act" data-act="menu" title="More options"><i data-lucide="more-horizontal" style="width:15px"></i></button>
      <div class="viz-menu hidden" data-viz-menu>
        ${chart ? `<label class="viz-menu-item"><i data-lucide="palette" style="width:15px"></i> Colour
                     <input type="color" class="chart-color" value="${color}" /></label>` : ""}
        ${chart ? `<button class="viz-menu-item" data-act="png"><i data-lucide="download" style="width:15px"></i> Download PNG</button>` : ""}
        <button class="viz-menu-item danger" data-act="remove"><i data-lucide="x" style="width:15px"></i> Remove visual</button>
      </div>
    </div>`;
}

function closeAllVizMenus(except) {
  document.querySelectorAll("[data-viz-menu]").forEach((m) => {
    if (m !== except) {
      m.classList.add("hidden");
      const wrap = m.closest(".viz-actions");
      if (wrap) wrap.classList.remove("open");
    }
  });
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".viz-actions")) closeAllVizMenus(null);
});

/* Wires the menu toggle + focus mode. Per-widget [data-act] listeners keep
   working because the buttons simply moved inside the menu. */
function wireVizToolbar(card, id) {
  const menuBtn = card.querySelector('[data-act="menu"]');
  const menu = card.querySelector("[data-viz-menu]");
  const actions = card.querySelector(".viz-actions");
  if (menuBtn && menu) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.classList.contains("hidden");
      closeAllVizMenus(menu);
      menu.classList.toggle("hidden", !willOpen);
      actions.classList.toggle("open", willOpen);
    });
    menu.addEventListener("click", (e) => {
      // Keep the menu open while dragging the colour picker.
      if (e.target.closest("input[type=color]")) return;
      menu.classList.add("hidden");
      actions.classList.remove("open");
    });
  }
  const focusBtn = card.querySelector('[data-act="focus"]');
  if (focusBtn) {
    focusBtn.addEventListener("click", () => {
      const on = card.classList.toggle("focused");
      focusBtn.title = on ? "Exit focus mode" : "Focus mode";
      if (charts[id]) charts[id].resize();
    });
  }
}

/* =========================================================================
   Chart resize handles — drag the bottom-right corner to resize a chart.
   The card switches from CSS grid span to an explicit pixel width/height,
   then Chart.js resize is triggered so the canvas re-renders crisply.
   ========================================================================= */
function updateFreeLayout() {
  const grid = document.getElementById("dashGrid");
  if (!grid.classList.contains("free-layout")) return;
  const canvas = document.getElementById("dashCanvas");
  const padding = parseFloat(getComputedStyle(canvas).paddingTop);
  const bottom = Math.max(0, ...Array.from(grid.children, (card) => (parseFloat(card.style.top) || 0) + card.offsetHeight));
  grid.style.height = `${Math.max(canvas.clientHeight - padding * 2, bottom)}px`;
}

function enableFreeLayout() {
  const grid = document.getElementById("dashGrid");
  if (grid.classList.contains("free-layout")) return;
  const canvas = document.getElementById("dashCanvas");
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.offsetWidth;
  const padding = parseFloat(getComputedStyle(canvas).paddingTop);
  const positions = widgets.map((w) => {
    const card = document.getElementById(w.id);
    const box = card.getBoundingClientRect();
    return { card, x: Number.isFinite(w.spec.cardX) ? w.spec.cardX : (box.left - rect.left) / scale + canvas.scrollLeft - padding,
      y: Number.isFinite(w.spec.cardY) ? w.spec.cardY : (box.top - rect.top) / scale + canvas.scrollTop - padding,
      width: card.offsetWidth, height: card.offsetHeight };
  });
  grid.classList.add("free-layout");
  canvas.classList.add("has-free-layout");
  for (const { card, x, y, width, height } of positions) {
    card.style.width = `${Math.min(width, grid.clientWidth)}px`;
    card.style.height = `${height}px`;
    card.style.left = `${Math.max(0, Math.min(x, grid.clientWidth - card.offsetWidth))}px`;
    card.style.top = `${Math.max(0, y)}px`;
  }
  updateFreeLayout();
}

function appendDashboardCard(card) {
  const grid = document.getElementById("dashGrid");
  const existing = Array.from(grid.children);
  grid.appendChild(card);
  if (grid.classList.contains("free-layout")) {
    const span = card.className.match(/span-(\d+)/);
    const columns = span ? Number(span[1]) : card.classList.contains("kpi-card") ? 3 : 6;
    card.style.width = `${(grid.clientWidth - 12 * (12 / columns - 1)) * columns / 12}px`;
    card.style.height = `${card.offsetHeight}px`;
    const boxes = existing.map((el) => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: el.offsetWidth, h: el.offsetHeight }));
    const xs = [0, ...boxes.map((b) => b.x + b.w + 12)].sort((a, b) => a - b);
    const ys = [0, ...boxes.map((b) => b.y + b.h + 12)].sort((a, b) => a - b);
    const spot = ys.flatMap((y) => xs.map((x) => ({ x, y }))).find(({ x, y }) =>
      x + card.offsetWidth <= grid.clientWidth && !boxes.some((b) =>
        x < b.x + b.w + 12 && x + card.offsetWidth + 12 > b.x && y < b.y + b.h + 12 && y + card.offsetHeight + 12 > b.y));
    card.style.left = `${spot ? spot.x : 0}px`;
    card.style.top = `${spot ? spot.y : grid.offsetHeight + 12}px`;
    updateFreeLayout();
  }
  addMoveHandle(card);
  renderChartBackgroundControls();
}

function moveWidget(card, x, y) {
  const grid = document.getElementById("dashGrid");
  card.style.left = `${Math.max(0, Math.min(x, grid.clientWidth - card.offsetWidth))}px`;
  card.style.top = `${Math.max(0, Math.min(y, grid.clientHeight - card.offsetHeight))}px`;
}

function addMoveHandle(card) {
  if (readOnly || card.querySelector(".move-handle")) return;
  const actions = card.querySelector(".viz-actions");
  if (!actions) return;
  const handle = document.createElement("button");
  handle.className = "viz-act move-handle";
  handle.type = "button";
  handle.title = "Drag to move chart; arrow keys move 10px, Shift + arrow moves 1px";
  handle.setAttribute("aria-label", "Move chart");
  handle.innerHTML = '<i data-lucide="move" style="width:14px"></i>';
  actions.prepend(handle);
  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary || card.classList.contains("focused")) return;
    e.preventDefault();
    e.stopPropagation();
    enableFreeLayout();
    closeAllVizMenus(null);
    drag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, left: parseFloat(card.style.left), top: parseFloat(card.style.top),
      scale: card.getBoundingClientRect().width / card.offsetWidth };
    handle.setPointerCapture(e.pointerId);
    handle.focus({ preventScroll: true });
    card.classList.add("moving");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    moveWidget(card, drag.left + (e.clientX - drag.x) / drag.scale, drag.top + (e.clientY - drag.y) / drag.scale);
  });
  const finish = (cancel = false) => {
    if (!drag) return;
    if (cancel) moveWidget(card, drag.left, drag.top);
    const pointer = drag.pointer;
    drag = null;
    card.classList.remove("moving");
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    persistLayout();
  };
  handle.addEventListener("pointerup", () => finish());
  handle.addEventListener("pointercancel", () => finish(true));
  handle.addEventListener("lostpointercapture", () => finish());
  handle.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { finish(true); return; }
    if (drag || card.classList.contains("focused")) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!delta) return;
    e.preventDefault();
    enableFreeLayout();
    const step = e.shiftKey ? 1 : 10;
    moveWidget(card, parseFloat(card.style.left) + delta[0] * step, parseFloat(card.style.top) + delta[1] * step);
    persistLayout();
  });
}

function addResizeHandle(card, id) {
  if (readOnly) return;
  addMoveHandle(card);
  const handle = document.createElement("div");
  handle.className = "resize-handle";
  card.appendChild(handle);

  let dragging = false, startX = 0, startY = 0, startW = 0, startH = 0, scale = 1, maxW = 0, maxH = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || card.classList.contains("focused")) return;
    enableFreeLayout();
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = card.getBoundingClientRect();
    startW = card.offsetWidth;
    startH = card.offsetHeight;
    scale = rect.width / startW;
    const grid = document.getElementById("dashGrid");
    maxW = grid.clientWidth - parseFloat(card.style.left);
    maxH = grid.clientHeight - parseFloat(card.style.top);
    card.classList.add("resizing");
    document.body.style.cursor = "se-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = (e.clientX - startX) / scale;
    const dy = (e.clientY - startY) / scale;
    const newW = Math.min(maxW, Math.max(200, startW + dx));
    const newH = Math.min(maxH, Math.max(160, startH + dy));
    card.style.width = `${newW}px`;
    card.style.height = `${newH}px`;
    card.style.gridColumn = "span 12"; // break out of grid span when manually sized
    if (charts[id]) charts[id].resize();
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    updateFreeLayout();
    persistLayout();
  });
}

/* ---- Pivot table widget ---- */
async function addPivotWidget(spec) {
  const id = "w" + widgetSeq++;
  spec = Object.assign({ kind: "pivot", agg: "count", title: "Pivot table" }, spec);
  widgets.push({ id, spec });

  const card = document.createElement("div");
  card.className = "viz-card neo span-12 pivot-card";
  card.id = id;
  card.innerHTML = `
    <div class="viz-head">
      <h4><i data-lucide="table-2" style="width:15px"></i> ${spec.title}</h4>
      ${vizActionsHTML({})}
    </div>
    <div class="table-wrap pivot-wrap"><table class="data"><thead></thead><tbody></tbody></table></div>`;
  appendDashboardCard(card);
  wireVizToolbar(card, id);
  addResizeHandle(card, id);
  card.querySelector('[data-act="remove"]').addEventListener("click", () => removeWidget(id));

  await renderPivot(id, spec);
  persistLayout();
  if (window.lucide) lucide.createIcons();
}

async function renderPivot(id, spec) {
  const card = document.getElementById(id);
  if (!card) return;
  try {
    const data = await api("/api/pivot", {
      method: "POST",
      body: { index: spec.index, columns: spec.columns, values: spec.values, agg: spec.agg, filters: activeFilters() },
    });
    const thead = card.querySelector("thead");
    const tbody = card.querySelector("tbody");
    if (!data.columns.length) {
      thead.innerHTML = "";
      tbody.innerHTML = `<tr><td class="muted">No data for this pivot.</td></tr>`;
      return;
    }
    thead.innerHTML = "<tr>" + data.columns.map((c) => `<th>${escapeAttr(c)}</th>`).join("") + "</tr>";
    tbody.innerHTML = data.rows
      .map((r) => "<tr>" + r.map((c, i) => `<td${i === 0 ? ' style="font-weight:600"' : ""}>${c === null ? "" : escapeAttr(c)}</td>`).join("") + "</tr>")
      .join("");
  } catch (err) { toast(err.message, "err"); }
}

/* ---- Geo distribution widget (ranked leaderboard) ---- */
async function addGeoWidget(spec) {
  const id = "w" + widgetSeq++;
  spec = Object.assign({ kind: "geo", agg: "count", title: "Geo distribution" }, spec);
  widgets.push({ id, spec });

  const card = document.createElement("div");
  card.className = "viz-card neo span-6 geo-card";
  card.id = id;
  card.innerHTML = `
    <div class="viz-head">
      <h4><i data-lucide="globe" style="width:15px"></i> ${spec.title}</h4>
      ${vizActionsHTML({})}
    </div>
    <div class="geo-list" data-geo-list><span class="muted" style="font-size:.82rem;">Loading…</span></div>`;
  appendDashboardCard(card);
  wireVizToolbar(card, id);
  addResizeHandle(card, id);
  card.querySelector('[data-act="remove"]').addEventListener("click", () => removeWidget(id));

  await renderGeo(id, spec);
  persistLayout();
  if (window.lucide) lucide.createIcons();
}

async function renderGeo(id, spec) {
  const list = document.querySelector(`#${id} [data-geo-list]`);
  if (!list) return;
  try {
    const data = await api("/api/geo-data", {
      method: "POST",
      body: { column: spec.column, value_col: spec.value_col, agg: spec.agg, filters: activeFilters() },
    });
    if (!data.regions.length) {
      list.innerHTML = `<span class="muted" style="font-size:.82rem;">No geo data found.</span>`;
      return;
    }
    list.innerHTML = data.regions
      .map(
        (r) => `<div class="geo-row" data-region="${escapeAttr(r.name)}">
          <div class="geo-row-top"><span>${escapeAttr(r.name)}</span><span>${formatKpi(r.value)}</span></div>
          <div class="geo-bar-track"><div class="geo-bar-fill" style="width:${r.pct}%"></div></div>
        </div>`
      )
      .join("");
    list.querySelectorAll(".geo-row").forEach((row) => {
      row.addEventListener("click", () => addDrillFilter(spec.column, row.dataset.region));
    });
  } catch (err) { toast(err.message, "err"); }
}

function removeWidget(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const el = document.getElementById(id);
  if (el) el.remove();
  widgets = widgets.filter((w) => w.id !== id);
  renderChartBackgroundControls();
  updateFreeLayout();
  persistLayout();
}

async function renderChart(id, spec) {
  const canvas = document.querySelector(`#${id} canvas`);
  if (!canvas) return;
  let payload;
  try {
    payload = await api("/api/chart-data", {
      method: "POST",
      body: { type: spec.type, x: spec.x, y: spec.y, agg: spec.agg, filters: activeFilters() },
    });
  } catch (err) { toast(err.message, "err"); return; }

  const cfg = buildChartConfig(spec, payload);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(canvas, cfg);
  charts[id].__payload = payload;
}

function buildChartConfig(spec, payload) {
  const type = spec.type;
  const drillable = ["bar", "pie", "doughnut"].includes(type);
  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: ["pie", "doughnut"].includes(type), position: "bottom" },
    },
    onClick: drillable
      ? (evt, elements, chart) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          const label = chart.data.labels[idx];
          if (label !== undefined && spec.x) addDrillFilter(spec.x, label);
        }
      : undefined,
    onHover: drillable
      ? (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : "default"; }
      : undefined,
  };

  const base = spec.color || PALETTE[0];

  if (type === "scatter") {
    return {
      type: "scatter",
      data: {
        datasets: [{
          label: spec.title,
          data: payload.points || [],
          backgroundColor: base + "cc",
        }],
      },
      options: Object.assign(baseOptions, {
        scales: { x: { title: { display: true, text: spec.x } }, y: { title: { display: true, text: spec.y } } },
      }),
    };
  }

  const labels = payload.labels || [];
  const values = payload.values || [];
  const isCircular = ["pie", "doughnut"].includes(type);
  const colors = spec.color ? makeShades(base, labels.length) : labels.map((_, i) => PALETTE[i % PALETTE.length]);

  return {
    type: type === "histogram" ? "bar" : type,
    data: {
      labels,
      datasets: [{
        label: spec.y ? `${spec.agg} of ${spec.y}` : "count",
        data: values,
        backgroundColor: isCircular ? colors : base + (type === "line" ? "22" : "cc"),
        borderColor: type === "line" ? base : (isCircular ? "#fff" : base),
        borderWidth: type === "line" ? 3 : isCircular ? 2 : 0,
        borderRadius: type === "bar" || type === "histogram" ? 8 : 0,
        fill: type === "line",
        tension: 0.35,
        pointRadius: type === "line" ? 3 : 0,
      }],
    },
    options: baseOptions,
  };
}

/* ---------------- Auto-build ---------------- */
async function autoBuild() {
  try {
    const data = await api("/api/recommend");
    const top = data.recommendations.slice(0, 4);
    for (const rec of top) await addWidget(rec);
  } catch (_) {}
}

document.getElementById("autoBuildBtn").addEventListener("click", async () => {
  clearDashboard();
  await autoBuild();
  toast("Auto-built dashboard from recommendations");
});

document.getElementById("clearBtn").addEventListener("click", () => {
  clearDashboard();
  toast("Dashboard cleared");
});

function clearDashboard() {
  Object.values(charts).forEach((c) => c.destroy());
  charts = {};
  widgets = [];
  const grid = document.getElementById("dashGrid");
  grid.innerHTML = "";
  grid.classList.remove("free-layout");
  grid.style.height = "";
  document.getElementById("dashCanvas").classList.remove("has-free-layout");
  renderChartBackgroundControls();
  persistLayout();
}

/* ---------------- Modal ---------------- */
const modal = document.getElementById("modal");
const mType = document.getElementById("mType");
const mX = document.getElementById("mX");
const mY = document.getElementById("mY");
const mAgg = document.getElementById("mAgg");
const aggField = document.getElementById("aggField");

function populateModalSelects() {
  const all = profile.columns.map((c) => c.name);
  const numeric = profile.columns.filter((c) => c.kind === "numeric").map((c) => c.name);
  const opts = (cols) => cols.map((c) => `<option value="${escapeAttr(c)}">${escapeAttr(c)}</option>`).join("");

  mX.innerHTML = opts(all);
  mY.innerHTML = `<option value="">(none / count)</option>` + opts(numeric);

  // KPI modal
  document.getElementById("kCol").innerHTML = `<option value="">(whole dataset)</option>` + opts(all);
  // Slicer modal — prefer low-cardinality columns first
  const sliceCols = [...profile.columns].sort((a, b) => a.unique - b.unique).map((c) => c.name);
  document.getElementById("sCol").innerHTML = opts(sliceCols);
  // Pivot modal
  document.getElementById("pIndex").innerHTML = opts(all);
  document.getElementById("pCols").innerHTML = `<option value="">(none)</option>` + opts(all);
  document.getElementById("pVals").innerHTML = `<option value="">(none / count)</option>` + opts(numeric);
  // Geo modal
  document.getElementById("gVal").innerHTML = `<option value="">(none / count)</option>` + opts(numeric);
  api("/api/geo-columns").then((data) => {
    const gCol = document.getElementById("gCol");
    gCol.innerHTML = (data.columns.length ? opts(data.columns) : opts(all));
  }).catch(() => {
    document.getElementById("gCol").innerHTML = opts(all);
  });
}

function updateModalFields() {
  const t = mType.value;
  const isScatter = t === "scatter";
  const isHist = t === "histogram";
  document.getElementById("xLabel").textContent = isScatter ? "X axis (numeric)" : isHist ? "Numeric column" : "Category / X axis";
  document.getElementById("yLabel").textContent = isScatter ? "Y axis (numeric)" : "Value / Y axis";
  mY.parentElement.style.display = isHist ? "none" : "block";
  aggField.style.display = isScatter || isHist ? "none" : "block";
}

mType.addEventListener("change", updateModalFields);

document.getElementById("mCancel").addEventListener("click", () => modal.classList.remove("open"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("open"); });

document.getElementById("mAdd").addEventListener("click", () => {
  const spec = {
    type: mType.value,
    x: mX.value,
    y: mY.value || null,
    agg: mAgg.value,
    title: document.getElementById("mTitle").value.trim() || `${mType.value} of ${mX.value}`,
  };
  addWidget(spec);
  modal.classList.remove("open");
  document.getElementById("mTitle").value = "";
});

/* ---- KPI / Slicer / Pivot modals ---- */
function wireModal(modalId, openBtnId, cancelBtnId) {
  const m = document.getElementById(modalId);
  if (openBtnId) document.getElementById(openBtnId).addEventListener("click", () => m.classList.add("open"));
  document.getElementById(cancelBtnId).addEventListener("click", () => m.classList.remove("open"));
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("open"); });
  return m;
}

const kpiModal = wireModal("kpiModal", null, "kCancel");
document.getElementById("kAdd").addEventListener("click", () => {
  const column = document.getElementById("kCol").value || null;
  const agg = document.getElementById("kAgg").value;
  const title = document.getElementById("kTitle").value.trim() || (column ? `${agg} of ${column}` : "Row count");
  const goalRaw = document.getElementById("kGoal").value;
  const goal = goalRaw ? Number(goalRaw) : null;
  addKpiWidget({ column, agg: column ? agg : "count_rows", title, goal });
  kpiModal.classList.remove("open");
  document.getElementById("kTitle").value = "";
  document.getElementById("kGoal").value = "";
});

const slicerModal = wireModal("slicerModal", null, "sCancel");
document.getElementById("sAdd").addEventListener("click", () => {
  addSlicerWidget(document.getElementById("sCol").value);
  slicerModal.classList.remove("open");
});

const pivotModal = wireModal("pivotModal", "addPivotBtn", "pCancel");
document.getElementById("pAdd").addEventListener("click", () => {
  const index = document.getElementById("pIndex").value;
  const columns = document.getElementById("pCols").value || null;
  const values = document.getElementById("pVals").value || null;
  const agg = document.getElementById("pAgg").value;
  const title = document.getElementById("pTitle").value.trim() || `Pivot: ${index}${columns ? " × " + columns : ""}`;
  addPivotWidget({ index, columns, values, agg, title });
  pivotModal.classList.remove("open");
  document.getElementById("pTitle").value = "";
});

/* ---- Geo modal ---- */
const geoModal = wireModal("geoModal", "addGeoBtn", "gCancel");
document.getElementById("gAdd").addEventListener("click", () => {
  const column = document.getElementById("gCol").value;
  const value_col = document.getElementById("gVal").value || null;
  const agg = document.getElementById("gAgg").value;
  const title = document.getElementById("gTitle").value.trim() || `Geo: ${column}`;
  addGeoWidget({ column, value_col, agg: value_col ? agg : "count", title });
  geoModal.classList.remove("open");
  document.getElementById("gTitle").value = "";
});

/* ---- AI Insight cards ---- */
const insightModal = wireModal("insightModal", "insightCardsBtn", "insightModalCancel");
document.getElementById("insightCardsBtn").addEventListener("click", async () => {
  const list = document.getElementById("insightModalList");
  list.innerHTML = `<span class="muted">Scanning dataset…</span>`;
  try {
    const data = await api("/api/insights");
    if (!data.insights.length) {
      list.innerHTML = `<span class="muted">No notable anomalies detected — data looks clean.</span>`;
      return;
    }
    list.innerHTML = data.insights
      .map(
        (i, idx) => `<div class="history-item">
          <div class="hi-main">
            <span class="hi-idx sev-${i.severity}">${i.severity}</span>
            <span class="hi-msg"><b>${escapeAttr(i.title)}</b><br/><span class="muted" style="font-size:.8rem;">${escapeAttr(i.description)}</span></span>
          </div>
          <button class="btn btn-sm btn-primary" data-idx="${idx}">Add card</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ins = data.insights[Number(btn.dataset.idx)];
        addInsightWidget(ins);
        toast(`Added insight card: ${ins.title}`);
      });
    });
  } catch (err) {
    list.innerHTML = `<span class="muted">${err.message}</span>`;
  }
});

function addInsightWidget(insight) {
  const id = "w" + widgetSeq++;
  const spec = { kind: "insight", title: insight.title, description: insight.description, severity: insight.severity };
  widgets.push({ id, spec });
  const card = document.createElement("div");
  card.className = `viz-card neo span-4 insight-widget sev-${insight.severity}`;
  card.id = id;
  card.innerHTML = `
    <div class="viz-head">
      <h4><i data-lucide="sparkles" style="width:15px"></i> Insight</h4>
      <div class="viz-actions">
        <button class="btn btn-icon btn-sm" data-act="remove" title="Remove"><i data-lucide="x" style="width:15px"></i></button>
      </div>
    </div>
    <div class="insight-widget-body">
      <div class="ic-title">${escapeAttr(insight.title)}</div>
      <div class="ic-desc">${escapeAttr(insight.description)}</div>
    </div>`;
  appendDashboardCard(card);
  card.querySelector('[data-act="remove"]').addEventListener("click", () => removeWidget(id));
  if (window.lucide) lucide.createIcons();
}

/* ---- Scheduled auto-refresh ---- */
const refreshModal = wireModal("refreshModal", "refreshBtn", "refreshCancel");
document.getElementById("refreshStart").addEventListener("click", () => {
  const url = document.getElementById("refreshUrl").value.trim();
  const interval = Math.max(10, Number(document.getElementById("refreshInterval").value) || 60);
  if (!url) return toast("Enter a source URL", "err");
  if (refreshTimer) clearInterval(refreshTimer);
  const doRefresh = async () => {
    try {
      const data = await api("/api/refresh-url", { method: "POST", body: { url } });
      Session.set(data.session_id);
      profile = data.profile;
      renderKpis();
      populateModalSelects();
      await refreshAll();
      toast(data.message);
    } catch (err) { toast(err.message, "err"); }
  };
  doRefresh();
  refreshTimer = setInterval(doRefresh, interval * 1000);
  toast(`Auto-refresh started (every ${interval}s)`);
  refreshModal.classList.remove("open");
});
document.getElementById("refreshStop").addEventListener("click", () => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; toast("Auto-refresh stopped"); }
});

/* ---- Share link ---- */
const shareModal = wireModal("shareModal", "shareBtn", "shareCancel");
document.getElementById("shareBtn").addEventListener("click", () => {
  const link = `${window.location.origin}/dashboard.html?sid=${Session.get()}&view=1`;
  document.getElementById("shareLink").value = link;
});
document.getElementById("shareCopy").addEventListener("click", async () => {
  const val = document.getElementById("shareLink").value;
  try { await navigator.clipboard.writeText(val); toast("Link copied"); } catch (_) { toast("Copy failed", "err"); }
});

/* ---- Embed snippet ---- */
const embedModal = wireModal("embedModal", "embedBtn", "embedCancel");
document.getElementById("embedBtn").addEventListener("click", () => {
  const src = `${window.location.origin}/dashboard.html?sid=${Session.get()}&embed=1`;
  document.getElementById("embedSnippet").value =
    `<iframe src="${src}" width="100%" height="700" style="border:0;border-radius:12px;" loading="lazy"></iframe>`;
});
document.getElementById("embedCopy").addEventListener("click", async () => {
  const val = document.getElementById("embedSnippet").value;
  try { await navigator.clipboard.writeText(val); toast("Snippet copied"); } catch (_) { toast("Copy failed", "err"); }
});

/* ---- PPTX slide-deck export ---- */
document.getElementById("exportPptxBtn").addEventListener("click", async () => {
  if (!widgets.length) return toast("Add some charts first", "err");
  toast("Building slide deck…");
  const slides = [];
  for (const w of widgets) {
    if (w.spec.kind === "slicer") continue; // slicers are controls, not content
    if (w.spec.kind === "kpi") {
      const valEl = document.querySelector(`#${w.id} [data-kpi-value]`);
      slides.push({ title: w.spec.title, kind: "kpi", value: valEl ? valEl.textContent : "" });
    } else if (charts[w.id]) {
      slides.push({ title: w.spec.title, kind: "chart", image: charts[w.id].toBase64Image("image/png", 1) });
    } else {
      // geo / pivot / other DOM-based widgets — capture the card body as an image
      const bodyEl = document.querySelector(`#${w.id} .geo-list, #${w.id} .pivot-wrap, #${w.id} .viz-body`) || document.getElementById(w.id);
      try {
        const canvas = await html2canvas(bodyEl, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
        slides.push({ title: w.spec.title, kind: "chart", image: canvas.toDataURL("image/png") });
      } catch (_) { /* skip if capture fails */ }
    }
  }
  try {
    const blob = await api("/api/pptx", { method: "POST", body: { title: `${Session.filename()} Dashboard`, slides, logo: dashboardLogo } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${Session.filename()}_slides.pptx`;
    a.click();
    URL.revokeObjectURL(url);
    toast("PPTX downloaded");
  } catch (err) { toast(err.message, "err"); }
});

/* =========================================================================
   Power BI-style visuals — created from the "Build visual" gallery.
   These widgets use spec.kind === "visual" and spec.type === a VISUAL_TYPES id.
   ========================================================================= */
async function addVisualWidget(spec) {
  const id = "w" + widgetSeq++;
  const def = visualById(spec.type);
  spec = Object.assign({ kind: "visual", agg: "count", color: PALETTE[0] }, spec);
  if (!spec.title) spec.title = def ? def.label : "Visual";
  if ((spec.type === "slicer" || spec.type === "button_slicer") && !(spec.selected instanceof Set)) {
    spec.selected = new Set(Array.isArray(spec.selected) ? spec.selected : []);
  }
  widgets.push({ id, spec });

  const isChart = def && def.render === "chart";
  const card = document.createElement("div");
  card.className = `viz-card neo ${visualSpan(spec.type)}`;
  card.id = id;
  card.innerHTML = `
    <div class="viz-head">
      <h4>${escapeAttr(spec.title)}</h4>
      ${vizActionsHTML({ chart: isChart, color: spec.color, edit: true })}
    </div>
    ${visualBodyHTML(spec)}`;
  appendDashboardCard(card);
  wireVisualActions(card, id, spec);
  addResizeHandle(card, id);

  await renderVisualWidget(id, spec);
  persistLayout();
  if (window.lucide) lucide.createIcons();
}

function wireVisualActions(card, id, spec) {
  wireVizToolbar(card, id);
  card.querySelector('[data-act="remove"]').addEventListener("click", async () => {
    const wasFilter = isSlicerSpec(spec);
    removeWidget(id);
    if (wasFilter) await refreshAll();
  });
  card.querySelector('[data-act="edit"]').addEventListener("click", () => startEditVisual(id));
  const pngBtn = card.querySelector('[data-act="png"]');
  if (pngBtn) pngBtn.addEventListener("click", () => downloadChartPng(id, spec.title));
  const colorInput = card.querySelector(".chart-color");
  if (colorInput) {
    colorInput.addEventListener("input", async (e) => {
      spec.color = e.target.value;
      await renderVisualWidget(id, spec);
      persistLayout();
    });
  }
}

function visualBodyHTML(spec) {
  switch (spec.type) {
    case "treemap":       return `<div class="viz-body tm-wrap" data-visual-body></div>`;
    case "card":          return `<div class="viz-body card-visual" data-visual-body></div>`;
    case "kpi_card":      return `<div class="viz-body card-visual" data-visual-body></div>`;
    case "slicer":        return `<div class="viz-body slicer-body" data-visual-body></div>`;
    case "button_slicer": return `<div class="viz-body bslicer-body" data-visual-body></div>`;
    case "image":         return `<div class="viz-body image-visual" data-visual-body></div>`;
    default:              return `<div class="viz-body"><canvas></canvas></div>`;
  }
}

async function renderVisualWidget(id, spec) {
  const card = document.getElementById(id);
  if (!card) return;
  const body = card.querySelector("[data-visual-body]");

  /* ---- Image: pure client-side ---- */
  if (spec.type === "image") {
    body.innerHTML = spec.image
      ? `<img src="${spec.image}" alt="${escapeAttr(spec.title)}" />`
      : `<span class="iv-empty">No image chosen — edit this visual to upload one.</span>`;
    return;
  }

  /* ---- Slicer / button slicer: distinct values as filters ---- */
  if (spec.type === "slicer" || spec.type === "button_slicer") {
    if (!spec.column) { body.innerHTML = `<span class="muted" style="font-size:.8rem;">Add a field to this slicer.</span>`; return; }
    try {
      const data = await api(`/api/column-values?col=${encodeURIComponent(spec.column)}`);
      if (!data.values.length) { body.innerHTML = `<span class="muted" style="font-size:.8rem;">No values found.</span>`; return; }
      if (spec.type === "button_slicer") {
        body.innerHTML = data.values
          .map((v) => `<button class="bslicer-btn ${spec.selected.has(String(v)) ? "on" : ""}" data-val="${escapeAttr(v)}">${escapeAttr(v)}</button>`)
          .join("");
        body.querySelectorAll(".bslicer-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const v = btn.dataset.val;
            if (spec.selected.has(v)) { spec.selected.delete(v); btn.classList.remove("on"); }
            else { spec.selected.add(v); btn.classList.add("on"); }
            persistLayout();
            await refreshAll();
          });
        });
      } else {
        body.innerHTML = data.values
          .map((v) => `<label class="slicer-item"><input type="checkbox" value="${escapeAttr(v)}" ${spec.selected.has(String(v)) ? "checked" : ""} /> <span>${escapeAttr(v)}</span></label>`)
          .join("");
        body.querySelectorAll("input[type=checkbox]").forEach((cb) => {
          cb.addEventListener("change", async () => {
            if (cb.checked) spec.selected.add(cb.value);
            else spec.selected.delete(cb.value);
            persistLayout();
            await refreshAll();
          });
        });
      }
    } catch (err) { body.innerHTML = `<span class="muted" style="font-size:.8rem;">${escapeAttr(err.message)}</span>`; }
    return;
  }

  /* ---- Card / KPI card: single aggregated value ---- */
  if (spec.type === "card" || spec.type === "kpi_card") {
    try {
      const data = await api("/api/kpi", {
        method: "POST",
        body: { column: spec.y, agg: spec.y ? (spec.agg === "count" ? "count" : spec.agg) : "count_rows", filters: activeFilters() },
      });
      const label = spec.y ? `${spec.agg} of ${spec.y}` : "Row count";
      if (spec.type === "kpi_card" && spec.goal) {
        const val = typeof data.value === "number" ? data.value : 0;
        const pct = Math.max(0, Math.min(100, Math.round((val / spec.goal) * 100)));
        const color = pct >= 100 ? "#2fbf71" : pct >= 60 ? "#f6a623" : "#e5484d";
        body.innerHTML = `
          <div class="kpi-ring" style="background:conic-gradient(${color} ${pct * 3.6}deg, rgba(120,110,180,.18) 0deg)">
            <div class="kpi-ring-inner"><div class="kpi-v-sm gradient-text" data-kpi-value>${formatKpi(data.value)}</div></div>
          </div>
          <div class="cv-label">${escapeAttr(label)}</div>
          <div class="kpi-goal-note">${pct}% of goal (${formatKpi(spec.goal)})</div>`;
      } else {
        body.innerHTML = `
          <div class="cv-value gradient-text" data-kpi-value>${formatKpi(data.value)}</div>
          <div class="cv-label">${escapeAttr(label)}</div>`;
      }
    } catch (_) { body.innerHTML = `<div class="cv-value" data-kpi-value>—</div>`; }
    return;
  }

  /* ---- Everything else needs an aggregated payload ---- */
  if (!spec.x) {
    if (body) body.innerHTML = `<span class="muted" style="font-size:.8rem;">Add a field to the X-axis.</span>`;
    return;
  }
  let payload;
  try {
    payload = await api("/api/chart-data", {
      method: "POST",
      body: {
        type: spec.type, x: spec.x, y: spec.y, agg: spec.agg,
        series: spec.series, y2: spec.y2, agg2: spec.agg2, filters: activeFilters(),
      },
    });
  } catch (err) { toast(err.message, "err"); return; }

  /* ---- Treemap (DOM) ---- */
  if (spec.type === "treemap") {
    body.innerHTML = renderTreemapHTML(payload, { palette: spec.color ? makeShades(spec.color, (payload.labels || []).length) : PALETTE });
    body.querySelectorAll(".tm-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const label = tile.querySelector(".tm-label");
        if (label && spec.x) addDrillFilter(spec.x, label.textContent);
      });
    });
    return;
  }

  /* ---- Chart.js visuals ---- */
  const canvas = card.querySelector("canvas");
  if (!canvas) return;
  const cfg = buildVisualConfig(spec, payload, {
    palette: PALETTE,
    shades: makeShades,
    onDrill: (col, label) => addDrillFilter(col, label),
  });
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(canvas, cfg);
  charts[id].__payload = payload;
}

/* ---------------- Build-visual pane ---------------- */
let selectedVisual = "stacked_column";
let vizFields = { x: null, y: null, series: null, y2: null, field: null };
let editingVisualId = null;
let pendingVisualImage = null;

function renderVizGallery() {
  const grid = document.getElementById("vizGallery");
  if (!grid) return;
  grid.innerHTML = VISUAL_TYPES
    .map((v) => `<button class="viz-ico ${v.id === selectedVisual ? "active" : ""}" data-viz="${v.id}" title="${v.label}">${v.icon}</button>`)
    .join("");
  grid.querySelectorAll(".viz-ico").forEach((btn) => {
    btn.addEventListener("click", () => selectVisual(btn.dataset.viz));
  });
}

function selectVisual(id) {
  selectedVisual = id;
  document.querySelectorAll("#vizGallery .viz-ico").forEach((b) => b.classList.toggle("active", b.dataset.viz === id));
  const def = visualById(id);
  if (def) {
    const titleEl = document.getElementById("vizTitle");
    if (!editingVisualId && (!titleEl.value || titleEl.dataset.auto === "1")) {
      titleEl.value = def.label;
      titleEl.dataset.auto = "1";
    }
  }
  syncWellsUI();
}

function syncWellsUI() {
  const wells = visualWells(selectedVisual);
  document.querySelectorAll("#wellsArea .well-group").forEach((g) => {
    g.classList.toggle("hidden", !wells.includes(g.dataset.well));
  });
  document.getElementById("vizAggField").classList.toggle("hidden", !(wells.includes("y") || wells.includes("y2")));
  document.getElementById("vizGoalField").classList.toggle("hidden", selectedVisual !== "kpi_card");
  document.getElementById("vizImageField").classList.toggle("hidden", selectedVisual !== "image");
  renderWellChips();
}

function wellChipLabel(key, col) {
  if (!col) return "";
  if (key === "y" || key === "y2") {
    const agg = document.getElementById("vizAgg") ? document.getElementById("vizAgg").value : "count";
    const aggLabel = { count: "Count", sum: "Sum", mean: "Average", max: "Max", min: "Min", median: "Median" }[agg] || agg;
    return `${aggLabel} of ${col}`;
  }
  return col;
}

function renderWellChips() {
  document.querySelectorAll("#wellsArea .well[data-well-drop]").forEach((well) => {
    const key = well.dataset.wellDrop;
    const col = vizFields[key];
    if (col) {
      const label = wellChipLabel(key, col);
      well.innerHTML = `
        <span class="well-chip">
          <span class="chip-name" title="${escapeAttr(label)}">${escapeAttr(label)}</span>
          <button class="well-chip-btn" data-act="agg-menu" title="Change aggregation">
            <i data-lucide="chevron-down" style="width:13px"></i>
          </button>
          <button class="well-chip-btn remove" data-clear="${escapeAttr(key)}" title="Remove field">
            <i data-lucide="x" style="width:12px"></i>
          </button>
        </span>`;
      const clr = well.querySelector("[data-clear]");
      if (clr) clr.addEventListener("click", () => { vizFields[key] = null; renderWellChips(); });
    } else {
      well.innerHTML = `<span class="well-hint">Add data fields here</span>`;
    }
  });
  syncDataCheckboxes();
  if (window.lucide) lucide.createIcons();
}

function setVizField(key, column) {
  if (!visualWells(selectedVisual).includes(key)) return;
  vizFields[key] = column;
  // Choosing a measure with "count" selected is rarely what people want.
  if ((key === "y" || key === "y2") && document.getElementById("vizAgg").value === "count") {
    const col = (profile.columns || []).find((c) => c.name === column);
    if (col && col.kind === "numeric") document.getElementById("vizAgg").value = "sum";
  }
  renderWellChips();
}

function nextEmptyWell() {
  return visualWells(selectedVisual).find((k) => !vizFields[k]) || visualWells(selectedVisual)[0];
}

function initWellDropZones() {
  document.querySelectorAll("#wellsArea .well[data-well-drop]").forEach((well) => {
    well.addEventListener("dragover", (e) => { e.preventDefault(); well.classList.add("drag-over"); });
    well.addEventListener("dragleave", () => well.classList.remove("drag-over"));
    well.addEventListener("drop", (e) => {
      e.preventDefault();
      well.classList.remove("drag-over");
      const col = e.dataTransfer.getData("text/plain");
      if (col) setVizField(well.dataset.wellDrop, col);
    });
  });
}

/* ---------------- Data pane (checkbox tree, Power BI style) ---------------- */
function colKindIcon(kind) {
  if (kind === "numeric") return `<span class="col-kind sigma" title="Numeric">&Sigma;</span>`;
  if (kind === "datetime") return `<i data-lucide="calendar" class="col-kind dt-icon" style="width:12px" title="Date/Time"></i>`;
  return `<span class="col-kind" title="Text"></span>`;
}

function renderDataPane(filterText = "") {
  const list = document.getElementById("dataColList");
  if (!list || !profile) return;
  const filename = (typeof Session !== "undefined" && Session.filename) ? Session.filename() : "Dataset";
  document.getElementById("dataSetName").textContent = filename;

  const q = filterText.trim().toLowerCase();
  const cols = profile.columns.filter((c) => !q || c.name.toLowerCase().includes(q));

  if (!cols.length) {
    list.innerHTML = `<span class="muted" style="font-size:.78rem; padding:6px 9px; display:block;">No matching columns.</span>`;
  } else {
    list.innerHTML = cols.map((c) => {
      const isDatetime = c.kind === "datetime";
      return `<label class="data-col" draggable="true" data-col="${escapeAttr(c.name)}" title="${escapeAttr(c.name)} (${c.kind})">
        <input type="checkbox" data-col-check="${escapeAttr(c.name)}" />
        ${colKindIcon(c.kind)}
        <span class="col-name">${escapeAttr(c.name)}</span>
        ${isDatetime ? `<button class="col-expand" title="Date hierarchy" onclick="event.preventDefault();event.stopPropagation()">
            <i data-lucide="chevron-right" style="width:11px"></i>
          </button>` : ""}
      </label>`;
    }).join("");
  }

  list.querySelectorAll(".data-col").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", el.dataset.col);
      e.dataTransfer.effectAllowed = "copy";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });

  list.querySelectorAll("[data-col-check]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const col = cb.dataset.colCheck;
      if (cb.checked) setVizField(nextEmptyWell(), col);
      else Object.keys(vizFields).forEach((k) => { if (vizFields[k] === col) vizFields[k] = null; });
      renderWellChips();
    });
  });

  syncDataCheckboxes();
  if (window.lucide) lucide.createIcons();
}

/* Keeps the Data pane ticks in step with whatever sits in the wells. */
function syncDataCheckboxes() {
  const used = new Set(Object.values(vizFields).filter(Boolean));
  document.querySelectorAll("[data-col-check]").forEach((cb) => {
    cb.checked = used.has(cb.dataset.colCheck);
  });
}

/* =========================================================================
   Canvas zoom
   ========================================================================= */
let canvasZoom = 1;
let canvasFitMode = true;

function zoomStorageKey() {
  return `dp_zoom:${Session.get()}`;
}

function applyCanvasZoom(persist = true) {
  const canvas = document.getElementById("dashCanvas");
  if (!canvas) return;
  canvas.style.zoom = canvasZoom;
  const pct = Math.round(canvasZoom * 100);
  const slider = document.getElementById("zoomSlider");
  const label = document.getElementById("zoomPct");
  if (slider) slider.value = pct;
  if (label) label.textContent = `${pct}%`;
  if (persist) {
    try {
      localStorage.setItem(zoomStorageKey(), String(canvasZoom));
      localStorage.setItem(`${zoomStorageKey()}:mode`, canvasFitMode ? "fit" : "manual");
    } catch (_) {}
  }
}

function setCanvasZoom(pct, persist = true) {
  canvasFitMode = false;
  canvasZoom = Math.min(2, Math.max(0.1, pct / 100));
  applyCanvasZoom(persist);
}

function zoomToFit(persist = true) {
  const canvas = document.getElementById("dashCanvas");
  const wrap = document.getElementById("dashWallpaper");
  if (!canvas || !wrap) return;
  // Compare the canvas's unscaled width against the space available for it.
  const padding = getComputedStyle(wrap);
  const target = wrap.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
  const natural = canvas.offsetWidth;
  if (!natural || target <= 0) return;
  const height = Math.max(240, window.innerHeight - 220);
  canvasFitMode = true;
  canvasZoom = Math.max(0.1, Math.min(1, target / natural, height / canvas.offsetHeight));
  applyCanvasZoom(persist);
}

function initZoomBar() {
  const slider = document.getElementById("zoomSlider");
  if (!slider) return;
  try {
    const saved = parseFloat(localStorage.getItem(zoomStorageKey()));
    if (saved && saved >= 0.1 && saved <= 2 && localStorage.getItem(`${zoomStorageKey()}:mode`) === "manual") {
      canvasZoom = saved;
      canvasFitMode = false;
    }
  } catch (_) {}
  applyCanvasZoom(false);

  slider.addEventListener("input", (e) => setCanvasZoom(Number(e.target.value)));
  document.getElementById("zoomIn").addEventListener("click", () => setCanvasZoom(Math.round(canvasZoom * 100) + 10));
  document.getElementById("zoomOut").addEventListener("click", () => setCanvasZoom(Math.round(canvasZoom * 100) - 10));
  document.getElementById("zoomReset").addEventListener("click", () => setCanvasZoom(100));
  document.getElementById("zoomFit").addEventListener("click", () => zoomToFit());
  const refit = () => { if (canvasFitMode) zoomToFit(false); };
  new ResizeObserver(refit).observe(document.querySelector(".studio-main"));
  window.addEventListener("resize", refit);

  // Ctrl / ⌘ + wheel zooms the canvas, like every other design tool.
  const wall = document.getElementById("dashWallpaper");
  if (wall) {
    wall.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setCanvasZoom(Math.round(canvasZoom * 100) + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });
  }
}

/* ---------------- Add / edit a visual ---------------- */
function specFromPane() {
  const wells = visualWells(selectedVisual);
  const spec = {
    kind: "visual",
    type: selectedVisual,
    title: document.getElementById("vizTitle").value.trim() || (visualById(selectedVisual) || {}).label,
    agg: document.getElementById("vizAgg").value,
    color: PALETTE[0],
  };
  if (wells.includes("x")) spec.x = vizFields.x;
  if (wells.includes("y")) spec.y = vizFields.y;
  if (wells.includes("series")) spec.series = vizFields.series;
  if (wells.includes("y2")) { spec.y2 = vizFields.y2; spec.agg2 = spec.agg; }
  if (wells.includes("field")) spec.column = vizFields.field;
  if (selectedVisual === "kpi_card") {
    const goal = parseFloat(document.getElementById("vizGoal").value);
    spec.goal = isNaN(goal) ? null : goal;
  }
  if (selectedVisual === "image") spec.image = pendingVisualImage;
  return spec;
}

function validateSpec(spec) {
  const wells = visualWells(spec.type);
  if (wells.includes("field") && !spec.column) return "Add a column to the Field well.";
  if (spec.type === "image" && !spec.image) return "Choose an image file first.";
  if (spec.type === "card" || spec.type === "kpi_card") return null; // row-count is a valid default
  if (wells.includes("x") && !spec.x) return "Add a column to the X-axis.";
  if (spec.type === "scatter" && !spec.y) return "Scatter charts need a Y-axis column too.";
  return null;
}

function resetVizPane() {
  editingVisualId = null;
  pendingVisualImage = null;
  vizFields = { x: null, y: null, series: null, y2: null, field: null };
  const titleEl = document.getElementById("vizTitle");
  titleEl.value = (visualById(selectedVisual) || {}).label || "";
  titleEl.dataset.auto = "1";
  document.getElementById("vizGoal").value = "";
  document.getElementById("vizImageInput").value = "";
  document.getElementById("vizAddLabel").textContent = "Add to dashboard";
  document.getElementById("vizCancelEditBtn").classList.add("hidden");
  syncWellsUI();
}

function startEditVisual(id) {
  const w = widgets.find((x) => x.id === id);
  if (!w) return;
  editingVisualId = id;
  selectedVisual = w.spec.type;
  vizFields = {
    x: w.spec.x || null, y: w.spec.y || null, series: w.spec.series || null,
    y2: w.spec.y2 || null, field: w.spec.column || null,
  };
  pendingVisualImage = w.spec.image || null;
  document.querySelectorAll("#vizGallery .viz-ico").forEach((b) => b.classList.toggle("active", b.dataset.viz === selectedVisual));
  const titleEl = document.getElementById("vizTitle");
  titleEl.value = w.spec.title || "";
  titleEl.dataset.auto = "0";
  document.getElementById("vizAgg").value = w.spec.agg || "count";
  document.getElementById("vizGoal").value = w.spec.goal || "";
  document.getElementById("vizAddLabel").textContent = "Update visual";
  document.getElementById("vizCancelEditBtn").classList.remove("hidden");
  switchVizTab("build");
  syncWellsUI();
  document.getElementById("vizPane").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function applyVizPane() {
  const spec = specFromPane();
  const problem = validateSpec(spec);
  if (problem) return toast(problem, "err");

  if (editingVisualId) {
    const w = widgets.find((x) => x.id === editingVisualId);
    if (w) {
      const keepSelected = w.spec.selected instanceof Set ? w.spec.selected : new Set();
      const sameType = w.spec.type === spec.type;
      Object.assign(w.spec, spec);
      w.spec.selected = sameType ? keepSelected : new Set();
      const card = document.getElementById(editingVisualId);
      card.className = `viz-card neo ${visualSpan(w.spec.type)}`;
      // The toolbar differs between chart and DOM visuals, so rebuild the header too.
      const def = visualById(w.spec.type);
      card.innerHTML = `
        <div class="viz-head">
          <h4>${escapeAttr(w.spec.title)}</h4>
          ${vizActionsHTML({ chart: !!def && def.render === "chart", color: w.spec.color, edit: true })}
        </div>
        ${visualBodyHTML(w.spec)}`;
      wireVisualActions(card, editingVisualId, w.spec);
      addResizeHandle(card, editingVisualId);
      if (charts[editingVisualId]) { charts[editingVisualId].destroy(); delete charts[editingVisualId]; }
      await renderVisualWidget(editingVisualId, w.spec);
      renderChartBackgroundControls();
      persistLayout();
      toast("Visual updated");
      if (window.lucide) lucide.createIcons();
    }
    resetVizPane();
    return;
  }

  await addVisualWidget(spec);
  toast(`${(visualById(spec.type) || {}).label || "Visual"} added`);
  resetVizPane();
}

/* ---------------- Pane tabs / collapse ---------------- */
function switchVizTab(tab) {
  document.querySelectorAll("#vizPane .pane-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("tabBuild").classList.toggle("hidden", tab !== "build");
  document.getElementById("tabFormat").classList.toggle("hidden", tab !== "format");
}

/* ---------------- Dashboard / Table view ---------------- */
async function switchView(view) {
  document.querySelectorAll("#viewRail .rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const isTable = view === "table";
  document.getElementById("exportRoot").classList.toggle("hidden", isTable);
  document.getElementById("tableView").classList.toggle("hidden", !isTable);
  if (isTable) await renderTableView();
}

async function renderTableView() {
  const thead = document.querySelector("#tvTable thead");
  const tbody = document.querySelector("#tvTable tbody");
  thead.innerHTML = `<tr><th>Loading…</th></tr>`;
  tbody.innerHTML = "";
  try {
    const data = await api("/api/preview");
    thead.innerHTML = "<tr>" + data.columns.map((c) => `<th>${escapeAttr(c)}</th>`).join("") + "</tr>";
    tbody.innerHTML = data.rows
      .map((r) => "<tr>" + data.columns.map((c) => `<td>${r[c] === null || r[c] === undefined ? "" : escapeAttr(r[c])}</td>`).join("") + "</tr>")
      .join("");
    document.getElementById("tvMeta").textContent = `${data.total_rows.toLocaleString()} rows × ${data.total_cols} columns`;
  } catch (err) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td class="muted">${escapeAttr(err.message)}</td></tr>`;
  }
}

/* ---------------- Wire up the studio panes ---------------- */
function initStudio() {
  renderVizGallery();
  initWellDropZones();
  syncWellsUI();
  renderDataPane();

  initZoomBar();

  document.getElementById("dataSearch").addEventListener("input", (e) => renderDataPane(e.target.value));
  document.getElementById("dataTableNode").addEventListener("click", (e) => {
    const node = e.currentTarget;
    const open = node.getAttribute("aria-expanded") !== "true";
    node.setAttribute("aria-expanded", String(open));
    document.getElementById("dataColList").classList.toggle("hidden", !open);
  });
  document.getElementById("vizTitle").addEventListener("input", (e) => { e.target.dataset.auto = "0"; });
  document.getElementById("vizAgg").addEventListener("change", () => renderWellChips());
  document.getElementById("vizAddBtn").addEventListener("click", applyVizPane);
  document.getElementById("vizCancelEditBtn").addEventListener("click", () => { resetVizPane(); toast("Edit cancelled"); });
  document.getElementById("vizImageInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { pendingVisualImage = reader.result; toast("Image ready — click Add to dashboard"); };
    reader.readAsDataURL(file);
  });

  document.querySelectorAll("#vizPane .pane-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchVizTab(btn.dataset.tab));
  });
  document.querySelectorAll("#viewRail .rail-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  ["viz", "data"].forEach((name) => {
    const pane = document.getElementById(`${name}Pane`);
    const button = document.getElementById(`${name}PaneToggle`);
    button.setAttribute("aria-expanded", "true");
    button.addEventListener("click", () => {
      const collapsed = pane.classList.toggle("collapsed");
      document.querySelector(".studio").classList.toggle(`${name}-collapsed`, collapsed);
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = collapsed ? "Expand" : "Collapse";
    });
  });

  initFormatPane();
  initCanvasDropZones();
}

/* =========================================================================
   Format page — canvas size, canvas background, wallpaper
   ========================================================================= */
const CANVAS_PRESETS = {
  "16:9":  { width: 1280, height: 720 },
  "4:3":   { width: 1024, height: 768 },
  letter:  { width: 816,  height: 1056 },
};

const DEFAULT_PAGE_FORMAT = {
  canvas:     { type: "16:9", width: 1280, height: 720, align: "top" },
  background: { color: "#ffffff", image: null, fit: "fit", transparency: 0 },
  wallpaper:  { color: "#eef1f7", image: null, fit: "fit", transparency: 0 },
};

let pageFormat = JSON.parse(JSON.stringify(DEFAULT_PAGE_FORMAT));

function normalizePageFormat(format = {}) {
  const normalized = {};
  for (const key of Object.keys(DEFAULT_PAGE_FORMAT)) {
    normalized[key] = Object.assign({}, DEFAULT_PAGE_FORMAT[key], format[key]);
  }
  const c = normalized.canvas;
  if (!CANVAS_PRESETS[c.type] && c.type !== "custom") c.type = "16:9";
  Object.assign(c, CANVAS_PRESETS[c.type]);
  c.width = Math.round(Math.max(320, Math.min(7680, Number(c.width) || 1280)));
  c.height = Math.round(Math.max(180, Math.min(7680, Number(c.height) || 720)));
  for (const key of ["background", "wallpaper"]) {
    const layer = normalized[key];
    layer.transparency = Math.max(0, Math.min(100, Number(layer.transparency) || 0));
  }
  return normalized;
}

function hexToRgba(hex, alpha) {
  const h = (hex || "#ffffff").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function fitToBackgroundSize(fit) {
  if (fit === "stretch") return "100% 100%";
  if (fit === "fill") return "cover";
  return "contain";
}

function applyPageFormat() {
  const canvas = document.getElementById("dashCanvas");
  const wall = document.getElementById("dashWallpaper");
  if (!canvas || !wall) return;

  pageFormat = normalizePageFormat(pageFormat);
  const c = pageFormat.canvas;
  canvas.style.width = `${c.width}px`;
  canvas.style.height = `${c.height}px`;
  const grid = document.getElementById("dashGrid");
  if (grid.classList.contains("free-layout")) {
    for (const card of grid.children) {
      card.style.width = `${Math.min(card.offsetWidth, grid.clientWidth)}px`;
      card.style.left = `${Math.max(0, Math.min(parseFloat(card.style.left) || 0, grid.clientWidth - card.offsetWidth))}px`;
    }
    updateFreeLayout();
  }
  canvas.classList.add("sized");
  canvas.classList.toggle("align-middle", c.align === "middle");
  wall.classList.add("has-canvas-size");

  for (const [id, layer, prefix] of [["canvasBackground", pageFormat.background, "cb"], ["wallpaperBackground", pageFormat.wallpaper, "wp"]]) {
    const element = document.getElementById(id);
    element.style.backgroundColor = hexToRgba(layer.color, 1);
    element.style.backgroundImage = layer.image ? `url(${JSON.stringify(layer.image)})` : "none";
    element.style.backgroundSize = fitToBackgroundSize(layer.fit);
    element.style.opacity = 1 - layer.transparency / 100;
    const preview = document.getElementById(`${prefix}ImagePreview`);
    const status = document.getElementById(`${prefix}ImageStatus`);
    preview.classList.toggle("hidden", !layer.image);
    if (layer.image && preview.getAttribute("src") !== layer.image) {
      preview.src = layer.image;
      status.textContent = "Image applied.";
      delete status.dataset.state;
    } else if (!layer.image) {
      preview.removeAttribute("src");
      status.textContent = "PNG or JPG, up to 20 MB.";
      delete status.dataset.state;
    }
  }
  if (canvasFitMode) zoomToFit(false);
  syncPageBackgroundPosition(canvas);
  syncPageBackgroundPosition(wall);
}

function syncPageBackgroundPosition(container) {
  const background = container.querySelector(".page-background");
  background.style.transform = `translate(${container.scrollLeft}px, ${container.scrollTop}px)`;
}

function syncFormatInputs() {
  const c = pageFormat.canvas, bg = pageFormat.background, wp = pageFormat.wallpaper;
  const preset = CANVAS_PRESETS[c.type];
  document.getElementById("cvType").value = c.type;
  document.getElementById("cvWidth").value = preset ? preset.width : c.width;
  document.getElementById("cvHeight").value = preset ? preset.height : c.height;
  document.getElementById("cvWidth").disabled = !!preset;
  document.getElementById("cvHeight").disabled = !!preset;
  document.getElementById("cvAlign").value = c.align;

  document.getElementById("cbColor").value = bg.color;
  document.getElementById("cbFit").value = bg.fit;
  document.getElementById("cbTrans").value = bg.transparency;
  document.getElementById("cbTransVal").textContent = bg.transparency;

  document.getElementById("wpColor").value = wp.color;
  document.getElementById("wpFit").value = wp.fit;
  document.getElementById("wpTrans").value = wp.transparency;
  document.getElementById("wpTransVal").textContent = wp.transparency;
}

function commitFormat() {
  applyPageFormat();
  persistLayout();
}

function renderChartBackgroundControls() {
  const list = document.getElementById("chartBackgroundList");
  list.innerHTML = widgets.length ? widgets.map((w) => {
    const enabled = w.spec.showBackground !== false;
    const title = escapeAttr(w.spec.title || "Untitled chart");
    const card = document.getElementById(w.id);
    if (card) card.classList.toggle("chart-background-off", !enabled);
    return `<div class="chart-background-row">
      <span class="chart-background-name" title="${title}">${title}</span>
      <button type="button" class="chart-background-switch" role="switch" aria-checked="${enabled}"
        aria-label="Background for ${title}" data-chart-background="${w.id}" ${readOnly ? "disabled" : ""}>${enabled ? "ON" : "OFF"}</button>
    </div>`;
  }).join("") : '<p class="chart-background-hint muted">Add a chart to manage its background.</p>';
}

function initFormatPane() {
  const on = (id, evt, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };

  on("dashCanvas", "scroll", (e) => syncPageBackgroundPosition(e.currentTarget));
  on("dashWallpaper", "scroll", (e) => syncPageBackgroundPosition(e.currentTarget));
  renderChartBackgroundControls();
  on("chartBackgroundList", "click", (e) => {
    const button = e.target.closest("[data-chart-background]");
    if (!button || readOnly) return;
    const widget = widgets.find((w) => w.id === button.dataset.chartBackground);
    if (!widget) return;
    widget.spec.showBackground = widget.spec.showBackground === false;
    document.getElementById(widget.id).classList.toggle("chart-background-off", !widget.spec.showBackground);
    button.setAttribute("aria-checked", String(widget.spec.showBackground));
    button.textContent = widget.spec.showBackground ? "ON" : "OFF";
    persistLayout();
  });

  /* Canvas settings */
  on("cvType", "change", (e) => {
    pageFormat.canvas.type = e.target.value;
    const preset = CANVAS_PRESETS[e.target.value];
    if (preset) { pageFormat.canvas.width = preset.width; pageFormat.canvas.height = preset.height; }
    syncFormatInputs();
    commitFormat();
  });
  ["Width", "Height"].forEach((dimension) => {
    on(`cv${dimension}`, "change", (e) => {
      pageFormat.canvas[dimension.toLowerCase()] = Number(e.target.value);
      commitFormat();
      syncFormatInputs();
    });
  });
  on("cvAlign", "change", (e) => { pageFormat.canvas.align = e.target.value; commitFormat(); });
  on("cvReset", "click", () => {
    pageFormat.canvas = Object.assign({}, DEFAULT_PAGE_FORMAT.canvas);
    syncFormatInputs(); commitFormat(); toast("Canvas settings reset");
  });

  /* Canvas background */
  on("cbColor", "input", (e) => { pageFormat.background.color = e.target.value; commitFormat(); });
  on("cbFit", "change", (e) => { pageFormat.background.fit = e.target.value; commitFormat(); });
  on("cbTrans", "input", (e) => {
    pageFormat.background.transparency = Number(e.target.value);
    document.getElementById("cbTransVal").textContent = e.target.value;
    commitFormat();
  });
  on("cbImage", "change", (e) => readImageInto(e, (dataUrl) => { pageFormat.background.image = dataUrl; commitFormat(); }));
  on("cbReset", "click", () => {
    pageFormat.background = Object.assign({}, DEFAULT_PAGE_FORMAT.background);
    document.getElementById("cbImage").value = "";
    syncFormatInputs(); commitFormat(); toast("Canvas background reset");
  });

  /* Wallpaper */
  on("wpColor", "input", (e) => { pageFormat.wallpaper.color = e.target.value; commitFormat(); });
  on("wpFit", "change", (e) => { pageFormat.wallpaper.fit = e.target.value; commitFormat(); });
  on("wpTrans", "input", (e) => {
    pageFormat.wallpaper.transparency = Number(e.target.value);
    document.getElementById("wpTransVal").textContent = e.target.value;
    commitFormat();
  });
  on("wpImage", "change", (e) => readImageInto(e, (dataUrl) => { pageFormat.wallpaper.image = dataUrl; commitFormat(); }));
  on("wpReset", "click", () => {
    pageFormat.wallpaper = Object.assign({}, DEFAULT_PAGE_FORMAT.wallpaper);
    document.getElementById("wpImage").value = "";
    syncFormatInputs(); commitFormat(); toast("Wallpaper reset");
  });

  syncFormatInputs();
  applyPageFormat();
}

function readImageInto(event, done) {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById(`${input.id}Status`);
  const fail = (message) => {
    if (input.files[0] !== file) return;
    input.value = "";
    status.textContent = message;
    status.dataset.state = "error";
    toast(message, "err");
  };
  if (file.type && !["image/png", "image/jpeg"].includes(file.type)) return fail("Choose a PNG or JPG image.");
  if (file.size > 20 * 1024 * 1024) return fail("Image must be 20 MB or smaller.");
  status.textContent = "Loading image…";
  delete status.dataset.state;
  const reader = new FileReader();
  reader.onerror = () => fail("Could not read this image. Please try another file.");
  reader.onload = () => {
    if (input.files[0] !== file) return;
    const image = new Image();
    image.onerror = () => fail("This image could not be decoded. Choose a valid PNG or JPG.");
    image.onload = () => {
      if (input.files[0] !== file) return;
      done(reader.result);
      status.textContent = `Image applied (${image.naturalWidth} × ${image.naturalHeight}).`;
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* ---------------- Export ---------------- */
async function downloadChartPng(id, title) {
  const chart = charts[id];
  if (!chart) return;
  const a = document.createElement("a");
  a.href = chart.toBase64Image("image/png", 1);
  a.download = `${title.replace(/\s+/g, "_")}.png`;
  a.click();
}

document.getElementById("exportPngBtn").addEventListener("click", () => exportDashboard("png"));
document.getElementById("exportPdfBtn").addEventListener("click", () => exportDashboard("pdf"));

async function exportDashboard(fmt) {
  if (!widgets.length) return toast("Add some charts first", "err");
  toast("Rendering export…");

  const root = document.getElementById("exportRoot");
  document.getElementById("exportTitle").textContent = `${Session.filename()} — Dashboard`;
  document.getElementById("exportSub").textContent =
    "Generated by DataPilot AI · " + new Date().toLocaleString();

  // Apply the glassmorphism export theme (hides slicers & action buttons via CSS).
  root.classList.add("glass-export");
  // Capture at 100% so the on-screen zoom level never affects export quality.
  const dashCanvasEl = document.getElementById("dashCanvas");
  const zoomBefore = dashCanvasEl ? dashCanvasEl.style.zoom : null;
  if (dashCanvasEl) dashCanvasEl.style.zoom = 1;
  await new Promise((r) => setTimeout(r, 150)); // let styles settle

  let canvas;
  try {
    canvas = await html2canvas(root, { backgroundColor: null, scale: 2, useCORS: true });
  } finally {
    root.classList.remove("glass-export");
    if (dashCanvasEl) dashCanvasEl.style.zoom = zoomBefore;
  }

  if (fmt === "png") {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${Session.filename()}_dashboard.png`;
    a.click();
  } else {
    const { jsPDF } = window.jspdf;
    const img = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: canvas.width >= canvas.height ? "landscape" : "portrait", unit: "px", format: [canvas.width, canvas.height] });
    pdf.addImage(img, "PNG", 0, 0, canvas.width, canvas.height);
    pdf.save(`${Session.filename()}_dashboard.pdf`);
  }
  toast(`Dashboard exported as ${fmt.toUpperCase()}`);
}

init();

/* =========================================================================
   Interactive Dashboard Features (Floating Toolbox & Resizable Charts)
   ========================================================================= */

function initDraggableToolbox() {
  const dataPane = document.getElementById("dataPane");
  const head = dataPane.querySelector(".pane-head");
  if (!head || !dataPane) return;

  head.classList.add("draggable-head");
  dataPane.classList.add("floating");

  let isDragging = false;
  let offsetX = 0, offsetY = 0;

  head.addEventListener("mousedown", (e) => {
    if (e.target.closest("button") || e.target.tagName === "INPUT") return;
    isDragging = true;
    const rect = dataPane.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    dataPane.style.transition = "none"; // Disable smooth shadow transition while dragging
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    e.preventDefault();
    // Keep toolbox within window bounds roughly
    const maxX = window.innerWidth - dataPane.offsetWidth;
    const maxY = window.innerHeight - head.offsetHeight;
    let newX = e.clientX - offsetX;
    let newY = e.clientY - offsetY;
    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    dataPane.style.left = newX + "px";
    dataPane.style.top = newY + "px";
    dataPane.style.right = "auto";
    dataPane.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      dataPane.style.transition = "";
    }
  });
}

function initCanvasDropZones() {
  const dashGrid = document.getElementById("dashGrid");
  if (!dashGrid) return;

  // Highlight dashboard when dragging a column
  dashGrid.addEventListener("dragover", (e) => {
    e.preventDefault();
    // Allow drop on canvas or specific cards
    e.dataTransfer.dropEffect = "copy";
  });

  dashGrid.addEventListener("drop", async (e) => {
    e.preventDefault();
    const col = e.dataTransfer.getData("text/plain");
    if (!col) return;

    const targetCard = e.target.closest(".viz-card");
    if (targetCard) {
      // Dropped on an existing card - attempt to add to chart
      const id = targetCard.id;
      const widget = widgets.find((w) => w.id === id);
      if (widget && widget.spec && widget.spec.kind === "visual") {
        const colDef = (profile.columns || []).find((c) => c.name === col);
        const wells = window.visualWells ? visualWells(widget.spec.type) : [];

        let changed = false;
        if (colDef && colDef.kind === "numeric" && wells.includes("y") && !widget.spec.y) {
          widget.spec.y = col;
          changed = true;
        } else if (wells.includes("x") && !widget.spec.x) {
          widget.spec.x = col;
          changed = true;
        } else if (wells.includes("y")) {
          widget.spec.y = col; // overwrite Y if both are full
          changed = true;
        }

        if (changed) {
          await renderVisualWidget(id, widget.spec);
          persistLayout();
          toast(`Updated ${widget.spec.title} with ${col}`);
        }
      }
      return;
    }

    // Dropped on empty canvas - create new chart
    const colDef = (profile.columns || []).find((c) => c.name === col);
    if (!colDef) return;

    const spec = { type: "bar_chart", x: col, y: null };
    // If numeric, make a KPI card by default instead
    if (colDef.kind === "numeric") {
      spec.type = "kpi_card";
      spec.y = col;
      spec.x = null;
    }
    await addVisualWidget(spec);
    toast(`Created new chart for ${col}`);
  });
}
