# ORYN integration plan

Working notes for the experiment that makes ORYN-PLATFORM the ORYN product with
God's Eye View as its geospatial engine. Branch: `experiment/oryn-unified-platform`
(local only; nothing pushed, merged or deployed).

## Repositories (audited 2026-10-17)

| | ORYN-WEBSITE (reference, read-only) | ORYN-PLATFORM (destination) |
| --- | --- | --- |
| Location | `C:\Users\ashur\Projects\ORYN-WEBSITE`, `main` @ `e3abf61`, clean | this repo, from `main` @ `1df2a272` |
| Stack | Next.js 16 App Router, React 19, Tailwind 4, TypeScript | vanilla JS, Vite 6, Cesium 1.124 |
| Auth | Better Auth (username plugin), Postgres sessions, cookie `oryn.session_token` | none |
| Data | PostgreSQL 17 + PostGIS, row-level security (`oryn_app` cannot bypass RLS), 8 migrations | public-data proxies in Vite middleware (`server/providers`) |
| Design | `src/app/globals.css` tokens (ink / bone / signal / data palette, Geist), platform kit `src/components/platform/ui.tsx`, shell `src/components/platform/shell.tsx` | engine chrome with its own tokens (`src/ui/styles/foundation.css`) |
| Analytics today | `/app/[org]/map` (MapLibre AOI workspace) and `/app/[org]/intel` ("Intelligence globe", its own small Cesium scene) | the God's Eye View engine: 32 layers, live feeds, CCTV, scenes, display effects |

## Architecture

The website and the engine use incompatible frameworks, and their security
models differ: the platform CSP is nonce-based with no `unsafe-eval`, while
Cesium's widget stack needs `unsafe-eval`. Re-implementing ~365 React/Next
files in vanilla JS would be an approximation, which the brief rules out.
So the ORYN application is used as written, and the engine is integrated
behind a typed boundary:

```
browser ── ORYN web app (web/, Next.js) ─────────────────────────────┐
           marketing · sign-in · platform shell · /api/v1 (unchanged) │
           /app/[org]/intel → EngineWorkspace (ORYN UI)               │
               └─ same-origin frame: /engine/index.html?host=oryn     │
                    └─ window.__gevHost  (typed bridge)               │
           rewrites /engine/* and engine /api/* ──► engine service ◄──┘
                                                    (this repo, vite preview,
                                                     127.0.0.1:5180, base /engine/)
```

- **Website parity:** the website's own pages, copy, components, assets,
  auth, API, migrations and tests, imported into `web/` with production
  deployment files left out. Parity on every non-analytics page is by
  construction, then checked by screenshot.
- **Analytics:** the "Intelligence globe" destination keeps its route, label,
  server-side access check, area queries and `?at=` view, and renders
  `EngineWorkspace`: the website's intel layout (310px panel, modes, grouped
  layers with ORYN badges, 380px inspector, "2D map workspace") around the
  God's Eye View engine. Layer rows, status, counts, retrieval times and row
  controls come from the engine's own lifecycle through the bridge. ORYN
  areas and findings come from `/api/v1/orgs/[org]` and are drawn on the
  engine's globe; selecting one opens the website's own `AoiCard` /
  `DetectionCard`.
- **Engine host mode (`?host=oryn`, this repo):** `src/ui/host/hostMode.js`
  marks the document and loads Geist; `src/ui/styles/oryn-host.css` re-points
  the engine's tokens at ORYN's values and hides engine branding, the first-run
  launcher, locale and provider-settings chips; `src/ui/host/hostBridge.js`
  exposes `window.__gevHost` (layers, row controls, camera, search, events,
  selection, ORYN overlays). The standalone engine is unchanged without the
  parameter.
- **Security:** `web/src/proxy.ts` admits `/engine/*` and the engine API
  routes only with a valid ORYN session (Better Auth session plus account
  controls, cached 30 s per cookie); unauthenticated or forged cookies get
  401. Forwarded engine routes are an allowlist (`web/src/lib/intel/engine.ts`);
  `/api/setup` (writes the engine `.env`), `/api/openai` and `/api/realtime`
  (paid voice) are never forwarded. Engine documents keep their own CSP and
  are framable only by their own origin (`GEV_EMBED_FRAME_ANCESTORS='self'`);
  platform documents add `frame-src 'self'` and nothing else.
- **Database:** a local PostgreSQL 17.10 + PostGIS 3.6.2 cluster (portable
  binaries in `..\devtools\`, outside both repos) on `127.0.0.1:54329`,
  with the website's role layout (`oryn_owner` owner, `oryn_app` without
  BYPASSRLS) and its own migrations and synthetic seed (`Sample Farms`).
  No production database or credential is used.

## Engine changes in this repo

| File | Change |
| --- | --- |
| `build/vite.js` | `GEV_BASE_PATH` support (validated), Cesium static-copy fix for sub-paths, watcher ignores `dist-engine/` and `web/` |
| `build/embed-framing.js` | `?host=oryn` documents framable by configured ancestors, also under a base path |
| `server/standalone/vite.config.js` | passes `GEV_BASE_PATH` |
| `src/main.js`, `src/standalone/application.js`, `src/standalone/tools.js`, `src/app/controls.js` | host mode wiring; in host mode the startup Austin flight and the engine's provider-settings panel are skipped (the host sets the view; keys live on the engine server) |
| `src/firstRunExperience.js` | no launcher in host mode |
| `src/logoGaze.js`, `src/voice/control.js` | icon paths resolve against the base path |
| `src/ui/host/*`, `src/ui/styles/oryn-host.css`, `style.css` | host mode, bridge, ORYN theme |
| `scripts/oryn-engine.mjs`, `package.json` (`oryn:engine`) | build under `/engine/` and serve on loopback |

## Import (2026-10-17)

- Source: ORYN-WEBSITE `main` @ `e3abf61`, committed files only, exported
  with `core.autocrlf=false` (this repo checks text out as LF).
- Rollback point: local tag `pre-web-import-2026-10-17` (commit `954f7c33`).
- Imported: 518 files into `web/` (application source, public assets,
  migrations, scripts, tests, docs, `.env.example`, local `docker-compose.yml`).
- Excluded: `deploy/` (Railway and rehearsal, including `rehearsal.env`),
  `Dockerfile`, `Dockerfile.web`, `Dockerfile.worker`, `.dockerignore`,
  `db/production/`, `docs/deployments/`, `docs/DEPLOYMENT.md`, and
  `tests/unit/deployment-config.test.ts` (it only checks those excluded
  deployment files; it still lives and passes in ORYN-WEBSITE).
- Secrets scan of the import: no keys, tokens or private keys; the only
  credentials are test fixtures (`u:p@h`, `db.internal`) and the documented
  `*_dev_only` local passwords in `docker-compose.yml`.
- Changes on top of the import (9 files under `web/`):
  new `src/lib/intel/engine.ts`, `src/server/intel/engine-gate.ts`,
  `src/components/intel/engine-workspace.tsx`, `src/components/intel/engine-loader.tsx`;
  modified `src/proxy.ts`, `next.config.ts`, `src/app/(platform)/app/[org]/intel/page.tsx`,
  `tests/e2e/intel-globe.spec.ts` (first test rewritten for the engine, membership
  test kept, engine-gate test added), `tests/e2e/global-setup.ts` (runs tsx through
  Node so the suite starts on Windows).
- The website's original globe components (`intel-workspace.tsx`,
  `globe-scene.ts`, cards, time bar) remain in `web/`; the cards are reused,
  the rest is unused by the intel page now.

## Verification (run from ORYN-PLATFORM)

| Check | Result |
| --- | --- |
| `web`: `npm test` (unit) | 326 passed, 9 skipped (339 before minus the 13 excluded deployment-layout tests) |
| `web`: `npm run test:integration` (tenant isolation against `oryn_test`) | 100 passed, 4 skipped |
| `web`: `npx playwright test` (all e2e, real server, real database) | 24 passed |
| `web`: `npm run typecheck`, `npm run lint`, `npm run build` | pass |
| engine: `npm test` | 7,695 passed, 0 failed, 10 skipped (allocation benchmarks need Node 24) |
| engine: `format:check`, `check:boundaries`, `i18n`, `layer-token:check` | pass |
| Browser check of the intel page (sign-in, bridge, layers, modes, ORYN area card, route change, phone width, sign-out) | 15/15 |
| API checks (401 signed out, member reads, other org 404, viewer cannot write, engine gate, sign-out revokes) | 15/15 |
| Row-level security: `oryn_app` without tenant context | sees 0 of 4 areas; no BYPASSRLS |
| Visual comparison with the original at 1440×900 and 390×844 | 12 public pages and 18 platform pages pixel-identical; home and Aerial analysis differ only in background video frames; Intelligence globe differs by design |

Live feeds observed through the ORYN app at import: USGS earthquakes, NIFC
wildfire perimeters, NOAA NHC cyclones, NOAA nowCOAST radar, ECCC air quality,
CelesTrak satellites, Launch Library launches, OpenSky / adsb.lol aircraft
(labelled Fallback when served by adsb.lol), adsb.lol military aircraft and
GNSS integrity, public CCTV poses. Unavailable without keys: AIS vessels
(`AISSTREAM_API_KEY`), NASA FIRMS (`FIRMS_MAP_KEY`).

Since the licence review (`ORYN_LICENCE_REVIEW.md`, branch
`feat/oryn-pilot-hardening`), the ORYN build offers only layers whose terms
permit commercial display. Aircraft come from adsb.lol only, CCTV from four
openly licensed operators, and the basemap is NASA GIBS plus USGS NAIP. NIFC
perimeters, CelesTrak satellites and other engine layers (17 in all) are
withheld; the engine refuses to enable them, and the Intelligence globe panel
lists the ones that have toggles with their reasons.

### Re-run on `feat/oryn-pilot-hardening` (2026-10-17)

| Check | Result |
| --- | --- |
| `web`: `npm test` (unit) | 350 passed, 9 skipped |
| `web`: `npm run test:integration` (tenant isolation against `oryn_test`) | 124 passed, 4 skipped |
| `web`: `npx playwright test` (own `oryn_e2e` database, own server) | 26 passed (after correcting two intel-globe assertions left stale by the licence work) |
| `web`: `npm run typecheck`, `npm run lint` | pass |
| engine: `npm test` | 7,707 passed, 0 failed, 10 skipped |
| engine: `format:check`, `check:boundaries`, `i18n`, `layer-token:check --base-ref pre-pilot-hardening-2026-10-17` | pass |
| engine: `scripts/check-commercial-dist.mjs` on the served build | pass |
| Season comparison on real Earth Search Sentinel-2 L2A (East tract, Sept 2025 vs Sept 2026, tile 18STE) | 18 candidate changes; PDF and pages inspected |

## Running it locally

```
# 1. database (once per boot; portable PostgreSQL outside the repo)
..\devtools\pgsql\bin\pg_ctl.exe -D ..\devtools\pgdata -l ..\devtools\postgres.log start
# 2. engine service (builds under /engine/ the first time; --build to rebuild)
npm run oryn:engine
# 3. ORYN web app, in a second terminal
cd web
npm ci            # first time only
npm run dev       # http://localhost:3000
```

`web/.env.local` (not committed) holds `DATABASE_URL`, `DATABASE_OWNER_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `ORYN_ENGINE_URL` for the local
cluster; see `web/.env.example`. The local database was migrated with the
website's own migrations and seeded with its synthetic `Sample Farms`
organization (`npm run db:seed -- --sample-farm`); `npm run test:e2e` adds
its synthetic `e2e-*` organizations.

## Known gaps and risks

- The engine runs in a same-origin frame. It shares the origin and is driven
  by ORYN panels through the bridge, but it is a separate document: keyboard
  focus moves into it when the globe is clicked.
- Engine voice control is not forwarded (paid OpenAI endpoints); its button
  stays visible in the engine's dock and reports itself unavailable.
- The website's production integration gate (`ORYN_VERIFIED_INTEGRATIONS`)
  covers ORYN's own providers; the engine's feeds are gated by the session
  check only.
- The 2D Map workspace remains the website's MapLibre AOI tool, because it
  carries ORYN workflows (drawing and editing areas, imagery timeline, change
  review) the engine does not implement. It links to the globe and back.
- Engine layers that need keys (AIS, NASA FIRMS) show as Unavailable until
  keys are set on the engine server. TomTom traffic and Google 3D are paid and
  withheld in the ORYN build; the ORYN engine script clears their keys.
- Turning on Space Missions (rocket launches) activates the engine's own
  focus mode, which isolates the globe to launches and satellites and switches
  other layers off; the ORYN panel reflects it but does not yet explain it.
- In host mode the engine does not probe for a Google 3D token; it renders the
  public-imagery basemap on an ellipsoid (no terrain service).
- Scheduled cluster syncs are stored with `org_id = null`, so the Data sources
  page shows a tenant only its own backfills (audit 1.7 #6, not fixed).
