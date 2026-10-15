/* common.js — shared helpers for DataPilot AI (session, API, toasts) */

const API = "";  // same origin (Flask serves the frontend)

const Session = {
  get() { return localStorage.getItem("dp_session"); },
  set(id) { if (id) localStorage.setItem("dp_session", id); },
  clear() { localStorage.removeItem("dp_session"); },
  filename(name) {
    if (name !== undefined) localStorage.setItem("dp_filename", name);
    return localStorage.getItem("dp_filename") || "dataset";
  },
};

async function api(path, { method = "GET", body = null, isForm = false } = {}) {
  const headers = {};
  const sid = Session.get();
  if (sid) headers["X-Session-Id"] = sid;
  if (!isForm && body) headers["Content-Type"] = "application/json";

  const res = await fetch(API + path, {
    method,
    headers,
    credentials: "same-origin",
    body: isForm ? body : body ? JSON.stringify(body) : null,
  });

  let data;
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) data = await res.json();
  else data = await res.blob();

  if (!res.ok) {
    const msg = data && data.error ? data.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/* ---- Toasts ---- */
function toast(message, type = "ok") {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.className = `toast neo ${type === "err" ? "err" : "ok"}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/* ---- Navbar (injected on every page) ---- */
async function renderNavbar(active) {
  const nav = document.getElementById("navbar");
  if (!nav) return;
  nav.innerHTML = `
    <a class="brand" href="/">
      <img src="/Images/DataPilot AI Logo.png" alt="DataPilot AI"/>
    </a>
    <div class="nav-links" id="navLinks">
      <a href="/" class="${active === "home" ? "active" : ""}">Home</a>
      <a href="/editor.html" class="${active === "editor" ? "active" : ""}">Editor</a>
      <a href="/dashboard.html" class="${active === "dashboard" ? "active" : ""}">Dashboard</a>
    </div>`;
  if (window.lucide) lucide.createIcons();

  try {
    const data = await api("/api/auth/me");
    const u = data.user;
    const link = document.createElement("a");
    link.href = "/profile.html";
    link.className = `nav-profile-link ${active === "profile" ? "active" : ""}`;
    link.innerHTML = `<img src="${u.avatar || `https://ui-avatars.com/api/?background=3b7df6&color=fff&size=64&name=${encodeURIComponent(u.name || u.email)}`}" alt=""/> ${u.name || u.email}`;
    document.getElementById("navLinks").appendChild(link);
  } catch (_) {
    if (active !== "login" && active !== "signup") {
      const a = document.createElement("a");
      a.href = "/login.html";
      a.className = "btn btn-primary btn-sm";
      a.textContent = "Log in";
      document.getElementById("navLinks").appendChild(a);
    }
  }
}

/* Redirect to /login.html if not authenticated. Call at the top of a
   protected page's init(). Returns true if the user is logged in. */
async function requireLogin() {
  try {
    await api("/api/auth/me");
    return true;
  } catch (_) {
    window.location.href = "/login.html";
    return false;
  }
}

function requireDataset(redirect = "/editor.html") {
  if (!Session.get()) {
    toast("Please upload a dataset first.", "err");
    setTimeout(() => (window.location.href = redirect), 1200);
    return false;
  }
  return true;
}

document.addEventListener("DOMContentLoaded", () => {
  if (window.lucide) lucide.createIcons();
});
