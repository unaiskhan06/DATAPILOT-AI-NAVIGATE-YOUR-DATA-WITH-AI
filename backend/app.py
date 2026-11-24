"""
app.py
DataPilot AI — Flask backend.

Serves the static frontend and exposes a JSON API for:
  * uploading CSV / Excel datasets
  * manual (Editor mode) cleaning operations
  * AI (Agent mode) prompt-based editing
  * undo history
  * dataset profiling + dashboard recommendations
  * chart aggregation
  * downloading the cleaned file (csv / xlsx)

Datasets are held in-memory per browser session (fine for a local single-user app).
"""
from __future__ import annotations

import io
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote_plus, urlencode

import requests
from dotenv import load_dotenv
from flask import (
    Flask,
    jsonify,
    redirect,
    request,
    send_file,
    send_from_directory,
    session,
)
from flask_cors import CORS
from PIL import Image, ImageOps
from werkzeug.middleware.proxy_fix import ProxyFix

import auth
import data_ops
import llm_agent
import report

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")
IMAGES_DIR = os.path.join(os.path.dirname(BASE_DIR), "Images")
SCREEN_UPLOAD_DIR = Path(BASE_DIR) / "uploads"
SCREEN_UPLOAD_DIR.mkdir(exist_ok=True)
MAX_SCREEN_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_SCREEN_DIMENSION = 2048
MAX_STORED_SCREENS = 50
SCREEN_FILE_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg)$")
ALLOWED_SCREEN_FORMATS = {"PNG", "JPEG", "WEBP"}
Image.MAX_IMAGE_PIXELS = 40_000_000

app = Flask(__name__, static_folder=None)
# Render (and Heroku, nginx, AWS ELB, ...) terminate TLS at a proxy and forward
# to us over plain HTTP with X-Forwarded-* headers. Without ProxyFix, Flask
# ignores those headers, so request.host_url resolves to http://<internal-host>
# instead of https://<service>.onrender.com. That breaks the Google OAuth
# redirect_uri (http vs https mismatch) and verification email links.
# x_for/x_proto/x_host/x_port=1 trusts one layer of proxying (Render's).
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB uploads
app.secret_key = os.getenv("APP_SECRET_KEY", "dev-insecure-secret-change-me")
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# In production (HTTPS) mark the cookie Secure so it's never sent over plain
# HTTP. Locally we keep it off so login works on http://127.0.0.1:5000.
_is_production = os.getenv("RENDER", "") != "" or os.getenv("DYNO", "") != ""
app.config["SESSION_COOKIE_SECURE"] = _is_production
CORS(app, supports_credentials=True)

auth.init_db()

# session_id -> { "df": DataFrame, "history": [DataFrame,...], "filename": str }
SESSIONS: dict[str, dict] = {}
MAX_HISTORY = 25


# --------------------------------------------------------------------------- #
#  Session helpers
# --------------------------------------------------------------------------- #
def _get_session(create: bool = False):
    sid = request.headers.get("X-Session-Id") or request.args.get("sid")
    if not sid:
        if not create:
            return None, None
        sid = uuid.uuid4().hex
    session = SESSIONS.get(sid)
    if session is not None:
        session.setdefault("sheets", {})
        session.setdefault("active_sheet", None)
    if session is None and create:
        session = {
            "df": None,
            "history": [],
            "log": [],
            "filename": "dataset",
            "sheets": {},
            "active_sheet": None,
        }
        SESSIONS[sid] = session
    return sid, session


def _unique_sheet_name(session, filename: str) -> str:
    base = os.path.splitext(filename)[0].strip() or "dataset"
    name = base
    n = 2
    while name in session["sheets"]:
        name = f"{base} ({n})"
        n += 1
    return name


def _sync_active_sheet(session):
    active = session.get("active_sheet")
    if active and active in session.get("sheets", {}):
        session["sheets"][active] = session["df"]


def _push_history(session, message: str | None = None):
    if session["df"] is not None:
        session["history"].append(session["df"].copy())
        session.setdefault("log", []).append(
            {"message": message or "Change applied", "ts": time.time()}
        )
        if len(session["history"]) > MAX_HISTORY:
            session["history"].pop(0)
            session["log"].pop(0)


def _require_df():
    sid, session = _get_session()
    if not session or session["df"] is None:
        return None, None, (jsonify({"error": "No dataset loaded."}), 400)
    return sid, session, None


# --------------------------------------------------------------------------- #
#  Static frontend
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/ping")
def ping():
    return jsonify({"status": "ok"})


@app.route("/<path:path>")
def static_proxy(path):
    full = os.path.join(FRONTEND_DIR, path)
    if os.path.isfile(full):
        return send_from_directory(FRONTEND_DIR, path)
    # SPA-style fallback for html routes
    if not path.startswith("api"):
        candidate = path if path.endswith(".html") else f"{path}.html"
        if os.path.isfile(os.path.join(FRONTEND_DIR, candidate)):
            return send_from_directory(FRONTEND_DIR, candidate)
    return jsonify({"error": "Not found"}), 404


@app.route("/Images/<path:path>")
def images(path):
    return send_from_directory(IMAGES_DIR, path)


# --------------------------------------------------------------------------- #
#  Authentication (email/password w/ verification, + Google login)
# --------------------------------------------------------------------------- #
def _is_localhost_url(value: str) -> bool:
    """True for URLs pointing at the local machine (127.0.0.1 / localhost / 0.0.0.0)."""
    v = (value or "").lower()
    return "127.0.0.1" in v or "localhost" in v or "0.0.0.0" in v


def _app_base_url() -> str:
    """Public base URL of this app.

    A stale APP_BASE_URL pointing at localhost (e.g. copied from a local .env,
    or a committed backend/.env that load_dotenv picks up on the server) would
    send Google's OAuth callback and verification links to the *user's own PC*
    instead of the deployed site. Ignore localhost overrides when we are not
    actually serving from localhost, and fall back to the real request host.
    """
    configured = os.getenv("APP_BASE_URL", "").strip().rstrip("/")
    actual = request.host_url.rstrip("/")
    if configured and not (_is_localhost_url(configured) and not _is_localhost_url(actual)):
        return configured
    return actual


def _google_redirect_uri() -> str:
    """Redirect URI handed to Google. Same localhost-override guard as above."""
    configured = os.getenv("GOOGLE_REDIRECT_URI", "").strip()
    actual_host = request.host_url.rstrip("/")
    if configured and not (_is_localhost_url(configured) and not _is_localhost_url(actual_host)):
        return configured
    return f"{_app_base_url()}/api/auth/google/callback"


def _current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return auth.get_user_by_id(uid)


@app.route("/api/auth/me")
def auth_me():
    user = _current_user()
    if not user:
        return jsonify({"error": "Not logged in."}), 401
    return jsonify({"user": auth.public_user(user)})


@app.route("/api/auth/signup", methods=["POST"])
def auth_signup():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    name = (body.get("name") or "").strip()
    if not email or "@" not in email:
        return jsonify({"error": "Enter a valid email address."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    try:
        auth.create_local_user(email, password, name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    token = auth.generate_verify_token(email)
    link = f"{_app_base_url()}/api/auth/verify/{token}"
    sent = auth.send_verification_email(email, link)
    resp = {"message": "Account created. Check your email to verify your address before logging in."}
    if not sent:
        resp["dev_verify_link"] = link  # SMTP not configured — surface link for local testing
    return jsonify(resp)


@app.route("/api/auth/verify/<token>")
def auth_verify(token):
    email = auth.confirm_verify_token(token)
    if not email:
        return redirect("/login.html?error=Verification+link+is+invalid+or+expired")
    auth.mark_verified(email)
    return redirect("/login.html?verified=1")


@app.route("/api/auth/resend-verification", methods=["POST"])
def auth_resend():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip()
    user = auth.get_user_by_email(email)
    if not user or user["provider"] != "local":
        return jsonify({"error": "No local account found with this email."}), 400
    if user["verified"]:
        return jsonify({"message": "This email is already verified."})
    token = auth.generate_verify_token(email)
    link = f"{_app_base_url()}/api/auth/verify/{token}"
    sent = auth.send_verification_email(email, link)
    resp = {"message": "Verification email sent."}
    if not sent:
        resp["dev_verify_link"] = link
    return jsonify(resp)


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    user, error = auth.verify_local_login(email, password)
    if error:
        return jsonify({"error": error}), 401
    session["user_id"] = user["id"]
    return jsonify({"user": auth.public_user(user)})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.pop("user_id", None)
    return jsonify({"message": "Logged out."})


@app.route("/api/auth/google/status")
def auth_google_status():
    configured = bool(os.getenv("GOOGLE_CLIENT_ID") and os.getenv("GOOGLE_CLIENT_SECRET"))
    return jsonify({"configured": configured})


@app.route("/api/auth/google/login")
def auth_google_login():
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    if not client_id:
        return redirect("/login.html?error=" + quote_plus(
            "Google login is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env."
        ))
    redirect_uri = _google_redirect_uri()
    query = urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "prompt": "select_account",
        "access_type": "online",
    })
    return redirect(f"https://accounts.google.com/o/oauth2/v2/auth?{query}")


@app.route("/api/auth/google/callback")
def auth_google_callback():
    error = request.args.get("error")
    if error:
        return redirect("/login.html?error=" + quote_plus(error))
    code = request.args.get("code")
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = _google_redirect_uri()
    if not code or not client_id or not client_secret:
        return redirect("/login.html?error=" + quote_plus("Google login is not configured"))

    token_res = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=10,
    )
    if not token_res.ok:
        return redirect("/login.html?error=Google+authentication+failed")
    access_token = token_res.json().get("access_token")

    info_res = requests.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    if not info_res.ok:
        return redirect("/login.html?error=Could+not+fetch+Google+profile")
    info = info_res.json()

    email = (info.get("email") or "").strip()
    if not email:
        return redirect("/login.html?error=" + quote_plus("Google did not return an email address for this account."))
    user = auth.find_or_create_google_user(
        email=email, name=info.get("name") or email, avatar=info.get("picture")
    )
    session["user_id"] = user["id"]
    return redirect("/editor.html")


def _require_login():
    user = _current_user()
    if not user:
        return jsonify({"error": "Login required."}), 401
    return None


# --------------------------------------------------------------------------- #
#  API
# --------------------------------------------------------------------------- #
@app.route("/api/ai-status")
def ai_status():
    return jsonify({"available": llm_agent.is_available()})


def _stored_screens():
    files = [
        path
        for path in SCREEN_UPLOAD_DIR.iterdir()
        if SCREEN_FILE_RE.match(path.name)
    ]
    return sorted(files, key=lambda path: path.stat().st_mtime, reverse=True)


def _prune_screens():
    for old in _stored_screens()[MAX_STORED_SCREENS:]:
        try:
            old.unlink()
        except OSError:
            pass


@app.route("/api/upload", methods=["POST"])
def upload():
    image_file = request.files.get("image")
    if image_file is not None:
        if image_file.filename == "":
            return jsonify({"error": "No image provided."}), 400
        if request.content_length and request.content_length > MAX_SCREEN_UPLOAD_BYTES:
            return jsonify({"error": "Image is too large (max 10 MB)."}), 413

        try:
            probe = Image.open(image_file.stream)
            if probe.format not in ALLOWED_SCREEN_FORMATS:
                return jsonify({"error": "Only PNG, JPG or WEBP images are allowed."}), 400
            probe.verify()

            image_file.stream.seek(0)
            img = ImageOps.exif_transpose(Image.open(image_file.stream))
            img.thumbnail((MAX_SCREEN_DIMENSION, MAX_SCREEN_DIMENSION), Image.Resampling.LANCZOS)

            has_alpha = img.mode in ("RGBA", "LA") or "transparency" in img.info
            file_id = uuid.uuid4().hex
            if has_alpha:
                name = f"{file_id}.png"
                img.convert("RGBA").save(SCREEN_UPLOAD_DIR / name, "PNG", optimize=True)
            else:
                name = f"{file_id}.jpg"
                img.convert("RGB").save(SCREEN_UPLOAD_DIR / name, "JPEG", quality=90, optimize=True)
        except Exception:
            return jsonify({"error": "That file is not a valid image."}), 400

        _prune_screens()
        return jsonify({"id": name, "url": f"/uploads/{name}"}), 201

    login_err = _require_login()
    if login_err:
        return login_err
    if "file" not in request.files:
        return jsonify({"error": "No file provided."}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename."}), 400
    try:
        df = data_ops.load_dataframe(file)
    except Exception as exc:
        return jsonify({"error": f"Could not read file: {exc}"}), 400

    sid, session = _get_session(create=True)
    name = _unique_sheet_name(session, file.filename)
    session["sheets"] = {name: df}
    session["active_sheet"] = name
    session["df"] = df
    session["history"] = []
    session["filename"] = name

    return jsonify(
        {
            "session_id": sid,
            "filename": name,
            "active_sheet": name,
            "sheets": list(session["sheets"].keys()),
            "preview": data_ops.preview(df),
            "profile": data_ops.profile(df),
        }
    )


@app.route("/api/screens")
def list_screens():
    return jsonify(
        {
            "screens": [
                {"id": path.name, "url": f"/uploads/{path.name}"}
                for path in _stored_screens()[:24]
            ]
        }
    )


@app.route("/api/screens/<name>", methods=["DELETE"])
def delete_screen(name):
    if not SCREEN_FILE_RE.match(name):
        return jsonify({"error": "Not found."}), 404
    path = SCREEN_UPLOAD_DIR / name
    if not path.exists():
        return jsonify({"error": "Not found."}), 404
    path.unlink()
    return jsonify({"deleted": name})


@app.route("/uploads/<name>")
def serve_screen(name):
    if not SCREEN_FILE_RE.match(name):
        return jsonify({"error": "Not found."}), 404
    if not (SCREEN_UPLOAD_DIR / name).is_file():
        return jsonify({"error": "Not found."}), 404
    return send_from_directory(str(SCREEN_UPLOAD_DIR), name, max_age=3600)


@app.route("/api/add-sheet", methods=["POST"])
def add_sheet():
    login_err = _require_login()
    if login_err:
        return login_err
    sid, session = _get_session()
    if not session:
        return jsonify({"error": "No session. Upload a file first."}), 400
    if "file" not in request.files:
        return jsonify({"error": "No file provided."}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename."}), 400
    try:
        df = data_ops.load_dataframe(file)
    except Exception as exc:
        return jsonify({"error": f"Could not read file: {exc}"}), 400

    name = _unique_sheet_name(session, file.filename)
    session["sheets"][name] = df
    session["active_sheet"] = name
    session["df"] = df
    session["history"] = []
    session["filename"] = name

    return jsonify(
        {
            "session_id": sid,
            "filename": name,
            "active_sheet": name,
            "sheets": list(session["sheets"].keys()),
            "preview": data_ops.preview(df),
            "profile": data_ops.profile(df),
        }
    )


@app.route("/api/sheets", methods=["GET"])
def list_sheets():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify(
        {
            "sheets": list(session["sheets"].keys()),
            "active_sheet": session["active_sheet"],
        }
    )


@app.route("/api/switch-sheet", methods=["POST"])
def switch_sheet():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    name = body.get("sheet")
    if not name or name not in session["sheets"]:
        return jsonify({"error": "Sheet not found."}), 400
    df = session["sheets"][name]
    session["df"] = df
    session["active_sheet"] = name
    session["filename"] = name
    session["history"] = []

    return jsonify(
        {
            "filename": name,
            "active_sheet": name,
            "sheets": list(session["sheets"].keys()),
            "preview": data_ops.preview(df),
            "profile": data_ops.profile(df),
        }
    )


@app.route("/api/remove-sheet", methods=["POST"])
def remove_sheet():
    sid, session = _get_session()
    if not session:
        return jsonify({"error": "No session."}), 400
    body = request.get_json(force=True) or {}
    name = body.get("sheet")
    if not name or name not in session.get("sheets", {}):
        return jsonify({"error": "Sheet not found."}), 400
    del session["sheets"][name]
    if session["active_sheet"] == name:
        session["active_sheet"] = None
        session["df"] = None
        session["filename"] = "dataset"
        session["history"] = []
        session["log"] = []
        remaining = list(session["sheets"].keys())
        if remaining:
            new_name = remaining[0]
            session["active_sheet"] = new_name
            session["df"] = session["sheets"][new_name]
            session["filename"] = new_name
            return jsonify(
                {
                    "filename": new_name,
                    "active_sheet": new_name,
                    "sheets": remaining,
                    "preview": data_ops.preview(session["df"]),
                    "profile": data_ops.profile(session["df"]),
                }
            )
        return jsonify({"sheets": [], "active_sheet": None})
    return jsonify(
        {
            "filename": session["filename"],
            "active_sheet": session["active_sheet"],
            "sheets": list(session["sheets"].keys()),
            "preview": data_ops.preview(session["df"]),
            "profile": data_ops.profile(session["df"]),
        }
    )


@app.route("/api/preview")
def get_preview():
    sid, session, err = _require_df()
    if err:
        return err
    limit_arg = request.args.get("limit")
    limit = int(limit_arg) if limit_arg else None
    return jsonify(data_ops.preview(session["df"], limit))


@app.route("/api/profile")
def get_profile():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify(data_ops.profile(session["df"]))


@app.route("/api/operation", methods=["POST"])
def operation():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    name = body.get("name")
    params = body.get("params", {})

    new_df, message = data_ops.apply_operation(session["df"], name, params)
    _push_history(session, message)
    session["df"] = new_df
    _sync_active_sheet(session)
    return jsonify(
        {
            "message": message,
            "preview": data_ops.preview(new_df),
            "profile": data_ops.profile(new_df),
        }
    )


@app.route("/api/agent", methods=["POST"])
def agent():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "Empty prompt."}), 400

    df = session["df"]
    prof = data_ops.profile(df)
    result = llm_agent.interpret(prompt, list(df.columns.astype(str)), prof)

    if result.get("error"):
        return jsonify({"error": result["error"]}), 400

    ops = result.get("operations", [])
    if not ops:
        return jsonify(
            {
                "message": result.get("explanation")
                or "I couldn't map that request to an operation.",
                "applied": [],
                "preview": data_ops.preview(df),
                "profile": prof,
            }
        )

    applied = []
    working = df
    for op in ops:
        working, msg = data_ops.apply_operation(
            working, op.get("name"), op.get("params", {})
        )
        applied.append(msg)
    _push_history(session, result.get("explanation") or "; ".join(applied))
    session["df"] = working
    _sync_active_sheet(session)

    return jsonify(
        {
            "message": result.get("explanation", "Done."),
            "applied": applied,
            "preview": data_ops.preview(working),
            "profile": data_ops.profile(working),
        }
    )


@app.route("/api/undo", methods=["POST"])
def undo():
    sid, session, err = _require_df()
    if err:
        return err
    if not session["history"]:
        return jsonify({"error": "Nothing to undo."}), 400
    session["df"] = session["history"].pop()
    _sync_active_sheet(session)
    if session.get("log"):
        session["log"].pop()
    return jsonify(
        {
            "message": "Reverted last change.",
            "preview": data_ops.preview(session["df"]),
            "profile": data_ops.profile(session["df"]),
        }
    )


@app.route("/api/recommend")
def recommend():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify({"recommendations": data_ops.recommend_charts(session["df"])})


@app.route("/api/chart-data", methods=["POST"])
def chart_data():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    df = data_ops.apply_filters(session["df"], body.get("filters"))
    data = data_ops.chart_payload(
        df,
        chart_type=body.get("type", "bar"),
        x=body.get("x"),
        y=body.get("y"),
        agg=body.get("agg", "count"),
        series=body.get("series"),
        y2=body.get("y2"),
        agg2=body.get("agg2"),
    )
    return jsonify(data)


@app.route("/api/kpi", methods=["POST"])
def kpi():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    df = data_ops.apply_filters(session["df"], body.get("filters"))
    return jsonify(data_ops.kpi_value(df, body.get("column"), body.get("agg", "sum")))


@app.route("/api/pivot", methods=["POST"])
def pivot():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    df = data_ops.apply_filters(session["df"], body.get("filters"))
    return jsonify(
        data_ops.pivot_table_data(
            df,
            index=body.get("index"),
            columns=body.get("columns"),
            values=body.get("values"),
            agg=body.get("agg", "count"),
        )
    )


@app.route("/api/column-values")
def get_column_values():
    sid, session, err = _require_df()
    if err:
        return err
    column = request.args.get("col", "")
    return jsonify({"values": data_ops.column_values(session["df"], column)})


@app.route("/api/history")
def get_history():
    sid, session, err = _require_df()
    if err:
        return err
    log = session.get("log", [])
    steps = [
        {"index": i, "message": entry["message"], "ts": entry["ts"]}
        for i, entry in enumerate(log)
    ]
    return jsonify({"steps": steps})


@app.route("/api/history/rollback", methods=["POST"])
def rollback_history():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    index = body.get("index")
    history = session.get("history", [])
    log = session.get("log", [])
    if index is None or not (0 <= int(index) < len(history)):
        return jsonify({"error": "Invalid history index."}), 400
    index = int(index)
    session["df"] = history[index]
    _sync_active_sheet(session)
    session["history"] = history[:index]
    session["log"] = log[:index]
    return jsonify(
        {
            "message": f"Rolled back to step {index + 1}.",
            "preview": data_ops.preview(session["df"]),
            "profile": data_ops.profile(session["df"]),
        }
    )


# --------------------------------------------------------------------------- #
#  AI insights & storyteller
# --------------------------------------------------------------------------- #
@app.route("/api/insights")
def get_insights():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify({"insights": data_ops.generate_insights(session["df"])})


@app.route("/api/story")
def get_story():
    sid, session, err = _require_df()
    if err:
        return err
    df = session["df"]
    prof = data_ops.profile(df)
    insights = data_ops.generate_insights(df)
    result = llm_agent.generate_story(prof, insights)
    return jsonify(result)


# --------------------------------------------------------------------------- #
#  Schema auto-detection
# --------------------------------------------------------------------------- #
@app.route("/api/schema-suggestions")
def get_schema_suggestions():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify({"suggestions": data_ops.schema_suggestions(session["df"])})


@app.route("/api/schema-suggestions/apply", methods=["POST"])
def apply_schema_suggestion_route():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    new_df, message = data_ops.apply_schema_suggestion(
        session["df"], body.get("column"), body.get("action")
    )
    _push_history(session, message)
    session["df"] = new_df
    _sync_active_sheet(session)
    return jsonify(
        {
            "message": message,
            "preview": data_ops.preview(new_df),
            "profile": data_ops.profile(new_df),
        }
    )


# --------------------------------------------------------------------------- #
#  Multi-file relationship detection & merge
# --------------------------------------------------------------------------- #
@app.route("/api/relationships", methods=["POST"])
def relationships():
    sid, session, err = _require_df()
    if err:
        return err
    if "file" not in request.files:
        return jsonify({"error": "No second file provided."}), 400
    try:
        df2 = data_ops.load_dataframe(request.files["file"])
    except Exception as exc:
        return jsonify({"error": f"Could not read file: {exc}"}), 400
    matches = data_ops.detect_relationships(session["df"], df2)
    return jsonify({"matches": matches, "columns2": list(df2.columns.astype(str))})


@app.route("/api/merge", methods=["POST"])
def merge():
    sid, session, err = _require_df()
    if err:
        return err
    if "file" not in request.files:
        return jsonify({"error": "No second file provided."}), 400
    left_on = request.form.get("left_on")
    right_on = request.form.get("right_on")
    how = request.form.get("how", "inner")
    try:
        df2 = data_ops.load_dataframe(request.files["file"])
    except Exception as exc:
        return jsonify({"error": f"Could not read file: {exc}"}), 400
    new_df, message = data_ops.merge_dataframes(session["df"], df2, left_on, right_on, how)
    _push_history(session, message)
    session["df"] = new_df
    _sync_active_sheet(session)
    return jsonify(
        {
            "message": message,
            "preview": data_ops.preview(new_df),
            "profile": data_ops.profile(new_df),
        }
    )


# --------------------------------------------------------------------------- #
#  Geo-map
# --------------------------------------------------------------------------- #
@app.route("/api/geo-columns")
def get_geo_columns():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify({"columns": data_ops.geo_columns(session["df"])})


@app.route("/api/geo-data", methods=["POST"])
def get_geo_data():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    df = data_ops.apply_filters(session["df"], body.get("filters"))
    return jsonify(
        data_ops.geo_aggregate(
            df, body.get("column"), body.get("value_col"), body.get("agg", "count")
        )
    )


# --------------------------------------------------------------------------- #
#  Profiling PDF report / PPTX slide-deck export
# --------------------------------------------------------------------------- #
@app.route("/api/profile-report")
def profile_report():
    sid, session, err = _require_df()
    if err:
        return err
    df = session["df"]
    prof = data_ops.profile(df)
    insights = data_ops.generate_insights(df)
    story = llm_agent.generate_story(prof, insights).get("story", "")
    pdf_bytes = report.build_profile_pdf(session.get("filename", "dataset"), prof, insights, story)
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{session.get('filename','dataset')}_profile_report.pdf",
    )


@app.route("/api/pptx", methods=["POST"])
def pptx_export():
    sid, session, err = _require_df()
    if err:
        return err
    body = request.get_json(force=True) or {}
    slides = body.get("slides", [])
    title = body.get("title") or session.get("filename", "Dashboard")
    logo = body.get("logo")
    pptx_bytes = report.build_pptx(title, slides, logo=logo)
    return send_file(
        io.BytesIO(pptx_bytes),
        mimetype="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        as_attachment=True,
        download_name=f"{session.get('filename','dashboard')}_slides.pptx",
    )


# --------------------------------------------------------------------------- #
#  Dashboard layout persistence (so shared links show the real dashboard)
# --------------------------------------------------------------------------- #
@app.route("/api/layout", methods=["GET"])
def get_layout():
    sid, session = _get_session()
    if not session:
        return jsonify({"widgets": [], "format": None})
    return jsonify(
        {"widgets": session.get("layout", []), "format": session.get("page_format")}
    )


@app.route("/api/layout", methods=["POST"])
def save_layout():
    sid, session = _get_session(create=True)
    body = request.get_json(force=True) or {}
    session["layout"] = body.get("widgets", [])
    if body.get("format") is not None:
        session["page_format"] = body.get("format")
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
#  Scheduled auto-refresh (remote CSV/Excel URL)
# --------------------------------------------------------------------------- #
@app.route("/api/refresh-url", methods=["POST"])
def refresh_url():
    login_err = _require_login()
    if login_err:
        return login_err
    sid, session = _get_session(create=True)
    body = request.get_json(force=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400
    try:
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        return jsonify({"error": f"Could not fetch URL: {exc}"}), 400

    class _Stub:
        filename = url.split("?")[0]

        def __init__(self, data):
            self._data = data

        def read(self):
            return self._data

    try:
        df = data_ops.load_dataframe(_Stub(resp.content))
    except Exception as exc:
        return jsonify({"error": f"Could not parse dataset: {exc}"}), 400

    session["df"] = df
    session["history"] = []
    session["log"] = []
    session["filename"] = session.get("filename") or "remote_dataset"
    if not session.get("active_sheet"):
        session["active_sheet"] = session["filename"]
    _sync_active_sheet(session)
    return jsonify(
        {
            "session_id": sid,
            "message": f"Refreshed from {url} — {len(df)} row(s) loaded.",
            "preview": data_ops.preview(df),
            "profile": data_ops.profile(df),
        }
    )


# --------------------------------------------------------------------------- #
#  Shareable session link
# --------------------------------------------------------------------------- #
@app.route("/api/share")
def share():
    sid, session, err = _require_df()
    if err:
        return err
    return jsonify({"session_id": sid})


@app.route("/api/download")
def download():
    sid, session, err = _require_df()
    if err:
        return err
    fmt = request.args.get("format", "csv").lower()
    name = session.get("filename", "dataset") + "_cleaned"
    if fmt in ("xlsx", "excel"):
        payload = data_ops.dataframe_to_excel_bytes(session["df"])
        return send_file(
            io.BytesIO(payload),
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=f"{name}.xlsx",
        )
    payload = data_ops.dataframe_to_csv_bytes(session["df"])
    return send_file(
        io.BytesIO(payload),
        mimetype="text/csv",
        as_attachment=True,
        download_name=f"{name}.csv",
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    host = os.getenv("HOST", "127.0.0.1")
    # In production (Render/Heroku/etc.), bind to all interfaces and disable the
    # reloader. Locally we keep the convenient 127.0.0.1 + debug behaviour, but
    # disable the stat reloader so editing files doesn't kill the running server
    # mid-request (which caused intermittent ERR_CONNECTION_REFUSED on the
    # Google OAuth callback). Restart the server manually to pick up changes.
    is_prod = os.getenv("RENDER", "") != "" or os.getenv("DYNO", "") != ""
    debug = not is_prod
    if is_prod:
        host = "0.0.0.0"
    print(f" * DataPilot AI running at http://{host}:{port}")
    print(f" * AI Agent enabled: {llm_agent.is_available()}")
    app.run(host=host, port=port, debug=debug, use_reloader=False)
