# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pipistrel Velis Electro flight planner — four static HTML pages + two shared JS modules, backed by a small Flask service for cross-device plan storage. No build system, no npm, no frameworks. Plain HTML/JS/CSS, POH data in a single JSON file.

## Development

```bash
npx live-server --open=index.html
```

All pages `fetch('velis_electro_poh.json')`, so they must be served over HTTP (not `file://`). The calculator works stand-alone; the backend only handles user accounts + Save/Load. To run the backend locally see `backend/README.md`; to point the frontend at a local backend set `window.VELIS_API_BASE = 'http://localhost:8003/api'` in the devtools console. Because the auth session is a same-origin cookie, dev normally means serving frontend + backend through one proxy (or skipping sign-in locally).

## Deployment

Static site — VPS runs Nginx serving `/var/www/flight-planner/`:

```bash
git push
ssh root@95.217.222.205 "cd /var/www/flight-planner && git pull"
```

Backend — Docker Compose service `flightplanner` on the same VPS (`/opt/docker/docker-compose.yml`), listens on `127.0.0.1:8003`, reverse-proxied by Nginx at `/flight-planner/api/`. Rebuild after changing `backend/`: `ssh root@95.217.222.205 "cd /opt/docker/flightplanner-src && git pull && cd /opt/docker && docker compose build flightplanner && docker compose up -d flightplanner"`.

## Architecture

### Pages (frontend)

| File | Purpose |
| ---- | ------- |
| `index.html` | **Route Planner**. Sliders for SOH / SOC / reserve / OAT / cruise kW / dep-alt, dynamic leg cards, destination, approach. Computes per-leg energy, writes derived values (`velis_total_kwh`, `velis_usable_kwh`, `velis_soc0_pct`…) to localStorage for other pages. |
| `velis_takeoff.html` | **Takeoff & Landing**. Sliders for alt / OAT / wind / slope / surface / condition. Renders POH tables + SVG profiles. Computation lives in `takeoff_calc.js`. |
| `velis_navplan.html` | **NAV Plan** (paper-style flight plan). Header, waypoint table, Endurance calculator (Fuel + Electric modes), Sky Demon text-import, Totals row with REMARKS, Block-time annotations, embedded TO/LDG mini-pictures (via `takeoff_calc.js`). Print target: A4 landscape. |
| `velis_performance.html` | **Performance** — reference tables (ROC, cruise power, %SOC per phase, computed summary). Read-only for cruise power; the slider lives on the Route Planner. |

### Shared JS modules

- **`plan_sync.js`** — loaded by every page. Injects a floating disc (FAB) top-right of the viewport, a slim plan-status line in the nav bar, the auth modal (passwordless magic-link sign-in / account creation) and a load-plan modal. Owns `api()` (cookie-credentialed fetch wrapper), session refresh via `/api/auth/me`, `doSave` / `doSaveAs` / `doLoad` / `doLogout`, dirty tracking, Cmd/Ctrl+S shortcut. Exposes `window.velisPlan = { save, saveAs, load, openAuth, logout, markDirty, markSaved, bundleDirty, updateStatus, user }`.
- **`skydemon_fp.js`** — loaded by the three NAV Plan pages (`velis_`, `da20_`, `std_navplan.html`). Pure helpers for SkyDemon's `.flightplan` XML (root `<DivelementsFlightPlanner>`, `PrimaryRoute Start=… Level=…` + `RhumbLineRoute To=… Level=…` legs, `WaypointNameHints`, DDMMSS.ss coordinates) and GPX: `parseFlightplan`, `toParsedRows` (→ the `{name,elev,coord,data}` row shape `wpFromSkyDemon()` consumes; DIST/HDG are computed from the coordinates, true track, no wind), `buildFlightplan`, `mergeRoute` (in-place update that keeps pilot-typed cells). Exposed at `window.velisFp`. No published schema exists — the reader is lenient, the writer emits only the known-good subset (no aircraft block).
- **`takeoff_calc.js`** — POH loader + `computeTakeoff` / `computeLanding` + `drawTakeoff` / `drawLanding` SVG renderers + `readState()` (reads `velis_takeoff`). Exposed at `window.takeoffCalc`. Used by the NAV Plan for its mini-pictures; the Takeoff page still has its own inline functions (intentional — lets it keep showing the step-by-step detailed calculation).

### Backend (`backend/`)

Flask + Gunicorn, MySQL connector to the shared MariaDB container. Five tables: `users` (id, email, first_name, last_name, email_verified_at, last_login_at), `magic_tokens` (one-shot email-verification / sign-in links, 24 h for verify, 1 h for login), `sessions` (90-day cookie tokens), `flight_plans` (`id, user_id, name, aircraft, updated_at, archived_at, plan_json`; UNIQUE `(user_id, name)`; `archived_at` set = read-only — content updates and renames return 423 until de-archived via `PUT /api/plans/:id/archive` `{archived: bool}`, admin variant `PUT /api/admin/plans/:id/archive`), `freq_directory` (global waypoint-name → frequency list feeding the NAV Plan Freq/Waypoint dropdown; seeded on first boot when empty, administered in the `velis_admin.html` "Waypoint frequencies" card; `GET /api/freqs` is public, `POST/PUT/DELETE /api/freqs[/:id]` are admin-only). Auth is passwordless: register with first/last/email → email contains a magic link → `/api/auth/verify/<token>` sets an HttpOnly session cookie and returns a branded boarding-pass landing page. Endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/verify/<token>`, `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/ping`, `GET /api/plans`, `GET /api/plans/:id`, `POST /api/plans`, `PUT /api/plans/:id`, `PUT /api/plans/:id/archive`, `DELETE /api/plans/:id`, `GET /api/aip/airports` (signed-in openAIP airport proxy, family key or `X-OpenAIP-Key`). Plan endpoints require the session cookie and scope rows to the owning user. Duplicate `(user_id, name)` → 409. Full detail (env vars, SMTP, public URL) in `backend/README.md`.

### Save / Load bundle

The backend just stores JSON blobs. `plan_sync.js` builds and applies them:

```
{
  version: 2,
  navplan:      <NAV Plan state minus meta>,
  localStorage: { <every velis_* key except auth / view / dirty-timestamps> }
}
```

`velis_navplan_state` is *included* in `bundle.localStorage`. NAV Plan flushes its in-memory state via the `velis:before-save` event before the bundle is collected; on load, every `velis_*` key is written back, then `velis:after-load` fires and each page re-reads its own slice.

### Cross-page state

- **Shared localStorage keys** (all prefixed `velis_`): `velis_route_state`, `velis_takeoff`, `velis_navplan_state`, `velis_vy`, `velis_vx`, `velis_vglide`, `velis_glide_ratio`, `velis_cruise_kw`, `velis_soh`, `velis_oat`, `velis_total_kwh`, `velis_usable_kwh`, `velis_total_min`, `velis_total_dist`, `velis_soc0_pct`, `velis_reserve_pct`.
- **Excluded from the save bundle**: `velis_user` (cached `{id,email,first_name,last_name}` from `/api/auth/me`), `velis_navplan_view` (NAV Plan on-screen view toggle), `velis_bundle_mtime` / `velis_bundle_stime` (dirty-tracking timestamps), `velis_freq_directory` (cached global frequency directory from `/api/freqs` — config, not plan data). The session itself lives in an HttpOnly cookie, not localStorage. On logout — or when `/me` reports a different user than the cache — every `velis_*` key is wiped.
- **Dirty indicator**: any page mutating state calls `window.velisPlan.markDirty()`, which bumps `velis_bundle_mtime`. A successful Save / Load bumps `velis_bundle_stime`. The disc and nav-bar status show a dot when `mtime > stime`.
- **Events dispatched on `document`**: `velis:before-save` (pages flush in-memory state to localStorage) and `velis:after-load` (pages re-read localStorage and re-render). NAV Plan is the only page that needs `before-save`; all four pages listen for `after-load` so loading from any page refreshes them in place.

### Calculation engine (`index.html` Route Planner)

`update()` runs on every slider change. Computes per leg: climb (1,000 ft bands, ROC interpolated at altitude × ISA deviation, `%SOC = ref × 600 / actualROC`) → cruise (`time × socPer10min / 10`) → descent (power-off glide, `nm = ΔAlt × glideRatio / 6076.12`, 0 %SOC). Takeoff / approach %SOC added once. ISA deviation is computed at departure altitude and held constant across the profile.

Interpolation helpers: `lerp`, `bracket`, `interpROC` (bilinear), `interpSOH`, `interpCruiseKts`, `socCruise10min` (2D power × SOH). All read from the POH JSON loaded once on init.

### Units

Distances in **nm**, speeds in **kts**, altitudes in **ft**, energy in **%SOC**.

## Conventions worth knowing

- **Page bottom padding**: every page has `body { padding:0 0 48px; }` to leave room for the FAB — don't remove it.
- **Print styles on NAV Plan**: A4 landscape, 1 cm top / left margins only, both halves (`.nav-half` + `.fuel-half`) forced visible. Backgrounds are preserved via `-webkit-print-color-adjust:exact` on `.wp th`, the Endurance header rows, and the Totals row grey.
- **No backwards-compat code** in the save-bundle path — every saved plan is v2 shape.
- **SkyDemon import** on the NAV Plan pages has three modes: `.flightplan` / `.gpx` file (default tab; file picker, drop zone, and a page-wide drag & drop), pasted nav-log text (`parseSkyDemon` detects data rows by the wind token `XXX/XX` and aligns columns around it) and screenshot (backend OCR). All three feed `wpFromSkyDemon()`.
- **File import enrichment** (two steps): a real SkyDemon export carries only coordinates, point types (`Aerodrome`/`Town`/`UserWaypoint`/`Unknown`) and the route level — no names, winds or times. Step 1 (`applyFpImport()`) puts the route on screen and closes the modal; step 2 is a `confirm()` and then `fpEnrich()` (same block on the three pages, progress in a floating pill): aerodromes via the backend proxy `GET /api/aip/airports?lat&lon&dist` (openAIP → ICAO, name, elevation, magnetic declination; openAIP refuses browser CORS reads, hence the proxy), falling back to the OSM aerodrome polygon (Nominatim zoom 18) and terrain height (Open-Meteo elevation API) for DEP/DEST ALT; `Town` points via Nominatim reverse geocoding at municipality level (paced 1 req/s); user waypoints via Photon (komoot) nearest named feature — pass, peak, hamlet, village, locality… within 0.6 nm, else the row keeps its coordinates; names are kept unique along the route. Winds via Open-Meteo pressure-level forecast at each leg midpoint for the header DATE + START hour (interpolated by geopotential height; next hour when the date is missing or outside the 16-day window), HDG °M / EET from the wind triangle at the Cruise TAS typed in the import modal (`velis_import_tas_<aircraft>` remembers it). Variation: openAIP's value, else `velis_mag_var`, else 3°E (`state.source.declAssumed`). A re-import of the same route keeps previously resolved names (`mergeRoute`). Lookup failures are listed in one alert after the run.
- **SkyDemon file identity**: a file import stores `state.source = {kind, key, name, level, importedAt}` in the NAV state (`key` = lower-cased file base name, so it survives route edits in SkyDemon). `applyFpImport()` uses it: same key as the plan on screen → `mergeRoute` in place, plan id kept; a saved plan with that key (the backend's `GET /api/plans` exposes `source_key` via `JSON_EXTRACT(plan_json,'$.navplan.source.key')`) → offer to open and update it; otherwise replace the route and detach from the loaded plan (`velisPlan.detachPlan()`), so Save becomes Save-as with the SkyDemon route name suggested.
- **Share to SkyDemon** (`btn-fp`) exports a `.flightplan` through the native share sheet (download fallback); SkyDemon registers the extension, so tapping the file on the iPad opens the route with its levels. The last leg's level is the max of the last enroute ALT and the destination ALT (the destination row usually holds the airfield elevation). GPX export stays as a secondary button.
- **The Route Planner route is dynamic N-leg** (not fixed 3). Legs are stored in a top-level `legs` array and rendered via `renderLegs()`.

## Editing the POH data

`velis_electro_poh.json` is the single source of truth for: battery capacity, ROC table (altitude × ISA deviation), cruise power settings, and the `soc_phases` list (takeoff / 1000 ft climb / 10-min cruise @ 20/25/30/35 kW / straight-in / traffic-pattern). Any edits propagate the moment you reload a page. Takeoff / landing distance tables are under `poh.takeoff` / `poh.landing` in the same file.
