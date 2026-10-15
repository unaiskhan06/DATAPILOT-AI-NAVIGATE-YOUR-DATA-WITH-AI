"""
auth.py — user accounts: email/password (with email verification) + Google login.

Storage: a small local SQLite DB (users.db). Passwords are hashed (never stored
in plain text). Email verification links are signed tokens (itsdangerous).
"""
from __future__ import annotations

import os
import smtplib
import sqlite3
import time
import uuid
from email.mime.text import MIMEText

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "users.db")

VERIFY_SALT = "dp-email-verify"
VERIFY_MAX_AGE = 60 * 60 * 24  # 24h


def _secret_key() -> str:
    return os.getenv("APP_SECRET_KEY", "dev-insecure-secret-change-me")


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _conn() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                name TEXT,
                password_hash TEXT,
                provider TEXT DEFAULT 'local',
                verified INTEGER DEFAULT 0,
                avatar TEXT,
                created_at REAL
            )"""
        )


def get_user_by_email(email: str):
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()
        return dict(row) if row else None


def get_user_by_id(uid: str):
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return dict(row) if row else None


def create_local_user(email: str, password: str, name: str | None):
    email = email.lower().strip()
    if get_user_by_email(email):
        raise ValueError("An account with this email already exists.")
    uid = uuid.uuid4().hex
    with _conn() as c:
        c.execute(
            "INSERT INTO users (id, email, name, password_hash, provider, verified, created_at) "
            "VALUES (?, ?, ?, ?, 'local', 0, ?)",
            (uid, email, name or email.split("@")[0], generate_password_hash(password), time.time()),
        )
    return get_user_by_email(email)


def verify_local_login(email: str, password: str):
    user = get_user_by_email(email.lower().strip())
    if not user or user["provider"] != "local" or not user["password_hash"]:
        return None, "No account found with this email."
    if not check_password_hash(user["password_hash"], password):
        return None, "Incorrect password."
    if not user["verified"]:
        return None, "Please verify your email before logging in."
    return user, None


def mark_verified(email: str):
    with _conn() as c:
        c.execute("UPDATE users SET verified = 1 WHERE email = ?", (email.lower(),))


def find_or_create_google_user(email: str, name: str, avatar: str | None):
    email = email.lower().strip()
    user = get_user_by_email(email)
    if user:
        return user
    uid = uuid.uuid4().hex
    with _conn() as c:
        c.execute(
            "INSERT INTO users (id, email, name, provider, verified, avatar, created_at) "
            "VALUES (?, ?, ?, 'google', 1, ?, ?)",
            (uid, email, name, avatar, time.time()),
        )
    return get_user_by_email(email)


# --------------------------------------------------------------------------- #
#  Email verification tokens
# --------------------------------------------------------------------------- #
def generate_verify_token(email: str) -> str:
    return URLSafeTimedSerializer(_secret_key()).dumps(email.lower(), salt=VERIFY_SALT)


def confirm_verify_token(token: str):
    try:
        return URLSafeTimedSerializer(_secret_key()).loads(token, salt=VERIFY_SALT, max_age=VERIFY_MAX_AGE)
    except SignatureExpired:
        return None
    except BadSignature:
        return None


# --------------------------------------------------------------------------- #
#  Verification email (falls back to console-logged link if SMTP unset)
# --------------------------------------------------------------------------- #
def send_verification_email(email: str, link: str) -> bool:
    host = os.getenv("SMTP_HOST")
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    port = int(os.getenv("SMTP_PORT", 587))
    sender = os.getenv("SMTP_FROM", user or "no-reply@datapilot.ai")

    if not (host and user and password):
        print(f" * [DEV MODE — SMTP not configured] Verification link for {email}:\n   {link}")
        return False

    msg = MIMEText(
        f"Welcome to DataPilot AI!\n\nVerify your email by clicking the link below:\n{link}\n\n"
        f"This link expires in 24 hours."
    )
    msg["Subject"] = "Verify your DataPilot AI account"
    msg["From"] = sender
    msg["To"] = email

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, password)
        server.sendmail(sender, [email], msg.as_string())
    return True


def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "provider": user["provider"],
        "avatar": user.get("avatar"),
    }
