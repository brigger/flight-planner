# flightplanner backend

Flask service that stores NAV plans per user. User accounts are
passwordless: register with first/last/email → click the magic link
in your inbox → a 90-day HttpOnly session cookie is set and you land
on a branded boarding-pass page.

Deployed as the `flightplanner` container in
`/opt/docker/docker-compose.yml` on the VPS. Listens on
`127.0.0.1:8003`, reverse-proxied by Nginx at `/navigation-planner/api/`.

## Tables

| Table | Purpose |
| ----- | ------- |
| `users` | `id`, `email` (unique), `first_name`, `last_name`, `email_verified_at`, `last_login_at`, `created_at` |
| `magic_tokens` | one-shot tokens for email verification (24 h) and sign-in (1 h) |
| `sessions` | opaque 64-char session tokens (90-day TTL), one row per browser |
| `flight_plans` | `id`, `user_id` (FK), `name`, `updated_at`, `plan_json`; UNIQUE `(user_id, name)` |

Schema is auto-created on startup from `schema.sql`.

## Environment

| Var | Required | Notes |
| --- | -------- | ----- |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | yes | MariaDB connection |
| `SMTP_SERVER` | no | default `smtp.gmail.com` |
| `SMTP_PORT` | no | default `587` |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | yes | Gmail app password works fine |
| `FROM_EMAIL` | no | default = `SMTP_USERNAME` |
| `PUBLIC_URL` | yes | absolute origin + path prefix that the magic link should resolve to — e.g. `https://example.com/navigation-planner`. Email links are built as `{PUBLIC_URL}/api/auth/verify/<token>` |
| `SITE_URL` | no | where the landing page's CTA sends the pilot; defaults to `PUBLIC_URL` |
| `SESSION_COOKIE_SECURE` | prod | set `1` behind TLS, `0` for `http://localhost` dev |
| `SESSION_COOKIE_NAME` | no | default `velis_session` |
| `SESSION_DAYS` | no | default `90` |

The old `FLIGHTPLANNER_API_KEY` is **no longer used**.

## Endpoints

### Auth

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| POST   | `/api/auth/register` | `{email, first_name, last_name}` | `{status:"check_inbox", email}` (201). Same shape if the email already exists — we quietly re-send a fresh verification link. |
| POST   | `/api/auth/login`    | `{email}`                        | `{status:"check_inbox", email}` (200). Same shape whether the email is registered or not (no enumeration). |
| GET    | `/api/auth/verify/<token>` | — | HTML — boarding-pass landing page; sets `velis_session` cookie on success; 400 with error variant on invalid/expired/used. |
| GET    | `/api/auth/me`       | — | `{authenticated:false}` or `{authenticated:true, user:{id,email,first_name,last_name}}` |
| POST   | `/api/auth/logout`   | — | `{ok:true}`; clears the cookie and deletes the session row. |

### Plans (all require a valid session cookie → 401 otherwise)

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET    | `/api/ping`          | —                              | `{ok:true}` |
| GET    | `/api/plans`         | —                              | `[{id,name,updated_at}, …]` |
| GET    | `/api/plans/:id`     | —                              | `{id,name,updated_at,plan_json}` |
| POST   | `/api/plans`         | `{name, plan_json}`            | `{id,name}` (201) · 409 on dup |
| PUT    | `/api/plans/:id`     | `{plan_json[, name]}`          | `{ok:true}` |
| DELETE | `/api/plans/:id`     | —                              | `{ok:true}` |

UNIQUE key is now `(user_id, name)`; renaming into an existing name ⇒ 409.

## Local dev

Requires Python 3.12+, a reachable MariaDB, and valid SMTP credentials
(verification emails are always real). SSH-tunnel to the VPS Maria if
you don't have a local one: `ssh -L 3306:127.0.0.1:3306 root@95.217.222.205`.

```bash
cd backend
pip install -r requirements.txt

export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_NAME=flightplanner_db
export DB_USER=flightplanner
export DB_PASSWORD=...
export SMTP_USERNAME=you@gmail.com
export SMTP_PASSWORD='app-password'
export FROM_EMAIL=you@gmail.com
export PUBLIC_URL=http://localhost:8003
export SITE_URL=http://localhost:5500
export SESSION_COOKIE_SECURE=0

python app.py    # dev server on :8003
```

Because the session is a same-origin cookie, the simplest dev setup is
to serve the frontend through a proxy so `/api` and the static files
share an origin — otherwise the browser won't send the cookie and
`/me` keeps returning `false`.

## First-time migration on the VPS

The new schema replaces the old `flight_plans(owner, name, …)` table.
The app uses `CREATE TABLE IF NOT EXISTS` at startup, so an existing
old table blocks the new FK. Wipe it once by hand before the new
container starts:

```bash
ssh root@95.217.222.205 \
  'docker compose -f /opt/docker/docker-compose.yml exec mariadb \
     mysql -u root -p"$MARIADB_ROOT_PASSWORD" flightplanner_db \
     -e "DROP TABLE IF EXISTS flight_plans;"'
```

Old plans are lost — intentional (no backwards compat).

## Redeploy after a code change

```bash
ssh root@95.217.222.205 \
  "cd /opt/docker/flightplanner-src && git pull && \
   cd /opt/docker && docker compose build flightplanner && \
   docker compose up -d flightplanner"
```

Secrets live in `/opt/docker/.env` (DB creds, SMTP creds, `PUBLIC_URL`,
`SITE_URL`, `SESSION_COOKIE_SECURE=1`).
