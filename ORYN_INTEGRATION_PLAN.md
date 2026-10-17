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
| `src/main.js`, `src/standalone/application.js`, `src/app/controls.js` | host mode wiring; the startup Austin flight is skipped when the host sets the view |
| `src/firstRunExperience.js` | no launcher in host mode |
| `src/logoGaze.js`, `src/voice/control.js` | icon paths resolve against the base path |
| `src/ui/host/*`, `src/ui/styles/oryn-host.css`, `style.css` | host mode, bridge, ORYN theme |
| `scripts/oryn-engine.mjs`, `package.json` (`oryn:engine`) | build under `/engine/` and serve on loopback |

## Status

| Item | Status |
| --- | --- |
| Engine host mode, bridge, base path, framing | done; unit tests and browser checks pass |
| Web integration (EngineWorkspace, proxy gate, rewrites, intel page) | written and verified end to end in a scratch clone of the website: real sign-in, 15/15 browser checks, website unit tests, typecheck, lint |
| Import of the website application into `web/` | **blocked**: the Claude Code auto-mode safety check refused copying the website's source into this repository. Needs your approval (see below). |
| Visual comparison of every page from `web/` | pending the import |

### The blocked step

Importing the website is one command (committed files only, deployment
infrastructure excluded):

```
git -C C:\Users\ashur\Projects\ORYN-WEBSITE archive --format=tar HEAD -- . ^
  ":(exclude)deploy" ":(exclude)Dockerfile" ":(exclude)Dockerfile.web" ^
  ":(exclude)Dockerfile.worker" ":(exclude)docs/deployments" ^
  ":(exclude)docs/DEPLOYMENT.md" ":(exclude).dockerignore" | tar -x -C web
```

followed by applying `..\devtools\oryn-web-integration\oryn-web-integration.patch`
(the verified web-side changes) inside `web/`.

## Running it (after the import)

```
# 1. database (once per boot)
..\devtools\pgsql\bin\pg_ctl.exe -D ..\devtools\pgdata -l ..\devtools\postgres.log start
# 2. engine service
npm run oryn:engine
# 3. ORYN web app
cd web && npm ci && npm run dev        # http://localhost:3000
```

`web/.env.local` needs `DATABASE_URL`, `DATABASE_OWNER_URL`,
`BETTER_AUTH_SECRET` (32+ random characters) and `BETTER_AUTH_URL`; the local
values follow `web/.env.example`. `ORYN_ENGINE_URL` overrides the engine
address (default `http://127.0.0.1:5180`).

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
- Engine layers that need keys (AIS, NASA FIRMS, TomTom, Google 3D) show as
  Unavailable until keys are set on the engine server.
