import base64
import json
import logging
import os
import pathlib
import secrets
import smtplib
import time
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from functools import wraps

from flask import Flask, abort, jsonify, make_response, request
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import mysql.connector
from mysql.connector import errorcode

# ── config ─────────────────────────────────────────────────────────────
DB = dict(
    host=os.environ["DB_HOST"],
    port=int(os.environ.get("DB_PORT", 3306)),
    database=os.environ["DB_NAME"],
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    autocommit=True,
)

SMTP_SERVER   = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT     = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
FROM_EMAIL    = os.getenv("FROM_EMAIL", SMTP_USERNAME)
ADMIN_EMAIL   = os.getenv("ADMIN_EMAIL", "patrick@brigger.com")

# Path prefix the app is mounted at (e.g. "/flight-planner"). Host + scheme
# are derived from the incoming request so cookies match whatever origin
# the pilot is actually using (brigger.com vs www.brigger.com etc).
PATH_PREFIX = os.getenv("PATH_PREFIX", "").rstrip("/")
# Legacy fallback only — used if we can't resolve the request origin.
PUBLIC_URL  = os.getenv("PUBLIC_URL", "").rstrip("/")
SITE_URL    = os.getenv("SITE_URL", PUBLIC_URL or "/").rstrip("/") or "/"

SESSION_COOKIE_NAME   = os.getenv("SESSION_COOKIE_NAME", "velis_session")
# Default secure-by-default. Dev over plain HTTP must opt out via env var.
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "1") == "1"
SESSION_DAYS          = int(os.getenv("SESSION_DAYS", "90"))
VERIFY_HOURS          = 24
LOGIN_LINK_HOURS      = 1

# Sky Demon screenshot import (Claude vision)
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
IMPORT_MODEL      = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
MAX_IMAGE_BYTES   = int(os.getenv("IMPORT_MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))
ANTHROPIC_TIMEOUT = float(os.getenv("ANTHROPIC_TIMEOUT", "30"))

# Cached lazily — first request pays the SDK import + client construction cost.
_anthropic_client = None


def _get_anthropic_client():
    global _anthropic_client
    if _anthropic_client is not None:
        return _anthropic_client
    if not ANTHROPIC_API_KEY:
        return None
    try:
        from anthropic import Anthropic
    except ImportError:
        log.error("anthropic SDK not installed")
        return None
    _anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY, timeout=ANTHROPIC_TIMEOUT)
    return _anthropic_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("velis-backend")

app = Flask(__name__)

# Behind nginx (`proxy_set_header X-Forwarded-For ...`), Flask sees the proxy
# IP unless we trust the forwarded headers. ProxyFix rewrites request.remote_addr
# to the leftmost X-Forwarded-For entry (the actual client) so rate-limit keys
# and audit logs identify the right person.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def _limit_key():
    """Per-user when authenticated (more accurate than per-IP NAT/IPv6 prefix);
    fall back to client IP for unauthenticated endpoints."""
    tok = request.cookies.get(SESSION_COOKIE_NAME)
    if tok:
        return f"user:{tok}"  # 32-byte session token, used only as a key
    return f"ip:{get_remote_address()}"


# Rate limits are per gunicorn worker (in-memory storage). With 2 workers the
# effective rate is ~2× the number stated. Override via env if you need to
# tighten further (e.g. RATELIMIT_IMPORT="5/hour" if Anthropic spend spikes).
limiter = Limiter(
    app=app,
    key_func=_limit_key,
    default_limits=[],  # opt-in per route
    storage_uri="memory://",
    headers_enabled=True,
)


@app.errorhandler(429)
def _ratelimited(err):
    # err.description carries the limit string (e.g. "5 per 1 hour"); surface a
    # friendly version to the user so the frontend can render it as-is.
    retry_after = getattr(err, "retry_after", None)
    msg = "Too many requests — please slow down and try again in a few minutes."
    return jsonify({"error": msg, "retry_after": retry_after}), 429


def conn():
    # CLIENT_FOUND_ROWS makes cur.rowcount on UPDATE report MATCHED rows
    # rather than CHANGED rows. Without this, a PUT /api/plans/:id whose
    # body equals the current row returns 0 changed → we'd 404 even though
    # the plan exists (and the frontend would wipe its id, forcing Save As).
    return mysql.connector.connect(
        **DB,
        client_flags=[mysql.connector.ClientFlag.FOUND_ROWS],
    )


def _backfill_plan_aircraft(cur):
    # One-time: tag pre-column plans with their aircraft. The frontend writes
    # the plan's id/name into the owning aircraft's NAV-plan state inside the
    # bundle, so whichever state matches identifies the aircraft.
    keymap = {"velis_navplan_state": "velis",
              "velis_da20_navplan_state": "da20",
              "velis_std_navplan_state": "std"}
    cur.execute("SELECT id, name, plan_json FROM flight_plans WHERE aircraft IS NULL")
    for pid, name, blob in cur.fetchall():
        ac = "velis"
        try:
            ls = (json.loads(blob) or {}).get("localStorage") or {}
            for key, acid in keymap.items():
                raw = ls.get(key)
                if not raw:
                    continue
                meta = (json.loads(raw) or {}).get("meta") or {}
                if meta.get("id") == pid or (meta.get("name") and meta.get("name") == name):
                    ac = acid
                    break
        except Exception:
            pass
        cur.execute("UPDATE flight_plans SET aircraft = %s WHERE id = %s", (ac, pid))


def bootstrap():
    # Runs once per gunicorn worker at import time. Up to 60s of retries
    # covers the cold-start case where MariaDB hasn't finished its own
    # init yet. schema.sql uses CREATE TABLE IF NOT EXISTS, so multiple
    # workers running this concurrently is harmless.
    #
    # Note: splitting on ";" works for the current schema (plain CREATE
    # TABLE statements). If a stored procedure or trigger is ever added
    # — they contain embedded semicolons — switch this loop to
    # `cur.execute(sql, multi=True)` and consume the iterator.
    sql = pathlib.Path(__file__).with_name("schema.sql").read_text()
    last_err = None
    for _ in range(30):
        try:
            c = conn()
            cur = c.cursor()
            for stmt in sql.split(";"):
                # Drop comment lines first: a semicolon inside a comment would
                # otherwise split mid-comment, and a comment-only fragment
                # executes as an empty statement — both are 1064 errors.
                stmt = "\n".join(l for l in stmt.splitlines()
                                 if not l.strip().startswith("--"))
                if stmt.strip():
                    cur.execute(stmt)
            # Seed the waypoint-frequency directory on first boot only (table
            # empty). Admin edits via /api/freqs are never overwritten.
            cur.execute("SELECT COUNT(*) FROM freq_directory")
            if cur.fetchone()[0] == 0:
                cur.executemany(
                    "INSERT IGNORE INTO freq_directory (name, freq) VALUES (%s, %s)",
                    [("LSPG", "128.475"), ("Buochs", "119.625"),
                     ("Emmen", "118.005"), ("Zürich Info", "124.700"),
                     ("Meiringen TWR", "130.155"), ("Meiringen Info", "135.480")],
                )
            _backfill_plan_aircraft(cur)
            cur.close()
            c.close()
            return
        except mysql.connector.Error as e:
            last_err = e
            time.sleep(2)
    raise RuntimeError(f"DB bootstrap failed: {last_err}")


bootstrap()


# ── helpers ────────────────────────────────────────────────────────────
def esc(s):
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;"))


def request_origin():
    """Scheme + host the pilot is actually using (respects reverse proxy)."""
    proto = request.headers.get("X-Forwarded-Proto") or ("https" if request.is_secure else "http")
    host  = request.headers.get("X-Forwarded-Host") or request.host
    return f"{proto}://{host}"


def build_verify_url(token):
    base = request_origin() + PATH_PREFIX
    if not base.startswith("http"):
        base = PUBLIC_URL  # fallback
    return f"{base}/api/auth/verify/{token}"


def build_site_url():
    origin = request_origin()
    if origin.startswith("http"):
        return origin + PATH_PREFIX + "/"
    return SITE_URL


def valid_email(raw):
    e = (raw or "").strip().lower()
    if "@" not in e or "." not in e.split("@")[-1] or len(e) > 255:
        return False, ""
    return True, e


def valid_name(raw):
    n = (raw or "").strip()
    if not (1 <= len(n) <= 100):
        return False, ""
    return True, n


def send_magic_email(to_email, first_name, url, purpose):
    """purpose: 'verify' (first time) or 'login' (returning)."""
    if purpose == "verify":
        subject  = "Velis Electro — verify your email"
        greeting = f"Welcome aboard, {first_name}."
        lede     = "One last step — tap the button below to verify your email and unlock your flight planner account."
        cta      = "Verify & take off"
        ttl      = f"{VERIFY_HOURS} hours"
    else:
        subject  = "Velis Electro — your sign-in link"
        greeting = f"Cleared to board, {first_name}."
        lede     = "Tap the button below to sign in to your flight planner."
        cta      = "Sign in"
        ttl      = f"{LOGIN_LINK_HOURS} hour"

    html = f"""<!DOCTYPE html><html><body style="margin:0;padding:32px 20px;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f2ec;">
<div style="max-width:520px;margin:0 auto;background:#13131a;border:1px solid #232327;border-radius:14px;padding:32px 28px;">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#ffb020;font-weight:700;margin-bottom:18px;">Velis Electro · Flight Planner</div>
  <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;margin:0 0 14px;font-weight:600;color:#f5f2ec;">{esc(greeting)}</h1>
  <p style="margin:0 0 24px;color:#c8c3b7;font-size:15px;line-height:1.55;">{esc(lede)}</p>
  <p style="margin:0 0 24px;"><a href="{esc(url)}" style="display:inline-block;background:#ffb020;color:#0a0a0b;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:14px;letter-spacing:0.02em;">{esc(cta)}</a></p>
  <p style="margin:0 0 8px;color:#898579;font-size:12px;">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;color:#c8c3b7;word-break:break-all;">{esc(url)}</p>
  <p style="margin:0;color:#898579;font-size:11px;">Link expires in {ttl}. If you didn't request this, ignore the email.</p>
</div>
</body></html>"""

    msg = MIMEMultipart("alternative")
    msg["From"]    = FROM_EMAIL
    msg["To"]      = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(html, "html"))

    s = smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=15)
    s.starttls()
    s.login(SMTP_USERNAME, SMTP_PASSWORD)
    s.sendmail(FROM_EMAIL, to_email, msg.as_string())
    s.quit()
    log.info("sent %s link to %s", purpose, to_email)


def send_admin_new_user_email(user_email, first_name, last_name):
    """Best-effort ops ping — never blocks registration if it fails."""
    if not ADMIN_EMAIL or not SMTP_USERNAME:
        return
    subject = f"Velis Planner — new signup: {first_name} {last_name}"
    html = (
        f"<!DOCTYPE html><html><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0a0a0b;max-width:520px;margin:0 auto;padding:20px;\">"
        f"<h2 style=\"margin:0 0 14px;font-weight:700;\">New Velis Planner signup</h2>"
        f"<table style=\"font-size:14px;border-collapse:collapse;\">"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;\">Name</td><td><strong>{esc(first_name)} {esc(last_name)}</strong></td></tr>"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;\">Email</td><td><a href=\"mailto:{esc(user_email)}\" style=\"color:#185FA5;\">{esc(user_email)}</a></td></tr>"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;\">When</td><td>{datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}</td></tr>"
        f"</table>"
        f"<p style=\"color:#898579;font-size:12px;margin-top:28px;\">User has not yet verified their email — verification link was sent to their inbox.</p>"
        f"</body></html>"
    )
    msg = MIMEMultipart("alternative")
    msg["From"]    = FROM_EMAIL
    msg["To"]      = ADMIN_EMAIL
    msg["Subject"] = subject
    msg.attach(MIMEText(html, "html"))
    s = smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=15)
    s.starttls()
    s.login(SMTP_USERNAME, SMTP_PASSWORD)
    s.sendmail(FROM_EMAIL, ADMIN_EMAIL, msg.as_string())
    s.quit()
    log.info("admin new-user notification sent to %s for %s", ADMIN_EMAIL, user_email)


def make_magic_token(user_id, purpose, hours):
    token = secrets.token_urlsafe(32)
    exp = datetime.utcnow() + timedelta(hours=hours)
    c = conn(); cur = c.cursor()
    cur.execute(
        "INSERT INTO magic_tokens (user_id, token, purpose, expires_at) VALUES (%s,%s,%s,%s)",
        (user_id, token, purpose, exp),
    )
    cur.close(); c.close()
    return token


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    exp   = datetime.utcnow() + timedelta(days=SESSION_DAYS)
    ua    = (request.headers.get("User-Agent") or "")[:255]
    ip    = (request.headers.get("X-Forwarded-For") or request.remote_addr or "")[:64]
    c = conn(); cur = c.cursor()
    cur.execute(
        "INSERT INTO sessions (user_id, token, expires_at, user_agent, ip_address) "
        "VALUES (%s,%s,%s,%s,%s)",
        (user_id, token, exp, ua, ip),
    )
    cur.close(); c.close()
    return token


def current_user():
    tok = request.cookies.get(SESSION_COOKIE_NAME)
    if not tok:
        hdr = request.headers.get("Authorization", "")
        if hdr.startswith("Bearer "):
            tok = hdr[7:]
    if not tok:
        return None
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT u.id, u.email, u.first_name, u.last_name "
        "FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = %s AND s.expires_at > UTC_TIMESTAMP()",
        (tok,),
    )
    row = cur.fetchone()
    if row:
        # Throttled — every authed request would otherwise write to sessions.
        # iPad pilots dragging sliders trigger plan_sync polls + plan saves
        # multiple times a second; one write per minute is plenty for analytics.
        cur.execute(
            "UPDATE sessions SET last_seen_at = NOW() WHERE token = %s "
            "AND (last_seen_at IS NULL OR last_seen_at < UTC_TIMESTAMP() - INTERVAL 60 SECOND)",
            (tok,),
        )
    cur.close(); c.close()
    return row or None


def require_user(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        u = current_user()
        if not u:
            abort(401)
        request.user = u
        return fn(*a, **kw)
    return wrap


def is_admin_email(email):
    return bool(ADMIN_EMAIL) and (email or "").strip().lower() == ADMIN_EMAIL.strip().lower()


def require_admin(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        u = current_user()
        if not u:
            abort(401)
        if not is_admin_email(u["email"]):
            abort(403)
        request.user = u
        return fn(*a, **kw)
    return wrap


def set_session_cookie(resp, token):
    resp.set_cookie(
        SESSION_COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400,
        httponly=True, secure=SESSION_COOKIE_SECURE, samesite="Lax", path="/",
    )


# ── auth routes ────────────────────────────────────────────────────────
@app.post("/api/auth/register")
@limiter.limit(os.getenv("RATELIMIT_REGISTER", "5/hour"))
def auth_register():
    data = request.get_json(force=True, silent=True) or {}
    ok_e, email = valid_email(data.get("email"))
    ok_f, first = valid_name(data.get("first_name"))
    ok_l, last  = valid_name(data.get("last_name"))
    if not (ok_e and ok_f and ok_l):
        return jsonify({"error": "Email, first name and last name are required."}), 400

    is_new_user = False
    user_id = None
    c = conn(); cur = c.cursor(dictionary=True)
    try:
        cur.execute("SELECT id, first_name FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
        if row:
            user_id = row["id"]
            first   = row["first_name"] or first
        else:
            try:
                cur.execute(
                    "INSERT INTO users (email, first_name, last_name) VALUES (%s, %s, %s)",
                    (email, first, last),
                )
                user_id = cur.lastrowid
                is_new_user = True
            except mysql.connector.IntegrityError:
                # Concurrent register won the race — fall back to lookup.
                cur.execute("SELECT id, first_name FROM users WHERE email = %s", (email,))
                row2 = cur.fetchone()
                if row2:
                    user_id = row2["id"]
                    first   = row2["first_name"] or first
    except mysql.connector.Error:
        log.exception("auth_register DB error")
        user_id = None
    finally:
        cur.close(); c.close()
    if user_id is None:
        return jsonify({"error": "Could not register — please try again."}), 502

    tok = make_magic_token(user_id, "verify", VERIFY_HOURS)
    url = build_verify_url(tok)
    try:
        send_magic_email(email, first, url, "verify")
    except Exception as e:
        log.exception("send failed")
        return jsonify({"error": "Could not send confirmation email — please try again."}), 502
    if is_new_user:
        try:
            send_admin_new_user_email(email, first, last)
        except Exception:
            log.exception("admin notification failed")  # non-fatal
    return jsonify({"status": "check_inbox", "email": email}), 201


@app.post("/api/auth/login")
@limiter.limit(os.getenv("RATELIMIT_LOGIN", "10/hour"))
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    ok_e, email = valid_email(data.get("email"))
    if not ok_e:
        return jsonify({"error": "Invalid email."}), 400

    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute("SELECT id, first_name FROM users WHERE email = %s", (email,))
    row = cur.fetchone()
    cur.close(); c.close()
    if not row:
        # Don't leak whether the email exists — same response shape.
        return jsonify({"status": "check_inbox", "email": email}), 200

    tok = make_magic_token(row["id"], "login", LOGIN_LINK_HOURS)
    url = build_verify_url(tok)
    try:
        send_magic_email(email, row["first_name"] or "", url, "login")
    except Exception as e:
        log.exception("send failed")
        return jsonify({"error": "Could not send sign-in email — please try again."}), 502
    return jsonify({"status": "check_inbox", "email": email}), 200


@app.route("/api/auth/verify/<token>", methods=["GET", "POST"])
def auth_verify(token):
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT mt.id AS tid, mt.user_id, mt.purpose, mt.expires_at, mt.used_at, "
        "       u.email, u.first_name, u.last_name, u.email_verified_at "
        "FROM magic_tokens mt JOIN users u ON u.id = mt.user_id "
        "WHERE mt.token = %s",
        (token,),
    )
    row = cur.fetchone()
    if not row:
        cur.close(); c.close()
        return landing_html(error="invalid"), 400
    if row["used_at"] is not None:
        cur.close(); c.close()
        return landing_html(error="used"), 400
    if row["expires_at"] < datetime.utcnow():
        cur.close(); c.close()
        return landing_html(error="expired"), 400

    # Only POST consumes the token. GET, HEAD, and anything else just render
    # the interstitial. Email scanners commonly fire HEAD (or GET, or both)
    # to check links — treating only POST as consumption keeps the token safe
    # until the pilot actually clicks the "Confirm check-in" button.
    if request.method != "POST":
        cur.close(); c.close()
        body = landing_html(
            first_name=row["first_name"], last_name=row["last_name"],
            email=row["email"], purpose=row["purpose"], state="confirm",
            confirm_token=token,
        )
        resp = make_response(body)
        resp.headers["Content-Type"] = "text/html; charset=utf-8"
        return resp

    # Atomic consume — racing POSTs (e.g. user double-tapping) compete here.
    cur.execute("UPDATE magic_tokens SET used_at = NOW() WHERE id = %s AND used_at IS NULL", (row["tid"],))
    if cur.rowcount == 0:
        cur.close(); c.close()
        return landing_html(error="used"), 400
    if row["email_verified_at"] is None:
        cur.execute(
            "UPDATE users SET email_verified_at = NOW(), last_login_at = NOW() WHERE id = %s",
            (row["user_id"],),
        )
    else:
        cur.execute("UPDATE users SET last_login_at = NOW() WHERE id = %s", (row["user_id"],))
    cur.close(); c.close()

    session_token = create_session(row["user_id"])
    body = landing_html(
        first_name=row["first_name"], last_name=row["last_name"],
        email=row["email"], purpose=row["purpose"],
    )
    resp = make_response(body)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    set_session_cookie(resp, session_token)
    return resp


@app.get("/api/auth/me")
def auth_me():
    u = current_user()
    if not u:
        return jsonify({"authenticated": False}), 200
    return jsonify({"authenticated": True, "user": {
        "id": u["id"], "email": u["email"],
        "first_name": u["first_name"], "last_name": u["last_name"],
        "is_admin": is_admin_email(u["email"]),
    }}), 200


@app.put("/api/auth/me")
@require_user
def auth_me_update():
    data = request.get_json(force=True, silent=True) or {}
    ok_f, first = valid_name(data.get("first_name"))
    ok_l, last  = valid_name(data.get("last_name"))
    if not (ok_f and ok_l):
        return jsonify({"error": "First name and last name are required."}), 400
    c = conn(); cur = c.cursor()
    cur.execute("UPDATE users SET first_name = %s, last_name = %s WHERE id = %s",
                (first, last, request.user["id"]))
    cur.close(); c.close()
    return jsonify({"ok": True, "user": {
        "id": request.user["id"], "email": request.user["email"],
        "first_name": first, "last_name": last,
        "is_admin": is_admin_email(request.user["email"]),
    }}), 200


@app.post("/api/auth/logout")
def auth_logout():
    tok = request.cookies.get(SESSION_COOKIE_NAME)
    if not tok:
        hdr = request.headers.get("Authorization", "")
        if hdr.startswith("Bearer "):
            tok = hdr[7:]
    if tok:
        c = conn(); cur = c.cursor()
        cur.execute("DELETE FROM sessions WHERE token = %s", (tok,))
        cur.close(); c.close()
    resp = make_response(jsonify({"ok": True}))
    resp.set_cookie(SESSION_COOKIE_NAME, "", max_age=0,
                    httponly=True, secure=SESSION_COOKIE_SECURE, samesite="Lax", path="/")
    return resp


# ── contact form ───────────────────────────────────────────────────────
@app.post("/api/contact")
@limiter.limit(os.getenv("RATELIMIT_CONTACT", "3/hour"))
def contact():
    data = request.get_json(force=True, silent=True) or {}
    ok_e, email = valid_email(data.get("email"))
    ok_n, name  = valid_name(data.get("name"))
    comment = (data.get("comment") or "").strip()
    if not (ok_e and ok_n):
        return jsonify({"error": "Name and a valid email are required."}), 400
    if not (1 <= len(comment) <= 5000):
        return jsonify({"error": "Comment must be 1–5000 characters."}), 400
    if not ADMIN_EMAIL or not SMTP_USERNAME:
        log.error("contact form: SMTP not configured")
        return jsonify({"error": "Contact form is temporarily unavailable."}), 503

    ua = (request.headers.get("User-Agent") or "")[:255]
    ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "")[:64]
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    body_html = (
        f"<!DOCTYPE html><html><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0a0a0b;max-width:560px;margin:0 auto;padding:20px;\">"
        f"<h2 style=\"margin:0 0 14px;font-weight:700;\">Velis Planner — contact form</h2>"
        f"<table style=\"font-size:14px;border-collapse:collapse;\">"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;vertical-align:top;\">From</td><td><strong>{esc(name)}</strong> &lt;<a href=\"mailto:{esc(email)}\" style=\"color:#185FA5;\">{esc(email)}</a>&gt;</td></tr>"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;vertical-align:top;\">When</td><td>{when}</td></tr>"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;vertical-align:top;\">IP</td><td>{esc(ip)}</td></tr>"
        f"<tr><td style=\"color:#6b6660;padding:4px 18px 4px 0;vertical-align:top;\">UA</td><td style=\"color:#898579;font-size:12px;\">{esc(ua)}</td></tr>"
        f"</table>"
        f"<hr style=\"border:none;border-top:1px solid #e2ddd6;margin:18px 0;\">"
        f"<pre style=\"white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.55;margin:0;\">{esc(comment)}</pre>"
        f"</body></html>"
    )
    msg = MIMEMultipart("alternative")
    msg["From"]     = FROM_EMAIL
    msg["To"]       = ADMIN_EMAIL
    msg["Reply-To"] = email
    msg["Subject"]  = f"Velis Planner — message from {name}"
    msg.attach(MIMEText(body_html, "html"))
    try:
        s = smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=15)
        s.starttls()
        s.login(SMTP_USERNAME, SMTP_PASSWORD)
        s.sendmail(FROM_EMAIL, ADMIN_EMAIL, msg.as_string())
        s.quit()
    except Exception:
        log.exception("contact form send failed")
        return jsonify({"error": "Could not send — please try again later."}), 502
    log.info("contact form message from %s (%s)", email, name)
    return jsonify({"ok": True}), 200


# ── plan routes ────────────────────────────────────────────────────────
@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.get("/api/plans")
@require_user
def list_plans():
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, COALESCE(aircraft,'velis') AS aircraft, updated_at "
        "FROM flight_plans WHERE user_id = %s ORDER BY updated_at DESC",
        (request.user["id"],),
    )
    rows = cur.fetchall()
    for r in rows:
        r["updated_at"] = r["updated_at"].isoformat()
    cur.close(); c.close()
    return jsonify(rows)


@app.get("/api/plans/<int:pid>")
@require_user
def get_plan(pid):
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, COALESCE(aircraft,'velis') AS aircraft, updated_at, plan_json "
        "FROM flight_plans WHERE id = %s AND user_id = %s",
        (pid, request.user["id"]),
    )
    row = cur.fetchone()
    cur.close(); c.close()
    if not row:
        abort(404)
    row["updated_at"] = row["updated_at"].isoformat()
    row["plan_json"]  = json.loads(row["plan_json"])
    return jsonify(row)


@app.post("/api/plans")
@require_user
def create_plan():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, "name required")
    plan_json = json.dumps(body.get("plan_json") or {})
    aircraft = (str(body.get("aircraft") or "velis").strip() or "velis")[:20]
    c = conn(); cur = c.cursor()
    try:
        cur.execute(
            "INSERT INTO flight_plans (user_id, name, aircraft, plan_json) VALUES (%s, %s, %s, %s)",
            (request.user["id"], name, aircraft, plan_json),
        )
        pid = cur.lastrowid
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            abort(409, "name exists")
        raise
    finally:
        cur.close(); c.close()
    return jsonify({"id": pid, "name": name}), 201


@app.put("/api/plans/<int:pid>")
@require_user
def update_plan(pid):
    body = request.get_json(force=True) or {}
    plan_json = json.dumps(body.get("plan_json") or {})
    name = (body.get("name") or "").strip() or None
    aircraft = str(body.get("aircraft") or "").strip()[:20] or None
    c = conn(); cur = c.cursor()
    try:
        if name:
            cur.execute(
                "UPDATE flight_plans SET name = %s, aircraft = COALESCE(%s, aircraft), plan_json = %s "
                "WHERE id = %s AND user_id = %s",
                (name, aircraft, plan_json, pid, request.user["id"]),
            )
        else:
            cur.execute(
                "UPDATE flight_plans SET aircraft = COALESCE(%s, aircraft), plan_json = %s "
                "WHERE id = %s AND user_id = %s",
                (aircraft, plan_json, pid, request.user["id"]),
            )
        ok = cur.rowcount > 0
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            abort(409, "name exists")
        raise
    finally:
        cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


@app.delete("/api/plans/<int:pid>")
@require_user
def delete_plan(pid):
    c = conn(); cur = c.cursor()
    cur.execute(
        "DELETE FROM flight_plans WHERE id = %s AND user_id = %s",
        (pid, request.user["id"]),
    )
    ok = cur.rowcount > 0
    cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


# ── waypoint / frequency directory ─────────────────────────────────────
# One global list feeding the Freq/Waypoint dropdown on the NAV Plan pages.
# Reads are public (the calculator works without an account); writes are
# admin-only via the Admin Dashboard.
def valid_freq_entry(data):
    name = (data.get("name") or "").strip()
    freq = (data.get("freq") or "").strip()
    if not (1 <= len(name) <= 80) or not (1 <= len(freq) <= 20):
        return None, None
    return name, freq


@app.get("/api/freqs")
def list_freqs():
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute("SELECT id, name, freq FROM freq_directory ORDER BY name")
    rows = cur.fetchall()
    cur.close(); c.close()
    return jsonify(rows)


@app.post("/api/freqs")
@require_admin
def create_freq():
    name, freq = valid_freq_entry(request.get_json(force=True, silent=True) or {})
    if not name:
        return jsonify({"error": "Name (max 80) and frequency (max 20) are required."}), 400
    c = conn(); cur = c.cursor()
    try:
        cur.execute("INSERT INTO freq_directory (name, freq) VALUES (%s, %s)", (name, freq))
        fid = cur.lastrowid
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            return jsonify({"error": "An entry with that name already exists."}), 409
        raise
    finally:
        cur.close(); c.close()
    return jsonify({"id": fid, "name": name, "freq": freq}), 201


@app.put("/api/freqs/<int:fid>")
@require_admin
def update_freq(fid):
    name, freq = valid_freq_entry(request.get_json(force=True, silent=True) or {})
    if not name:
        return jsonify({"error": "Name (max 80) and frequency (max 20) are required."}), 400
    c = conn(); cur = c.cursor()
    try:
        cur.execute("UPDATE freq_directory SET name = %s, freq = %s WHERE id = %s",
                    (name, freq, fid))
        ok = cur.rowcount > 0
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            return jsonify({"error": "An entry with that name already exists."}), 409
        raise
    finally:
        cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


@app.delete("/api/freqs/<int:fid>")
@require_admin
def delete_freq(fid):
    c = conn(); cur = c.cursor()
    cur.execute("DELETE FROM freq_directory WHERE id = %s", (fid,))
    ok = cur.rowcount > 0
    cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


# ── admin routes ───────────────────────────────────────────────────────
@app.get("/api/admin/users")
@require_admin
def admin_list_users():
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT u.id, u.email, u.first_name, u.last_name, "
        "       u.created_at, u.email_verified_at, u.last_login_at, "
        "       (SELECT COUNT(*) FROM flight_plans p WHERE p.user_id = u.id) AS plan_count, "
        "       (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at "
        "FROM users u ORDER BY u.created_at DESC"
    )
    rows = cur.fetchall()
    cur.close(); c.close()
    for r in rows:
        for k in ("created_at", "email_verified_at", "last_login_at", "last_seen_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
    return jsonify(rows)


@app.delete("/api/admin/plans/<int:pid>")
@require_admin
def admin_delete_plan(pid):
    c = conn(); cur = c.cursor()
    cur.execute("DELETE FROM flight_plans WHERE id = %s", (pid,))
    ok = cur.rowcount > 0
    cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


@app.get("/api/admin/plans")
@require_admin
def admin_list_plans():
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT p.id, p.name, COALESCE(p.aircraft,'velis') AS aircraft, p.updated_at, p.user_id, "
        "       u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name "
        "FROM flight_plans p JOIN users u ON u.id = p.user_id "
        "ORDER BY p.updated_at DESC"
    )
    rows = cur.fetchall()
    cur.close(); c.close()
    for r in rows:
        r["updated_at"] = r["updated_at"].isoformat()
    return jsonify(rows)


# ── Sky Demon screenshot → JSON via Claude vision ──────────────────────
SKYDEMON_PROMPT = (
    "Extract the navigation plan from this Sky Demon screenshot. The plan is the "
    "table at the top with columns MSA / Level / Trk / Wind / Hdg / GS / Dist / Time. "
    "Return a JSON array of objects in route order — one entry per visible row, "
    "INCLUDING the departure and destination airport rows. Each object has these "
    "string fields (use empty string for blank or unreadable cells; keep the "
    "original thousands separator character — apostrophe ' or right-single-quote ’):\n"
    "  name  — airport label like 'LSPG Kägiswil' or coordinate text 'N470121 E0082237'\n"
    "  elev  — only on airport rows, e.g. \"1'526 ft (55 hPa)\"; '' on coordinate rows\n"
    "  msa   — MSA cell\n"
    "  level — Level cell\n"
    "  trk   — Trk degrees\n"
    "  wind  — Wind 'DDD/SS'\n"
    "  hdg   — Hdg degrees\n"
    "  gs    — Ground Speed (kt)\n"
    "  dist  — Distance (nm)\n"
    "  eet   — Time (minutes)\n"
    "Skip the SR/MCT/SS/ECT lines, the column-header row, and any frequencies / "
    "comms tables that appear below the plan. Output STRICT JSON only — no prose, "
    "no markdown code fences."
)


def _detect_image_mime(blob, declared):
    declared = (declared or "").lower()
    if declared in ("image/png", "image/jpeg", "image/webp", "image/gif"):
        return declared
    if declared == "image/jpg":
        return "image/jpeg"
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if blob[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    if blob[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def _strip_code_fence(text):
    t = text.strip()
    if not t.startswith("```"):
        return t
    t = t[3:]
    if t.lower().startswith("json"):
        t = t[4:]
    if t.endswith("```"):
        t = t[:-3]
    return t.strip()


@app.post("/api/import/skydemon-image")
@limiter.limit(os.getenv("RATELIMIT_IMPORT", "20/hour;200/day"))
@require_user
def import_skydemon_image():
    if not ANTHROPIC_API_KEY:
        return jsonify({"error": "Image import is not configured on the server."}), 503

    f = request.files.get("image")
    if f is None:
        return jsonify({"error": "No image attached."}), 400
    blob = f.read(MAX_IMAGE_BYTES + 1)
    if len(blob) > MAX_IMAGE_BYTES:
        return jsonify({"error": f"Image too large (max {MAX_IMAGE_BYTES // (1024*1024)} MB)."}), 413
    if not blob:
        return jsonify({"error": "Empty image."}), 400

    mime = _detect_image_mime(blob, f.mimetype)
    if not mime:
        return jsonify({"error": "Unsupported image format. Use PNG, JPEG, WebP, or GIF."}), 400

    client = _get_anthropic_client()
    if client is None:
        return jsonify({"error": "Image import is not configured on the server."}), 503

    b64 = base64.standard_b64encode(blob).decode("ascii")
    try:
        msg = client.messages.create(
            model=IMPORT_MODEL,
            max_tokens=4096,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": mime, "data": b64,
                    }},
                    {"type": "text", "text": SKYDEMON_PROMPT},
                ],
            }],
        )
    except Exception as e:
        # Don't log.exception — anthropic-py error bodies can include the
        # filename or text content of the request. type(e).__name__ is enough
        # to distinguish timeout / rate-limit / 5xx in metrics without leakage.
        log.error("anthropic call failed: %s", type(e).__name__)
        return jsonify({"error": "Image parsing failed — please try again."}), 502

    text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
    text = _strip_code_fence(text)
    try:
        rows = json.loads(text)
    except Exception:
        log.warning("anthropic returned non-JSON: %s", text[:300])
        return jsonify({"error": "Could not parse the screenshot — try a clearer image."}), 502
    if not isinstance(rows, list) or len(rows) < 2:
        return jsonify({"error": "Could not find at least 2 waypoints in the screenshot."}), 422

    # Coerce every field to a string so the frontend can treat the response
    # exactly like Sky Demon paste output.
    keys = ("name", "elev", "msa", "level", "trk", "wind", "hdg", "gs", "dist", "eet")
    cleaned = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        cleaned.append({k: (str(r.get(k) or "")).strip() for k in keys})
    return jsonify({"rows": cleaned})


# ── landing page ───────────────────────────────────────────────────────
def landing_html(first_name="", last_name="", email="", purpose="verify",
                 error=None, state=None, confirm_token=None):
    template = pathlib.Path(__file__).with_name("landing.html").read_text()
    now = datetime.utcnow().strftime("%Y-%m-%d · %H:%M UTC")
    site = build_site_url() or "/"

    if error:
        titles = {
            "invalid": ("Clearance denied", "That link isn't recognised. It may have been typed wrong or already been superseded by a newer one."),
            "used":    ("Already on board", "This link has been used. If you need another, request a fresh sign-in link from the flight planner."),
            "expired": ("Clearance expired", "This link has timed out. Request a new one from the flight planner and we'll send a fresh link to your inbox."),
        }
        title, body = titles.get(error, titles["invalid"])
        state_cls, callsign, status = "error", "DENIED", "REJECTED"
        stamp_color = "#e0342c"
        greeting    = title
        subtitle    = body
        captain     = ""
        email_line  = ""
        cta_html    = f'<a href="{esc(site)}" class="cta">Back to flight planner <span class="arrow">→</span></a>'
    elif state == "confirm":
        # Interstitial: GET only. The button below POSTs to consume the token.
        state_cls, callsign, status = "ok", "PENDING", "CONFIRM"
        stamp_color = "#ffb020"
        if purpose == "verify":
            greeting = "One tap to take off."
            subtitle = "Confirm your check-in to activate your account and sign in on this device."
            cta_label = "Confirm & take off"
        else:
            greeting = "Ready when you are."
            subtitle = "Confirm to sign in to your flight planner on this device."
            cta_label = "Confirm & sign in"
        captain    = f"{first_name} {last_name}".strip()
        email_line = email
        # Empty action → POSTs back to the current URL, which already includes
        # the correct /flight-planner prefix (Nginx reverse proxy).
        cta_html   = (f'<form class="cta-form" method="POST" action="">'
                      f'<button type="submit" class="cta">{esc(cta_label)} <span class="arrow">→</span></button>'
                      f'</form>')
    else:
        state_cls, callsign, status = "ok", "CLEARED", "ACTIVE"
        stamp_color = "#7ed97a"
        if purpose == "verify":
            greeting = "Cleared for takeoff."
            subtitle = "Your Velis Electro flight planner account is verified and this device is signed in. Happy flying."
        else:
            greeting = "Welcome back, Captain."
            subtitle = "You're signed in on this device. Your saved plans are a click away."
        captain    = f"{first_name} {last_name}".strip()
        email_line = email
        cta_html   = f'<a href="{esc(site)}" class="cta">Continue to flight planner <span class="arrow">→</span></a>'

    replacements = {
        "{{STATE}}":       state_cls,
        "{{GREETING}}":    esc(greeting),
        "{{SUBTITLE}}":    esc(subtitle),
        "{{CAPTAIN}}":     esc(captain),
        "{{EMAIL}}":       esc(email_line),
        "{{CALLSIGN}}":    callsign,
        "{{STATUS}}":      status,
        "{{STAMP_COLOR}}": stamp_color,
        "{{TIMESTAMP}}":   now,
        "{{CTA_HTML}}":    cta_html,
    }
    out = template
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8003, debug=True)
