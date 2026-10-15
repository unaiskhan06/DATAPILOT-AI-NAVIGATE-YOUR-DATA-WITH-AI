/* editor.js — upload, cleaning tools, Agent mode & Editor mode */

let currentProfile = null;
let currentSheets = [];

/* ---------------- Views ---------------- */
const uploadView = document.getElementById("uploadView");
const editorView = document.getElementById("editorView");

function showEditor() {
  uploadView.classList.add("hidden");
  editorView.classList.remove("hidden");
}
function showUpload() {
  editorView.classList.add("hidden");
  uploadView.classList.remove("hidden");
}

/* ---------------- Upload ---------------- */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  dropzone.querySelector("h3").textContent = "Uploading & profiling...";
  try {
    const data = await api("/api/upload", { method: "POST", body: fd, isForm: true });
    Session.set(data.session_id);
    Session.filename(data.filename);
    render(data.preview, data.profile, data.filename, data.sheets, data.active_sheet);
    showEditor();
    toast(`Loaded ${data.profile.total_rows} rows × ${data.profile.total_cols} columns`);
  } catch (err) {
    toast(err.message, "err");
    dropzone.querySelector("h3").textContent = "Drag & drop your file here";
  }
}

/* ---------------- Rendering ---------------- */
function renderSheets(sheets, activeSheet) {
  currentSheets = sheets || [];
  const wrap = document.getElementById("sheetTabs");
  if (!wrap) return;
  if (!currentSheets.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = currentSheets
    .map(
      (s) => `
      <div class="btn btn-sm sheet-tab ${s === activeSheet ? "btn-primary" : ""}" data-sheet="${escapeHtml(s)}">
        <span class="sheet-name">${escapeHtml(s)}</span>
        <span class="sheet-close" data-sheet="${escapeHtml(s)}" title="Remove sheet">×</span>
      </div>`
    )
    .join("");
  wrap.querySelectorAll(".sheet-name").forEach((el) => {
    const name = el.parentElement.dataset.sheet;
    if (name === activeSheet) return;
    el.addEventListener("click", () => switchSheet(name));
  });
  wrap.querySelectorAll(".sheet-close").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSheet(el.dataset.sheet);
    });
  });
}

async function removeSheet(name) {
  try {
    const data = await api("/api/remove-sheet", { method: "POST", body: { sheet: name } });
    if (!data.sheets || !data.sheets.length) {
      currentSheets = [];
      document.getElementById("sheetTabs").innerHTML = "";
      Session.clear();
      showUpload();
      toast("All sheets removed");
      return;
    }
    render(data.preview, data.profile, data.filename, data.sheets, data.active_sheet);
    toast(`Removed ${name}`);
  } catch (err) {
    toast(err.message, "err");
  }
}

async function switchSheet(name) {
  try {
    const data = await api("/api/switch-sheet", { method: "POST", body: { sheet: name } });
    render(data.preview, data.profile, data.filename, data.sheets, data.active_sheet);
    toast(`Switched to ${data.filename}`);
  } catch (err) {
    toast(err.message, "err");
  }
}

function render(preview, profile, filename = null, sheets = null, activeSheet = null) {
  currentProfile = profile;
  if (filename) Session.filename(filename);
  document.getElementById("fileName").textContent = Session.filename();
  renderStats(profile);
  renderTable(preview);
  populateColumnSelects(profile);
  document.getElementById("rowCountChip").textContent =
    `${preview.shown_rows} of ${preview.total_rows} rows`;
  if (sheets) renderSheets(sheets, activeSheet);
}

function renderStats(p) {
  const stats = [
    { l: "Rows", v: p.total_rows, ico: "rows-3" },
    { l: "Columns", v: p.total_cols, ico: "columns-3" },
    { l: "Missing cells", v: p.total_missing, ico: "circle-alert" },
    { l: "Duplicate rows", v: p.duplicate_rows, ico: "copy" },
    { l: "Memory", v: p.memory_kb + " KB", ico: "hard-drive" },
  ];
  document.getElementById("statsRow").innerHTML = stats
    .map(
      (s) => `<div class="stat neo">
        <div class="v gradient-text">${s.v}</div>
        <div class="l">${s.l}</div>
      </div>`
    )
    .join("");
}

const editHint = document.getElementById("editHint");

function renderTable(preview) {
  const thead = document.querySelector("#dataTable thead");
  const tbody = document.querySelector("#dataTable tbody");
  thead.innerHTML =
    "<tr><th class='row-idx'>#</th>" +
    preview.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
    "</tr>";

  tbody.innerHTML = preview.rows
    .map((row, i) => {
      const cells = preview.columns
        .map((c) => {
          const val = row[c];
          const isNull = val === null || val === undefined;
          return `<td data-row="${i}" data-col="${escapeHtml(c)}" class="${isNull ? "null-cell" : ""}">${
            isNull ? "null" : escapeHtml(String(val))
          }</td>`;
        })
        .join("");
      return `<tr><td class="row-idx">${i}</td>${cells}</tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function populateColumnSelects(profile) {
  const cols = profile.columns.map((c) => c.name);
  ["fillCol", "typeCol", "renameCol", "dropCol", "sortCol"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = cols.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  });
}

/* ---------------- Operation dispatch ---------------- */
const tableLoading = document.getElementById("tableLoading");

async function runOperation(name, params = {}) {
  tableLoading.classList.add("show");
  try {
    const data = await api("/api/operation", { method: "POST", body: { name, params } });
    render(data.preview, data.profile);
    toast(data.message);
    return data;
  } catch (err) {
    toast(err.message, "err");
  } finally {
    tableLoading.classList.remove("show");
  }
}

/* Toolbar buttons (simple ops) */
document.querySelectorAll("[data-op]").forEach((btn) => {
  btn.addEventListener("click", () => runOperation(btn.dataset.op));
});

/* Fill missing */
const fillMethod = document.getElementById("fillMethod");
const fillValue = document.getElementById("fillValue");
fillMethod.addEventListener("change", () => {
  fillValue.classList.toggle("hidden", fillMethod.value !== "value");
});
document.getElementById("fillBtn").addEventListener("click", () => {
  runOperation("fill_missing", {
    columns: [document.getElementById("fillCol").value],
    method: fillMethod.value,
    value: fillValue.value,
  });
});

/* Change type */
document.getElementById("typeBtn").addEventListener("click", () => {
  runOperation("change_type", {
    column: document.getElementById("typeCol").value,
    to: document.getElementById("typeTo").value,
  });
});

/* Rename */
document.getElementById("renameBtn").addEventListener("click", () => {
  const nw = document.getElementById("renameTo").value.trim();
  if (!nw) return toast("Enter a new name", "err");
  runOperation("rename_column", { old: document.getElementById("renameCol").value, new: nw });
  document.getElementById("renameTo").value = "";
});

/* Drop */
document.getElementById("dropBtn").addEventListener("click", () => {
  runOperation("drop_columns", { columns: [document.getElementById("dropCol").value] });
});

/* Sort */
document.getElementById("sortAscBtn").addEventListener("click", () =>
  runOperation("sort", { column: document.getElementById("sortCol").value, ascending: true }));
document.getElementById("sortDescBtn").addEventListener("click", () =>
  runOperation("sort", { column: document.getElementById("sortCol").value, ascending: false }));

/* Undo / new / download */
document.getElementById("undoBtn").addEventListener("click", async () => {
  try {
    const data = await api("/api/undo", { method: "POST" });
    render(data.preview, data.profile);
    toast(data.message);
  } catch (err) { toast(err.message, "err"); }
});

document.getElementById("newFileBtn").addEventListener("click", () => {
  Session.clear();
  currentSheets = [];
  document.getElementById("sheetTabs").innerHTML = "";
  showUpload();
  dropzone.querySelector("h3").textContent = "Drag & drop your file here";
});

const addSheetBtn = document.getElementById("addSheetBtn");
const addSheetInput = document.getElementById("addSheetInput");
addSheetBtn.addEventListener("click", () => addSheetInput.click());
addSheetInput.addEventListener("change", async () => {
  const file = addSheetInput.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const data = await api("/api/add-sheet", { method: "POST", body: fd, isForm: true });
    Session.set(data.session_id);
    Session.filename(data.filename);
    render(data.preview, data.profile, data.filename, data.sheets, data.active_sheet);
    toast(`Added sheet ${data.filename}`);
  } catch (err) {
    toast(err.message, "err");
  }
  addSheetInput.value = "";
});

document.getElementById("downloadCsvBtn").addEventListener("click", () => download("csv"));
document.getElementById("downloadXlsxBtn").addEventListener("click", () => download("xlsx"));
async function download(fmt) {
  try {
    const blob = await api(`/api/download?format=${fmt}&sid=${Session.get()}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${Session.filename()}_cleaned.${fmt === "xlsx" ? "xlsx" : "csv"}`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${fmt.toUpperCase()}`);
  } catch (err) { toast(err.message, "err"); }
}

/* ---------------- Mode toggle ---------------- */
const agentModeBtn = document.getElementById("agentModeBtn");
const editorModeBtn = document.getElementById("editorModeBtn");
const agentPanel = document.getElementById("agentPanel");
const toolsPanel = document.getElementById("toolsPanel");
let editorMode = false;

agentModeBtn.addEventListener("click", () => setMode(false));
editorModeBtn.addEventListener("click", () => setMode(true));

function setMode(isEditor) {
  editorMode = isEditor;
  agentModeBtn.classList.toggle("active", !isEditor);
  editorModeBtn.classList.toggle("active", isEditor);
  agentPanel.classList.toggle("hidden", isEditor);
  toolsPanel.classList.toggle("hidden", !isEditor);
  editHint.textContent = isEditor ? "(double-click a cell to edit)" : "";
}

/* Delegated cell editing — scales to very large tables (no per-cell listeners). */
(function setupCellEditing() {
  const tbody = document.querySelector("#dataTable tbody");
  if (!tbody) return;

  tbody.addEventListener("dblclick", (e) => {
    const td = e.target.closest("td[data-col]");
    if (!td || !editorMode) return;
    td.dataset.original = td.textContent;
    td.setAttribute("contenteditable", "true");
    td.focus();
    document.getSelection().selectAllChildren(td);
  });

  tbody.addEventListener("focusout", async (e) => {
    const td = e.target.closest && e.target.closest("td[data-col]");
    if (!td || td.getAttribute("contenteditable") !== "true") return;
    td.removeAttribute("contenteditable");
    const value = td.textContent.trim();
    if (value === (td.dataset.original || "").trim()) return; // unchanged
    await runOperation("edit_cell", {
      row: Number(td.dataset.row),
      column: td.dataset.col,
      value,
    });
  });

  tbody.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.getAttribute("contenteditable") === "true") {
      e.preventDefault();
      e.target.blur();
    }
  });
})();

/* ---------------- Agent mode ---------------- */
const chatLog = document.getElementById("chatLog");
const agentInput = document.getElementById("agentInput");

async function checkAiStatus() {
  const el = document.getElementById("aiStatus");
  try {
    const s = await api("/api/ai-status");
    if (s.available) {
      el.innerHTML = `<i data-lucide="check-circle" style="width:14px;color:var(--success)"></i> AI Agent ready (local model)`;
    } else {
      el.innerHTML = `<i data-lucide="alert-triangle" style="width:14px;color:var(--warn)"></i> Install deps &amp; start Ollama`;
    }
  } catch (_) {}
  if (window.lucide) lucide.createIcons();
}

function addMsg(text, cls, appliedList) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
  if (appliedList && appliedList.length) {
    div.innerHTML += "<ul>" + appliedList.map((a) => `<li class="applied-item">${escapeHtml(a)}</li>`).join("") + "</ul>";
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

async function sendAgent() {
  const prompt = agentInput.value.trim();
  if (!prompt) return;
  addMsg(prompt, "user");
  agentInput.value = "";
  const thinking = addMsg("Thinking…", "bot");
  try {
    const data = await api("/api/agent", { method: "POST", body: { prompt } });
    thinking.remove();
    addMsg(data.message || "Done.", "bot", data.applied);
    render(data.preview, data.profile);
  } catch (err) {
    thinking.remove();
    addMsg(err.message, "bot");
    toast(err.message, "err");
  }
}

document.getElementById("agentSend").addEventListener("click", sendAgent);
agentInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendAgent(); });
document.querySelectorAll("#agentSuggestions .chip").forEach((chip) => {
  chip.addEventListener("click", () => { agentInput.value = chip.textContent; sendAgent(); });
});

/* ---------------- History timeline ---------------- */
const historyModal = document.getElementById("historyModal");
document.getElementById("historyBtn").addEventListener("click", async () => {
  historyModal.classList.add("open");
  const list = document.getElementById("historyList");
  list.innerHTML = `<span class="muted">Loading…</span>`;
  try {
    const data = await api("/api/history");
    if (!data.steps.length) {
      list.innerHTML = `<span class="muted">No changes recorded yet.</span>`;
      return;
    }
    list.innerHTML = data.steps
      .map(
        (s) => `<div class="history-item">
          <div class="hi-main">
            <span class="hi-idx">Step ${s.index + 1}</span>
            <span class="hi-msg">${escapeHtml(s.message)}</span>
          </div>
          <button class="btn btn-sm" data-idx="${s.index}">Rollback</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const data = await api("/api/history/rollback", { method: "POST", body: { index: Number(btn.dataset.idx) } });
          render(data.preview, data.profile);
          toast(data.message);
          historyModal.classList.remove("open");
        } catch (err) { toast(err.message, "err"); }
      });
    });
  } catch (err) {
    list.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
  if (window.lucide) lucide.createIcons();
});
document.getElementById("historyCancel").addEventListener("click", () => historyModal.classList.remove("open"));
document.getElementById("historyClose").addEventListener("click", () => historyModal.classList.remove("open"));
historyModal.addEventListener("click", (e) => { if (e.target === historyModal) historyModal.classList.remove("open"); });

/* ---------------- AI Insights & Storyteller ---------------- */
const insightsModal = document.getElementById("insightsModal");
document.getElementById("insightsBtn").addEventListener("click", async () => {
  insightsModal.classList.add("open");
  const storyBox = document.getElementById("storyBox");
  const cardsBox = document.getElementById("insightCards");
  storyBox.innerHTML = `<span class="muted">Generating narrative…</span>`;
  cardsBox.innerHTML = `<span class="muted">Scanning dataset…</span>`;
  try {
    const [story, insights] = await Promise.all([api("/api/story"), api("/api/insights")]);
    storyBox.innerHTML = story.story.split("\n\n").map((p) => `<p>${escapeHtml(p)}</p>`).join("");
    if (!insights.insights.length) {
      cardsBox.innerHTML = `<span class="muted">No notable anomalies detected — data looks clean.</span>`;
    } else {
      cardsBox.innerHTML = insights.insights
        .map(
          (i) => `<div class="insight-card sev-${i.severity}">
            <div class="ic-title">${escapeHtml(i.title)}</div>
            <div class="ic-desc">${escapeHtml(i.description)}</div>
          </div>`
        )
        .join("");
      localStorage.setItem("dp_insights", JSON.stringify(insights.insights));
    }
  } catch (err) {
    storyBox.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
    cardsBox.innerHTML = "";
  }
});
document.getElementById("insightsCancel").addEventListener("click", () => insightsModal.classList.remove("open"));
document.getElementById("insightsClose").addEventListener("click", () => insightsModal.classList.remove("open"));
insightsModal.addEventListener("click", (e) => { if (e.target === insightsModal) insightsModal.classList.remove("open"); });

/* ---------------- Schema suggestions ---------------- */
const schemaModal = document.getElementById("schemaModal");
document.getElementById("schemaBtn").addEventListener("click", async () => {
  schemaModal.classList.add("open");
  await loadSchemaSuggestions();
});
async function loadSchemaSuggestions() {
  const list = document.getElementById("schemaList");
  list.innerHTML = `<span class="muted">Analysing columns…</span>`;
  try {
    const data = await api("/api/schema-suggestions");
    if (!data.suggestions.length) {
      list.innerHTML = `<span class="muted">No conversions suggested — types look correct.</span>`;
      return;
    }
    list.innerHTML = data.suggestions
      .map(
        (s) => `<div class="history-item">
          <div class="hi-main">
            <span class="hi-idx">${escapeHtml(s.column)}</span>
            <span class="hi-msg">${escapeHtml(s.current_dtype)} → <b>${escapeHtml(s.suggested_type)}</b><br/><span class="muted" style="font-size:.78rem;">${escapeHtml(s.reason)}</span></span>
          </div>
          <button class="btn btn-sm btn-primary" data-col="${escapeHtml(s.column)}" data-action="${s.action}">Apply</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const data = await api("/api/schema-suggestions/apply", {
            method: "POST",
            body: { column: btn.dataset.col, action: btn.dataset.action },
          });
          render(data.preview, data.profile);
          toast(data.message);
          loadSchemaSuggestions();
        } catch (err) { toast(err.message, "err"); }
      });
    });
  } catch (err) {
    list.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
}
document.getElementById("schemaCancel").addEventListener("click", () => schemaModal.classList.remove("open"));
document.getElementById("schemaClose").addEventListener("click", () => schemaModal.classList.remove("open"));
schemaModal.addEventListener("click", (e) => { if (e.target === schemaModal) schemaModal.classList.remove("open"); });

/* ---------------- Merge datasets ---------------- */
const mergeModal = document.getElementById("mergeModal");
let mergeFile = null;
document.getElementById("mergeBtn").addEventListener("click", () => {
  mergeModal.classList.add("open");
  document.getElementById("mergeMatches").innerHTML = "";
  document.getElementById("mergeKeysRow").style.display = "none";
  document.getElementById("mergeHowField").style.display = "none";
  document.getElementById("mergeApply").classList.add("hidden");
  document.getElementById("mergeFileInput").value = "";
  mergeFile = null;
});
document.getElementById("mergeCancel").addEventListener("click", () => mergeModal.classList.remove("open"));
document.getElementById("mergeClose").addEventListener("click", () => mergeModal.classList.remove("open"));
mergeModal.addEventListener("click", (e) => { if (e.target === mergeModal) mergeModal.classList.remove("open"); });
document.getElementById("mergeFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  mergeFile = file;
  const matchesBox = document.getElementById("mergeMatches");
  matchesBox.innerHTML = `<span class="muted">Detecting relationships…</span>`;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const data = await api("/api/relationships", { method: "POST", body: fd, isForm: true });
    if (!data.matches.length) {
      matchesBox.innerHTML = `<span class="muted">No strong join-key matches found — pick columns manually below.</span>`;
    } else {
      matchesBox.innerHTML = `<div class="muted" style="font-size:.82rem;margin-bottom:6px;">Suggested join keys (highest confidence first):</div>` +
        data.matches
          .map(
            (m) => `<div class="history-item">
              <div class="hi-main"><span class="hi-idx">${m.score}%</span>
              <span class="hi-msg">'${escapeHtml(m.left)}' ↔ '${escapeHtml(m.right)}'</span></div>
              <button class="btn btn-sm" data-left="${escapeHtml(m.left)}" data-right="${escapeHtml(m.right)}">Use</button>
            </div>`
          )
          .join("");
    }
    const leftSel = document.getElementById("mergeLeft");
    const rightSel = document.getElementById("mergeRight");
    leftSel.innerHTML = currentProfile.columns.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    rightSel.innerHTML = data.columns2.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    matchesBox.querySelectorAll("button[data-left]").forEach((btn) => {
      btn.addEventListener("click", () => {
        leftSel.value = btn.dataset.left;
        rightSel.value = btn.dataset.right;
      });
    });
    document.getElementById("mergeKeysRow").style.display = "flex";
    document.getElementById("mergeHowField").style.display = "block";
    document.getElementById("mergeApply").classList.remove("hidden");
  } catch (err) {
    matchesBox.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
});
document.getElementById("mergeApply").addEventListener("click", async () => {
  if (!mergeFile) return;
  const fd = new FormData();
  fd.append("file", mergeFile);
  fd.append("left_on", document.getElementById("mergeLeft").value);
  fd.append("right_on", document.getElementById("mergeRight").value);
  fd.append("how", document.getElementById("mergeHow").value);
  try {
    const data = await api("/api/merge", { method: "POST", body: fd, isForm: true });
    render(data.preview, data.profile);
    toast(data.message);
    mergeModal.classList.remove("open");
  } catch (err) { toast(err.message, "err"); }
});

/* ---------------- Profiling PDF report ---------------- */
document.getElementById("reportPdfBtn").addEventListener("click", async () => {
  toast("Generating profiling report…");
  try {
    const blob = await api(`/api/profile-report?sid=${Session.get()}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${Session.filename()}_profile_report.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Profile report downloaded");
  } catch (err) { toast(err.message, "err"); }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  [historyModal, insightsModal, schemaModal, mergeModal].forEach((m) => m.classList.remove("open"));
});

/* ---------------- Init ---------------- */
async function init() {
  if (!(await requireLogin())) return;
  if (Session.get()) {
    try {
      const [preview, profile, sheets] = await Promise.all([
        api("/api/preview"),
        api("/api/profile"),
        api("/api/sheets"),
      ]);
      render(preview, profile, sheets.active_sheet, sheets.sheets, sheets.active_sheet);
      showEditor();
    } catch (_) {
      Session.clear();
    }
  }
  checkAiStatus();
  if (window.lucide) lucide.createIcons();
}
init();
