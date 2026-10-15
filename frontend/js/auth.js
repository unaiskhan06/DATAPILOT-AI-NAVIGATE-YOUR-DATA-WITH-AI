/* auth.js — shared helper for the login / signup pages */

function showAuthAlert(el, message, type = "err") {
  if (!el) return;
  el.textContent = message;
  el.className = `auth-alert ${type === "err" ? "err" : "ok"}`;
  el.style.display = "block";
  el.classList.remove("hidden");
}

async function initGoogleButton(btn, alertBox) {
  if (!btn) return;
  try {
    const data = await api("/api/auth/google/status");
    if (data && data.configured) return;
  } catch (_) { /* treat as unconfigured */ }

  btn.classList.add("is-disabled");
  btn.setAttribute("aria-disabled", "true");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    showAuthAlert(
      alertBox,
      "Google login is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env, then restart the server.",
      "err"
    );
  });
}
