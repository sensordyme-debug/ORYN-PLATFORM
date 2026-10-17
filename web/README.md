# ORYN — Intelligent Physical Systems

ORYN is the company; **SensorDyme** is its perception and reasoning layer, shipped as two products: **SensorDyme Edge** (on-device intelligent sensing, `/edge`) and **SensorDyme Aero** (the aerial development platform, `/aero`). Aerial analysis (`/intelligence`), ORYN Command, and ORYN Portal complete the system.

This repository contains two things that deploy together:

1. **The public website** — marketing pages for ORYN, SensorDyme Edge and Aero, Intelligence, Command, and Portal (`/`, `/technology`, `/edge`, `/aero`, `/solutions`, …).
2. **The ORYN platform** — a multi-tenant geospatial intelligence application (`/app`, `/api/v1`) with a background worker. Organizations monitor areas of interest with satellite imagery, weather, official warnings, and news; ORYN computes vegetation and water indicators, finds candidate changes, evaluates alert rules, and produces evidence-linked reports.

Built with Next.js 16 (App Router), TypeScript, Tailwind CSS v4, Motion, Three.js (product explorers, loaded on demand), PostgreSQL + PostGIS, Better Auth, MapLibre GL, and a PostgreSQL-backed job queue.

> **Status.** The platform is a working foundation, not a certified system. It has not undergone a security audit, penetration test, or any compliance authorization (FedRAMP, StateRAMP, CJIS, SOC 2, …). See [`docs/SECURITY.md`](docs/SECURITY.md) for what is implemented and what remains.

---

## Quick start (website only)

Requirements: Node.js 20.9+ (22 LTS recommended).

```bash
npm install
npm run dev          # http://localhost:3000
```

The website runs without any platform configuration; `/login` explains that the platform is not configured.

## Quick start (platform)

Additional requirements: Docker (for local PostgreSQL + PostGIS).

```bash
npm install
cp .env.example .env.local                 # then set BETTER_AUTH_SECRET (openssl rand -base64 48)
npm run db:up                              # PostgreSQL 17 + PostGIS 3.5 on 127.0.0.1:54329
npm run db:migrate                         # apply db/migrations as the schema owner

# Create the first platform administrator (prints a one-time password unless ORYN_ADMIN_PASSWORD is set)
npm run oryn:admin -- create --email you@example.com --name "Your Name"

npm run dev                                # web app: http://localhost:3000/login
npm run worker                             # in a second terminal: jobs + scheduler
```

Then sign in, open **Platform administration** (`/app/admin`), create an organization, and give it people — see **Partner accounts** below. There is no public sign-up.

### Partner accounts and the trial account

Accounts are issued by administrators; users sign in with a **username** and password (accounts created from an email invitation may also use their address). An administrator-issued password must be changed by its owner before any real organization opens. Full reference: [`docs/OPERATIONS.md` → Accounts](docs/OPERATIONS.md#accounts).

```bash
# Trial workspace (synthetic data only) + the shared trial account "OrynTest", confined to it.
# The password is read from ORYN_PROVISION_PASSWORD (or prompted for without echo) — never
# put it in a file that is committed. Re-running changes nothing on an existing account.
ORYN_PROVISION_PASSWORD='<trial password>' npm run oryn:accounts -- provision-trial --username OrynTest --demo-areas

# A partner account: least-privilege role in one organization; a temporary password is
# generated and printed once (or set ORYN_PROVISION_PASSWORD); it must be changed at first sign-in.
npm run oryn:accounts -- create --username jdoe --name "Jane Doe" --org tarboro-nc --role viewer --generate-password

npm run oryn:accounts -- reset-password --user jdoe --generate-password   # revokes sessions, change required
npm run oryn:accounts -- disable --user jdoe --reason "Contract ended"      # revokes sessions and its API keys
npm run oryn:accounts -- list
```

Platform administrators can do the same at `/app/admin/accounts`.

### Development workspaces (optional)

```bash
ORYN_ALLOW_SYNTHETIC_SEED=true ORYN_DEV_SEED_PASSWORD='choose-a-password' npm run db:seed
npm run worker                             # processes the imagery backfill the seed queued
```

This creates two development workspaces (it refuses to run with `NODE_ENV=production`):

- **Town of Tarboro, North Carolina** (`/app/tarboro-nc`) — the boundary is the real U.S. Census TIGERweb boundary (GEOID 3766700), imported with provenance. Users and alert rules are development fixtures.
- **Sample Farms (synthetic)** (`/app/sample-farms`) — a clearly labelled synthetic agricultural organization. Its field boundaries are placeholders placed on land that ESA WorldCover 2021 classifies as cropland near Tarboro; they are not anyone's real fields.

Seeded users (`tarboro-admin@`, `farm-admin@`, `analyst@`, `viewer@`, `auditor@`, `field@oryn.local`) share `ORYN_DEV_SEED_PASSWORD`. The first worker run searches 180 days of real Sentinel-2, Sentinel-1, Landsat, and land-cover catalogs and analyzes every matching image — expect 10–20 minutes and a few hundred jobs.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server (copies the MapLibre worker into `public/vendor` first) |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate Next.js route types, then `tsc --noEmit` |
| `npm test` | Unit tests (no database, no network) |
| `npm run test:integration` | Integration tests against the `oryn_test` database (migrated automatically) |
| `npm run test:all` | Unit + integration |
| `npm run test:e2e` | Playwright end-to-end tests against a running app and database |
| `npm run db:up` | Start local PostgreSQL + PostGIS (Docker) |
| `npm run db:migrate` | Apply pending migrations (as `DATABASE_OWNER_URL`; `npm run db:migrate:status` changes nothing, `-- --check` exits 3 when migrations are pending) |
| `npm run db:seed` | Development workspaces (see above) |
| `npm run oryn:admin -- create\|grant\|revoke\|list` | Manage platform administrators |
| `npm run oryn:accounts -- provision-trial\|create\|reset-password\|disable\|enable\|revoke-sessions\|set-role\|remove-member\|trial-only\|set-username\|list` | Partner and trial accounts (see `docs/OPERATIONS.md`) |
| `npm run worker` | Job worker + scheduler (`--once` drains and exits; `--no-scheduler`) |
| `npm run oryn:verify -- config\|database\|storage\|providers\|gdelt\|nasa-hls\|email\|ai-summaries` | Live verification of a deployment's configuration and integrations |
| `npm run build:scripts` | Bundle the worker and CLIs into `dist/` (production image) |

Network smoke tests against the real providers are opt-in: `ORYN_NETWORK_TESTS=1 npm test`.

## Configuration

All variables are documented in [`.env.example`](.env.example). The platform needs at minimum `DATABASE_URL`, `DATABASE_OWNER_URL`, and `BETTER_AUTH_SECRET`. Providers that need credentials (NASA Earthdata, Copernicus Data Space downloads, commercial Open-Meteo, email) are reported as **unconfigured** on the Data sources page and contribute nothing until configured — they are never simulated.

### Database roles

The application connects as a role **without** superuser or BYPASSRLS so PostgreSQL row-level security enforces tenant isolation on every query:

```sql
-- as the schema owner, after `npm run db:migrate` has created oryn_app_role
CREATE ROLE oryn_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS IN ROLE oryn_app_role;
```

`docker-compose.yml` does this automatically for local development (`db/init/01-roles.sh`).

## Platform at a glance

| Area | Where |
| --- | --- |
| Map workspace: search, draw/edit AOIs, layers, imagery timeline, swipe comparison, inspection panels | `/app/[org]/map` |
| Areas of interest: list, create (draw / GeoJSON upload / Census boundary import), configure, history | `/app/[org]/areas` |
| Change review / inspection queue | `/app/[org]/detections` |
| Alerts, alert rules, in-app notifications | `/app/[org]/alerts` |
| Reports (PDF) and exports (GeoJSON, CSV, GeoTIFF) | `/app/[org]/reports` |
| Processing (jobs, retries, analysis runs) | `/app/[org]/processing` |
| Data sources (availability, health, licensing) | `/app/[org]/sources` |
| Members, invitations, API keys, retention | `/app/[org]/settings` |
| Your account (change password) | `/app/account` |
| Partner accounts (platform administrators) | `/app/admin/accounts` |
| Audit trail | `/app/[org]/audit` |
| REST API (session cookie or `Authorization: Bearer oryn_…` API key) | `/api/v1/orgs/[org]/…` |

Documentation:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data model, workflows, analytics
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, controls, remaining risks
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — data providers, credentials, licensing
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deployment, worker, backups, troubleshooting

## Deploying

**Read [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) first** — services, images, the production environment checklist, database roles, the migration and rollback plan, health checks, and which integrations must be verified before they are enabled. In short:

- **Images:** one Dockerfile per service — `Dockerfile.web` (Next.js standalone server) and `Dockerfile.worker` (bundled worker plus the migration job and operator CLIs). Both run as an unprivileged user and declare health checks. The root `Dockerfile` deliberately fails with a pointer to them. Railway settings are in [`docs/DEPLOYMENT.md → Railway`](docs/DEPLOYMENT.md#railway).
- **Database:** PostgreSQL 15+ with PostGIS; roles from `db/production/roles.sql` (the services connect as `oryn_app`, which cannot bypass row-level security). Run the migration job before each release.
- **Worker:** a long-running service (`node dist/worker.mjs`), not serverless.
- **Object storage:** a private S3-compatible bucket (`ORYN_STORAGE_DRIVER=s3`); production refuses local storage unless chosen deliberately.
- **Startup preflight:** production refuses to start with synthetic seeding enabled, development or weak secrets, a database role that bypasses RLS, local storage, or pending migrations.

Backups, monitoring, and troubleshooting are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Contact form behavior

The website form (`/contact`, `/contact?intent=demo`) posts to `src/app/api/contact/route.ts`. With `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, and `CONTACT_FROM_EMAIL` set (and, in production, email verified — see docs/DEPLOYMENT.md), submissions are emailed via Resend; in development without them they are logged; in production without them the API returns `503 not_configured` and the visitor is told the message was not sent. Spam protection: honeypot, minimum time-to-submit, server-side validation, length limits, and a per-instance rate limit.

## Project structure

```
db/
  migrations/             Forward-only SQL migrations (schema, RLS policies, functions)
  init/                   Local Docker init (least-privilege app role, test database)
src/
  app/
    (marketing)/          Public website routes, with the site header/footer layout:
                          page.tsx (home), technology/ edge/ aero/ intelligence/ platform/
                          solutions/ solutions/[slug]/ about/ contact/ credits/, template.tsx
    (auth)/               Sign-in (username or email), invitations, password reset
    (platform)/app/       Platform UI (org-scoped pages under [org]; /app/account, /app/admin)
    api/auth/             Better Auth endpoints (allowlisted)
    api/v1/orgs/[org]/    REST API (session or API key)
    api/health/           Liveness and readiness checks
    api/cron/tick/        Scheduler + bounded job drain for serverless hosts
    api/contact/          Website contact form
    layout.tsx            Root layout: fonts, metadata, JSON-LD
    sitemap.ts robots.ts manifest.ts icon.svg apple-icon.png favicon.ico opengraph-image.png
    globals.css           Design system: Tailwind v4 theme tokens and type scale
  components/
    map/                  MapLibre workspace, inspectors, charts, legends (platform)
    platform/             Platform UI kit, forms, shell
    auth/                 Sign-in, invitation, and password forms
    brand/                ORYN logo (vector, from master artwork)
    layout/               Header, mobile menu, footer, page hero
    home/                 Home-page sections
    previews/             Interactive ORYN Command and ORYN Portal previews
    viz/                  Comparison slider, demos, blueprints, mosaic, report
    edge/                 SensorDyme Edge pipeline story & device explorer
    aero/                 Aero 3D explorer (Three.js, loaded on demand), blueprint
    explorer/             Shared product explorer (stage + UI) for Edge and Aero
    tech/ contact/ media/ ui/
  content/                Website copy and data. Edit these files to change the site.
  assets/                 Statically imported images (blur placeholders, hashing)
  lib/                    Isomorphic helpers (geo, authz matrix, formatting, map layers)
  server/
    auth/ authz/          Better Auth configuration, sessions, org access resolution
    accounts/             Administrator-provisioned accounts (partner, trial)
    config/               Environment and production preflight checks
    db/                   PostgreSQL client (tenant/user/system contexts), migration runner
    aois/ orgs/ results/  Domain services (areas, administration, results read models)
    providers/            Provider adapters: STAC imagery, weather, news, reference, geocoding
    analytics/            Raster engine: COG reading, indices, masks, change detection, rendering
    pipeline/             Catalog sync, asset processing, change detection, context, reference import
    jobs/                 Queue, worker, scheduler, handler registry, heartbeats
    alerts/ notifications/ reports/ exports/   Alerting, delivery, reports (PDF), exports
  instrumentation.ts      Production preflight at server start
  proxy.ts                Optimistic auth redirect + nonce CSP for platform routes
public/
  brand/                  Standalone logo SVGs
  media/video/            Hero and flyover video
  media/map/              Command preview map layers (USGS public domain)
scripts/                  Asset-generation scripts (see scripts/README.md); build-scripts.mjs (worker/CLI bundles)
scripts/oryn/             CLI: migrate, admin, accounts, verify, seed, worker, e2e fixtures, maintenance
deploy/rehearsal/         Local production rehearsal configuration (local-only values)
tests/                    unit/, integration/, e2e/ (Playwright), fixtures/, helpers/
```

**Tailwind configuration:** Tailwind v4 is configured CSS-first in `src/app/globals.css` (`@theme` tokens and `@utility` type scale). The platform UI uses the same tokens.

## Editing website content

| To change… | Edit |
| --- | --- |
| Navigation, footer links, site description | `src/content/site.ts` |
| Industry pages (copy, images, status) | `src/content/industries.ts` |
| Aero specifications, modules, 3D explorer systems, roadmap | `src/content/aero.ts` |
| SensorDyme Edge pipeline, device parts, measurements, status | `src/content/sensordyme.ts` |
| Architecture stages, pillars, principles | `src/content/technology.ts` |
| Command preview sample missions | `src/content/missions.ts` |
| Intelligence demos | `src/content/intelligence.ts` |
| Team (About page) | `src/content/team.ts` |
| Images, alt text, credits | `src/content/media.ts`, `src/content/credits.ts`, `MEDIA_CREDITS.md` |

### Content integrity rules

ORYN is early-stage. The site and the platform are written to be ambitious but accurate:

- **Specifications** in `src/content/aero.ts` are `null` ("To be established") until they are measured. Only add a value once it has been validated.
- **Team:** `src/content/team.ts` is empty on purpose. Add real people only; the About page shows a founder-led statement until then.
- **Previews** on the website (Command, Portal, the Intelligence demos) are labeled "Interactive product preview", "Concept preview", "Sample data", or "Illustrative"; they are illustrations, not the platform. Keep those labels until they connect to production systems.
- **Third-party hardware** in photos is captioned "Representative — not ORYN hardware." SensorDyme Aero is shown only as ORYN's code-built concept model, never with stock photography.
- **SensorDyme claims** come from the SensorDyme device repository and demo. Measured figures in `src/content/sensordyme.ts` are from one prototype unit and are labeled as such.
- **No** fabricated customers, partners, certifications, statistics, or testimonials.
- **Platform data:** synthetic records are flagged (`is_synthetic`) and labelled in the UI; nothing is invented when a source is unavailable; candidate changes are never presented as verified events; forecasts, model estimates, observations, and claims are kept distinct.

## Accessibility and performance

- Semantic landmarks, skip link, visible focus states, keyboard support (tabs, sliders, menus, the comparison divider), and labelled form controls.
- Charts include a table view; colors were validated for contrast and color-vision deficiency on the dark surface; identity is never conveyed by color alone.
- `prefers-reduced-motion` is respected.
- Satellite rasters are processed server-side; the browser receives a small PNG preview per observation, never full scenes.

## Media and licensing

Website media: see [`MEDIA_CREDITS.md`](./MEDIA_CREDITS.md) (also at `/credits`). Platform data sources and their licences: [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
