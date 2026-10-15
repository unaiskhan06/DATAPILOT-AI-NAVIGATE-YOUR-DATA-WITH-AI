/* visuals.js — Power BI-style visual registry + Chart.js config builders.
   Every visual the "Build visual" gallery offers is declared here once:
   its icon, its label, which field wells it uses, and how it renders. */

/* wells:
     x      — Axis / category
     y      — Values (measure)
     series — Legend (breakdown)
     y2     — Line values (combo charts only)
     field  — single column (slicers)
   render:
     "chart" — drawn by Chart.js via buildVisualConfig()
     "dom"   — drawn with HTML by dashboard.js
*/
/* Inline SVG mini-chart icons — 20×20 viewBox, uses currentColor */
const VISUAL_SVG = {
  stacked_bar:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="3" width="9" height="2.5" rx=".4" opacity=".9"/><rect x="10" y="3" width="5" height="2.5" rx=".4" opacity=".45"/><rect x="1" y="7.5" width="11" height="2.5" rx=".4" opacity=".9"/><rect x="12" y="7.5" width="4" height="2.5" rx=".4" opacity=".45"/><rect x="1" y="12" width="7" height="2.5" rx=".4" opacity=".9"/><rect x="8" y="12" width="8" height="2.5" rx=".4" opacity=".45"/><rect x="1" y="16.5" width="10" height="2.5" rx=".4" opacity=".9"/><rect x="11" y="16.5" width="5" height="2.5" rx=".4" opacity=".45"/></svg>`,
  stacked_column:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="10" width="3.5" height="8" rx=".4" opacity=".9"/><rect x="1" y="6" width="3.5" height="4" rx=".4" opacity=".45"/><rect x="6" y="7" width="3.5" height="11" rx=".4" opacity=".9"/><rect x="6" y="3" width="3.5" height="4" rx=".4" opacity=".45"/><rect x="11" y="9" width="3.5" height="9" rx=".4" opacity=".9"/><rect x="11" y="6" width="3.5" height="3" rx=".4" opacity=".45"/><rect x="16" y="12" width="3.5" height="6" rx=".4" opacity=".9"/><rect x="16" y="9" width="3.5" height="3" rx=".4" opacity=".45"/></svg>`,
  line:`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><polyline points="1,16 5,10 9,13 13,6 19,3"/><circle cx="1" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="13" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="3" r="1.3" fill="currentColor" stroke="none"/></svg>`,
  area:`<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M1 16 L5 10 L9 13 L13 6 L19 3 L19 19 L1 19Z" fill="currentColor" opacity=".28"/><polyline points="1,16 5,10 9,13 13,6 19,3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  stacked_area:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1 19 L4 16 L8 17 L12 14 L16 15 L19 13 L19 19Z" opacity=".95"/><path d="M1 13 L4 10 L8 12 L12 8 L16 9 L19 7 L19 13 L16 15 L12 14 L8 17 L4 16 L1 19Z" opacity=".6"/><path d="M1 7 L4 4 L8 6 L12 2 L16 3 L19 1 L19 7 L16 9 L12 8 L8 12 L4 10Z" opacity=".3"/></svg>`,
  line_stacked_column:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="12" width="3" height="7" rx=".3" opacity=".55"/><rect x="6" y="9" width="3" height="10" rx=".3" opacity=".55"/><rect x="11" y="11" width="3" height="8" rx=".3" opacity=".55"/><rect x="16" y="10" width="3" height="9" rx=".3" opacity=".55"/><polyline points="2.5,9 7.5,5 12.5,7.5 17.5,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="2.5" cy="9" r="1.3"/><circle cx="7.5" cy="5" r="1.3"/><circle cx="12.5" cy="7.5" r="1.3"/><circle cx="17.5" cy="5" r="1.3"/></svg>`,
  ribbon:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1 2 L1 7 C5 7 14 16 19 16 L19 13 C14 13 5 4 1 4Z" opacity=".8"/><path d="M1 9 L1 14 C5 14 14 5 19 5 L19 2 C14 2 5 9 1 9Z" opacity=".45"/></svg>`,
  waterfall:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="13" width="3.5" height="5" rx=".3" opacity=".85"/><rect x="5.5" y="9" width="3.5" height="4" rx=".3" opacity=".55"/><rect x="10" y="6" width="3.5" height="3" rx=".3" opacity=".55"/><rect x="14.5" y="3" width="4.5" height="15" rx=".3" opacity=".85"/><line x1="4.5" y1="13" x2="5.5" y2="13" stroke="currentColor" stroke-width=".8"/><line x1="9" y1="9" x2="10" y2="9" stroke="currentColor" stroke-width=".8"/><line x1="13.5" y1="6" x2="14.5" y2="6" stroke="currentColor" stroke-width=".8"/></svg>`,
  funnel:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="18" height="3" rx=".5" opacity=".85"/><rect x="2.5" y="7" width="15" height="3" rx=".5" opacity=".65"/><rect x="5" y="12" width="10" height="3" rx=".5" opacity=".45"/><rect x="7" y="17" width="6" height="1.5" rx=".5" opacity=".25"/></svg>`,
  scatter:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="3" cy="15" r="1.5"/><circle cx="6" cy="11" r="1.5"/><circle cx="8" cy="14" r="1.5"/><circle cx="10" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="14" cy="5" r="1.5"/><circle cx="16" cy="9" r="1.5"/><circle cx="5" cy="17" r="1" opacity=".6"/><circle cx="15" cy="15" r="1" opacity=".6"/><circle cx="18" cy="6" r="1" opacity=".6"/></svg>`,
  pie:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10 10 L10 2 A8 8 0 0 1 18 10Z" opacity=".95"/><path d="M10 10 L18 10 A8 8 0 0 1 4.86 15.14Z" opacity=".65"/><path d="M10 10 L4.86 15.14 A8 8 0 0 1 2 10Z" opacity=".38"/><path d="M10 10 L2 10 A8 8 0 0 1 10 2Z" opacity=".75"/><line x1="10" y1="10" x2="10" y2="2" stroke="white" stroke-width="1.2"/><line x1="10" y1="10" x2="18" y2="10" stroke="white" stroke-width="1.2"/><line x1="10" y1="10" x2="4.86" y2="15.14" stroke="white" stroke-width="1.2"/><line x1="10" y1="10" x2="2" y2="10" stroke="white" stroke-width="1.2"/></svg>`,
  donut:`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10 3 A7 7 0 0 1 17 10" stroke-width="3.5" opacity=".9"/><path d="M17 10 A7 7 0 0 1 10 17" stroke-width="3.5" opacity=".6"/><path d="M10 17 A7 7 0 0 1 3 10" stroke-width="3.5" opacity=".4"/><path d="M3 10 A7 7 0 0 1 10 3" stroke-width="3.5" opacity=".7"/></svg>`,
  treemap:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="10" height="10" rx=".5" opacity=".8"/><rect x="12" y="1" width="7" height="5" rx=".5" opacity=".55"/><rect x="12" y="7" width="7" height="4" rx=".5" opacity=".35"/><rect x="1" y="12" width="6" height="7" rx=".5" opacity=".5"/><rect x="8" y="12" width="11" height="7" rx=".5" opacity=".7"/></svg>`,
  card:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width=".8" opacity=".4"/><rect x="4" y="7.5" width="12" height="2.5" rx=".5" opacity=".75"/><rect x="6" y="12" width="8" height="1.5" rx=".5" opacity=".35"/></svg>`,
  kpi_card:`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 15 A8 8 0 0 1 18 15" stroke-width="2.8" opacity=".18" stroke-linecap="round"/><path d="M2 15 A8 8 0 0 1 16.2 8.5" stroke-width="2.8" opacity=".9" stroke-linecap="round"/><line x1="2" y1="15" x2="3.6" y2="13.9" stroke-width=".8" opacity=".5"/><line x1="10" y1="7" x2="10" y2="8.6" stroke-width=".8" opacity=".5"/><line x1="18" y1="15" x2="16.4" y2="13.9" stroke-width=".8" opacity=".5"/><line x1="10" y1="15" x2="15" y2="8.5" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="15" r="1.6" fill="currentColor" stroke="none"/></svg>`,
  slicer:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2.5" width="4" height="3.5" rx=".5" opacity=".7"/><rect x="7" y="3.5" width="12" height="1.5" rx=".4" opacity=".35"/><rect x="1" y="8.5" width="4" height="3.5" rx=".5" opacity=".7"/><rect x="7" y="9.5" width="12" height="1.5" rx=".4" opacity=".35"/><rect x="1" y="14.5" width="4" height="3.5" rx=".5" opacity=".7"/><rect x="7" y="15.5" width="12" height="1.5" rx=".4" opacity=".35"/></svg>`,
  button_slicer:`<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="5" width="8" height="10" rx="2" opacity=".3"/><rect x="11" y="5" width="8" height="10" rx="2" opacity=".9"/><rect x="13" y="9" width="4" height="2" rx=".4" fill="white" opacity=".9"/></svg>`,
  image:`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="14" rx="1.5" stroke-width="1.2"/><circle cx="7" cy="8" r="1.5" fill="currentColor" stroke="none" opacity=".6"/><polyline points="2,14 7,9 11,13 14,10 18,14" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
};

const VISUAL_TYPES = [
  { id: "stacked_bar",         label: "Stacked bar chart",           icon: VISUAL_SVG.stacked_bar, render: "chart", wells: ["x", "y", "series"] },
  { id: "stacked_column",      label: "Stacked column chart",        icon: VISUAL_SVG.stacked_column, render: "chart", wells: ["x", "y", "series"] },
  { id: "line",                label: "Line chart",                  icon: VISUAL_SVG.line, render: "chart", wells: ["x", "y", "series"] },
  { id: "area",                label: "Area chart",                  icon: VISUAL_SVG.area, render: "chart", wells: ["x", "y", "series"] },
  { id: "stacked_area",        label: "Stacked area chart",          icon: VISUAL_SVG.stacked_area, render: "chart", wells: ["x", "y", "series"] },
  { id: "line_stacked_column", label: "Line and stacked column",     icon: VISUAL_SVG.line_stacked_column, render: "chart", wells: ["x", "y", "series", "y2"] },
  { id: "ribbon",              label: "Ribbon chart",                icon: VISUAL_SVG.ribbon, render: "chart", wells: ["x", "y", "series"] },
  { id: "waterfall",           label: "Waterfall chart",             icon: VISUAL_SVG.waterfall, render: "chart", wells: ["x", "y"] },
  { id: "funnel",              label: "Funnel chart",                icon: VISUAL_SVG.funnel, render: "chart", wells: ["x", "y"] },
  { id: "scatter",             label: "Scatter chart",               icon: VISUAL_SVG.scatter, render: "chart", wells: ["x", "y"] },
  { id: "pie",                 label: "Pie chart",                   icon: VISUAL_SVG.pie, render: "chart", wells: ["x", "y"] },
  { id: "donut",               label: "Donut chart",                 icon: VISUAL_SVG.donut, render: "chart", wells: ["x", "y"] },
  { id: "treemap",             label: "Treemap",                     icon: VISUAL_SVG.treemap, render: "dom",   wells: ["x", "y"] },
  { id: "card",                label: "Card",                        icon: VISUAL_SVG.card, render: "dom",   wells: ["y"] },
  { id: "kpi_card",            label: "KPI card",                    icon: VISUAL_SVG.kpi_card, render: "dom",   wells: ["y"] },
  { id: "slicer",              label: "Slicer",                      icon: VISUAL_SVG.slicer, render: "dom",   wells: ["field"] },
  { id: "button_slicer",       label: "Button slicer",               icon: VISUAL_SVG.button_slicer, render: "dom",   wells: ["field"] },
  { id: "image",               label: "Image",                       icon: VISUAL_SVG.image, render: "dom",   wells: [] },
];

const VISUALS_BY_ID = Object.fromEntries(VISUAL_TYPES.map((v) => [v.id, v]));

/* Legacy type ids (from older saved layouts / recommendations) -> new ids */
const LEGACY_TYPE_MAP = {
  bar: "stacked_column",
  doughnut: "donut",
  histogram: "stacked_column",
  pivot: "pivot",
};

function visualById(id) {
  return VISUALS_BY_ID[id] || VISUALS_BY_ID[LEGACY_TYPE_MAP[id]] || null;
}

function visualWells(id) {
  const v = visualById(id);
  return v ? v.wells : ["x", "y"];
}

function isDomVisual(id) {
  const v = visualById(id);
  return !!v && v.render === "dom";
}

/* Visuals that need no data query at all (pure client-side widgets) */
const NO_DATA_VISUALS = new Set(["image", "slicer", "button_slicer"]);

/* Grid width (12-col grid) each visual gets by default */
function visualSpan(id) {
  if (id === "card" || id === "kpi_card") return "span-3";
  if (id === "slicer" || id === "button_slicer" || id === "image") return "span-4";
  if (id === "pie" || id === "donut" || id === "funnel" || id === "scatter") return "span-6";
  if (id === "treemap" || id === "line_stacked_column" || id === "waterfall" || id === "ribbon") return "span-12";
  return "span-6";
}

/* ------------------------------------------------------------------------- */
/*  Chart.js configuration                                                    */
/* ------------------------------------------------------------------------- */
/**
 * @param spec    widget spec {type, x, y, series, agg, color, title}
 * @param payload backend response {labels, values} | {labels, series} | {points} | {ranges}
 * @param opts    {palette:[], shades(base,n):[], onDrill(column,label)}
 */
function buildVisualConfig(spec, payload, opts = {}) {
  const type = spec.type;
  const palette = opts.palette || ["#3b7df6"];
  const base = spec.color || palette[0];
  const shades = opts.shades || ((c, n) => Array.from({ length: n }, () => c));

  const drillable = ["stacked_bar", "stacked_column", "pie", "donut", "funnel", "ribbon", "treemap"].includes(type);
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: {
        display: !!(payload.series && payload.series.length > 1) || ["pie", "donut"].includes(type),
        position: "bottom",
        labels: { boxWidth: 12, usePointStyle: true },
      },
    },
    onClick: drillable && opts.onDrill
      ? (evt, elements, chart) => {
          if (!elements.length) return;
          const label = chart.data.labels[elements[0].index];
          if (label !== undefined && spec.x) opts.onDrill(spec.x, label);
        }
      : undefined,
    onHover: drillable
      ? (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : "default"; }
      : undefined,
  };

  const labels = payload.labels || [];
  const measureLabel = spec.y ? `${spec.agg || "sum"} of ${spec.y}` : "count";

  /* ---- Scatter ---------------------------------------------------------- */
  if (type === "scatter") {
    return {
      type: "scatter",
      data: { datasets: [{ label: spec.title, data: payload.points || [], backgroundColor: base + "cc" }] },
      options: Object.assign({}, commonOptions, {
        scales: { x: { title: { display: true, text: spec.x } }, y: { title: { display: true, text: spec.y } } },
      }),
    };
  }

  /* ---- Waterfall (floating bars from running totals) -------------------- */
  if (type === "waterfall") {
    const ranges = payload.ranges || [];
    const vals = payload.values || [];
    return {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: measureLabel,
          data: ranges,
          backgroundColor: vals.map((v, i) =>
            i === vals.length - 1 ? base : (v >= 0 ? "#2fbf71cc" : "#e5484dcc")),
          borderRadius: 6,
        }],
      },
      options: Object.assign({}, commonOptions, {
        plugins: Object.assign({}, commonOptions.plugins, {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${measureLabel}: ${vals[c.dataIndex]}` } },
        }),
        scales: { y: { beginAtZero: true } },
      }),
    };
  }

  /* ---- Funnel (horizontal bars, widest first) --------------------------- */
  if (type === "funnel") {
    const vals = payload.values || [];
    return {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: measureLabel,
          data: vals,
          backgroundColor: shades(base, vals.length),
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: Object.assign({}, commonOptions, {
        indexAxis: "y",
        plugins: Object.assign({}, commonOptions.plugins, { legend: { display: false } }),
        scales: { x: { beginAtZero: true, grid: { display: false } } },
      }),
    };
  }

  /* ---- Pie / Donut ------------------------------------------------------ */
  if (type === "pie" || type === "donut" || type === "doughnut") {
    const vals = payload.values || [];
    return {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          label: measureLabel,
          data: vals,
          backgroundColor: spec.color ? shades(base, vals.length) : labels.map((_, i) => palette[i % palette.length]),
          borderColor: "#fff",
          borderWidth: 2,
        }],
      },
      options: Object.assign({}, commonOptions, { cutout: type === "pie" ? 0 : "58%" }),
    };
  }

  /* ---- Bar / column / line / area families ------------------------------ */
  const horizontal = type === "stacked_bar";
  const stacked = ["stacked_bar", "stacked_column", "stacked_area", "ribbon", "line_stacked_column"].includes(type);
  const isLineFamily = ["line", "area", "stacked_area"].includes(type);
  const filled = ["area", "stacked_area"].includes(type);

  let datasets;
  if (payload.series && payload.series.length) {
    // Ribbon charts rank the series within every category, biggest at the bottom.
    let seriesList = payload.series;
    if (type === "ribbon") {
      const totals = seriesList.map((s) => (s.values || []).reduce((a, b) => a + (b || 0), 0));
      seriesList = seriesList
        .map((s, i) => ({ s, t: totals[i] }))
        .sort((a, b) => b.t - a.t)
        .map((o) => o.s);
    }
    datasets = seriesList.map((s, i) => {
      const c = palette[i % palette.length];
      return {
        label: s.name,
        data: s.values,
        type: isLineFamily ? "line" : "bar",
        backgroundColor: isLineFamily ? (filled ? c + "55" : c + "22") : c + "dd",
        borderColor: c,
        borderWidth: isLineFamily ? 3 : 0,
        borderRadius: isLineFamily ? 0 : 6,
        fill: filled,
        tension: 0.35,
        pointRadius: isLineFamily ? 2 : 0,
        stack: stacked ? "stack-0" : undefined,
      };
    });
  } else {
    const vals = payload.values || [];
    datasets = [{
      label: measureLabel,
      data: vals,
      type: isLineFamily ? "line" : "bar",
      backgroundColor: isLineFamily ? base + (filled ? "55" : "22") : base + "cc",
      borderColor: base,
      borderWidth: isLineFamily ? 3 : 0,
      borderRadius: isLineFamily ? 0 : 8,
      fill: filled,
      tension: 0.35,
      pointRadius: isLineFamily ? 3 : 0,
      stack: stacked ? "stack-0" : undefined,
    }];
  }

  // Combo: overlay the second measure as a line on its own axis.
  if (type === "line_stacked_column" && payload.line_values) {
    datasets.push({
      label: payload.line_label || "line",
      data: payload.line_values,
      type: "line",
      borderColor: "#e5484d",
      backgroundColor: "#e5484d33",
      borderWidth: 3,
      tension: 0.35,
      pointRadius: 3,
      fill: false,
      yAxisID: "y1",
      stack: undefined,
    });
  }

  const scales = {
    x: { stacked: stacked && !horizontal, grid: { display: horizontal } },
    y: { stacked: stacked, beginAtZero: true, grid: { display: !horizontal } },
  };
  if (type === "line_stacked_column" && payload.line_values) {
    scales.y1 = { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } };
  }

  return {
    type: isLineFamily ? "line" : "bar",
    data: { labels, datasets },
    options: Object.assign({}, commonOptions, {
      indexAxis: horizontal ? "y" : "x",
      plugins: Object.assign({}, commonOptions.plugins, {
        legend: { display: !!(payload.series && payload.series.length > 1) || !!payload.line_values, position: "bottom", labels: { boxWidth: 12, usePointStyle: true } },
      }),
      scales,
    }),
  };
}

/* ------------------------------------------------------------------------- */
/*  Treemap (custom DOM renderer — squarified-ish rows)                       */
/* ------------------------------------------------------------------------- */
function renderTreemapHTML(payload, opts = {}) {
  const labels = payload.labels || [];
  const values = (payload.values || []).map((v) => Math.abs(Number(v) || 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return `<span class="muted" style="font-size:.82rem;">No data to display.</span>`;

  const palette = opts.palette || ["#3b7df6"];
  const items = labels.map((l, i) => ({ label: l, value: values[i], pct: (values[i] / total) * 100 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 24);

  // Pack into rows so each row's tiles total ~100% width; row height ∝ its share.
  const rows = [];
  let row = [], rowSum = 0;
  const targetRow = Math.max(12, 100 / Math.max(2, Math.ceil(Math.sqrt(items.length))));
  for (const it of items) {
    row.push(it);
    rowSum += it.pct;
    if (rowSum >= targetRow) { rows.push({ items: row, sum: rowSum }); row = []; rowSum = 0; }
  }
  if (row.length) rows.push({ items: row, sum: rowSum });

  return rows.map((r) => {
    const h = Math.max(9, (r.sum / 100) * 100);
    const tiles = r.items.map((it, i) => {
      const w = (it.value / r.items.reduce((a, b) => a + b.value, 0)) * 100;
      const c = palette[(labels.indexOf(it.label) + i) % palette.length];
      return `<div class="tm-tile" style="width:${w}%;background:${c}dd" title="${it.label}: ${it.value}">
                <span class="tm-label">${it.label}</span>
                <span class="tm-value">${it.value}</span>
              </div>`;
    }).join("");
    return `<div class="tm-row" style="flex:${h} 1 0;">${tiles}</div>`;
  }).join("");
}
