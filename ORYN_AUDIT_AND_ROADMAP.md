# ORYN: capability audit and product roadmap

Audit date 2026-10-17, branch `experiment/oryn-unified-platform` (local only).
Scope: the ORYN application in `web/` and the God's Eye View engine at the
repository root, as integrated in `ORYN_INTEGRATION_PLAN.md`.

Every statement carries one of these labels:

| Label | Meaning |
| --- | --- |
| **RUN** | Executed or observed on this machine on 2026-10-17. |
| **CODE** | Read in the code at the cited place; not executed. |
| **DOC** | Stated in the repository's own documentation; not reproduced here. |
| **PROPOSAL** | Not built. A recommendation. |
| **ASSUMPTION** | A judgement or an external fact not verified here. |

Nothing in this document is a measured accuracy figure for ORYN. ORYN has no
ground-truth validation set; the one documented cross-check is a numerical
reproduction (GDAL/numpy), not an accuracy assessment.

---

## Phase 1: capability audit

### 1.1 What was run

| Check | Result | Label |
| --- | --- | --- |
| `web` unit tests (`npm test`) | 326 passed, 9 skipped | RUN |
| `web` integration tests against PostgreSQL with RLS (`npm run test:integration`) | 100 passed, 4 skipped | RUN |
| `web` type check, lint | pass | RUN |
| `web` end-to-end (Playwright, real server and database) | 24 passed (earlier today, before the uncommitted `next.config.ts` change, which only takes effect when `ORYN_DEV_ORIGINS` is set) | RUN |
| Engine tests (`npm test` at root) | 7,695 passed, 0 failed, 10 skipped | RUN |
| API access checks (signed out, member, other org, viewer write, engine gate, sign-out) | 15/15 | RUN |
| Row-level security: `oryn_app` without tenant context | sees 0 of 4 areas | RUN |
| Imagery pipeline: worker draining the real job queue (`npm run worker -- --once`) | see 1.2 | RUN |

CI (`.github/workflows/ci.yml`) runs only the engine. **No ORYN web test runs
in CI** (CODE).

### 1.2 Works end to end

**Imagery pipeline (RUN, this machine, 2026-10-17).** One 25-minute worker
run (`npm run worker -- --once`, stopped by its time limit) completed 254 jobs
with 0 failures and 0 error log lines. It searched the catalogs, linked items
to the synthetic areas, read the pixels and stored observations:

- 77 real catalog items stored with provenance: Earth Search Sentinel-2 L2A
  (31), Planetary Computer Sentinel-1 RTC (28), Landsat C2 L2 (16), ESA
  WorldCover (2).
- 547 real observations across the Sample Farms and e2e areas, covering
  2026-04-21 to 2026-10-16. The e2e orgs also hold 12 fixture rows.
- Sample Farms alone: 375 observations, of which 303 valid and 72 stored as
  **unusable** with their reason (cloud masking leaves too little of the
  area).
  - Sentinel-2: 93 each for NDVI, NDMI and NDWI.
  - Landsat: 48 each for NDVI and NDMI.
- Example: `S2C_18STE_20261016_0_L2A`, acquired 2026-10-16 12:03 UTC, Field C NDVI
  median 0.334, model `ndvi` v1.0.0. The observation carries the licence
  "Copernicus Sentinel data terms".
- 8,661 weather records from NWS and Open-Meteo, each stored as observation,
  forecast or model estimate.
- When the worker stopped, 155 scene jobs, 214 change-detection jobs and
  245 alert-evaluation jobs were still queued. **Change detection, radar
  water, land cover and alerting have not yet run on real data on this
  machine.** They are covered by integration tests with mocked imagery
  (CODE). The 2 jobs left `running` are reclaimed by the queue's stale-job
  sweep.
- The Sample Farms areas are synthetic polygons over real places, flagged
  synthetic. The imagery and measurements over them are real.

**Platform (RUN unless noted):**

- Sign-in (Better Auth, scrypt, 12-character minimum, database sessions,
  5 attempts/min), sign-out revocation, roles, and organisation isolation via
  the API.
- Row-level security. Every tenant table has RLS and the app role cannot
  bypass it (CODE: `web/db/migrations/0001`).
- Website parity: 12 public and 18 platform pages are pixel-identical to the
  original.
- Areas of interest:
  - Draw, GeoJSON upload, Census TIGERweb place or county boundary import, or
    the API. Points and lines are buffered.
  - Areas must be between 100 m² and 2,500 km² and are validated in PostGIS
    (CODE; e2e-covered).
- Detection review: confirm or dismiss requires a note and is audited
  (CODE; e2e).
- Alert rules (9 types), dedupe, cooldown, escalation sweep, in-app
  notifications (CODE; integration-tested).
- Reports: 8 types (field, aoi, change, weather, municipal, disaster,
  processing, audit). Each is a PDF with a frozen evidence snapshot and one
  index map (CODE; e2e).
- Exports: GeoJSON, CSV, observation GeoTIFF, report PDF; audited, with expiry
  (CODE).
- Append-only audit log of about 42 actions, enforced by a trigger, kept at
  least 90 days (CODE).

**Map workspace (2D, MapLibre):**

- Area drawing and editing, imagery timeline, per-observation index and
  true-colour rasters, before/after panels, swipe compare, ΔNDVI change map
  (CODE: `web/src/components/map/detection-inspector.tsx`).
- Sources page per provider (CODE).

**Intelligence globe (God's Eye View engine, RUN):**

- The engine loads behind ORYN's session gate.
- 32 layers. Layer state, counts and retrieval times reach ORYN's panel.
- ORYN areas and findings are drawn on the globe, and selecting one opens
  ORYN's cards.
- Live feeds observed through ORYN: USGS earthquakes, NIFC perimeters, NHC
  cyclones, nowCOAST radar, ECCC air quality, CelesTrak, Launch Library,
  OpenSky/adsb.lol aircraft, adsb.lol military and GNSS, CCTV.

### 1.3 Placeholder, fixture, simulated or estimated

| Item | What it really is | Label |
| --- | --- | --- |
| e2e fixture observations, a "strong" change and a low-vigour zone (`web/scripts/oryn/e2e-fixtures.ts:93-144`) | Invented rows marked valid, written to the **developer database**, under an org banner that says "Imagery and measurements over them are real" (`web/src/components/platform/ui.tsx:248-254`). False for these rows. | CODE |
| Marketing previews and demos (`components/previews`, `home`, `viz`) | Illustrative, mostly labelled; `home/managed-steps.tsx` is unlabelled. Not used in the app. | CODE |
| Engine **traffic** layer | Simulated vehicles on real OSM roads unless a TomTom key is set | CODE |
| Engine **CCTV** poses | Estimated. Cameras without a published facing get a bearing hashed from the id. When live video fails, frames fall back to Street View or a synthetic SVG. | CODE |
| Engine **launch** trajectories | Labelled "reconstructed estimate" | CODE |
| Engine **wind** | Model forecast (GFS/ECMWF), not observation | CODE |
| Engine **satellites** | SGP4 propagation of TLEs up to 6 h old | CODE |
| Engine **GNSS integrity** | Unvalidated classifier | CODE |
| Engine **detection overlay** | Screen-space boxes around already-known entities; no computer vision exists | CODE |
| Engine bundled datasets | Datacenters (4,351, no extraction date), dams (704, mislabelled "USACE"; actually OSM), submarine cables (712), military names, Bhote Koshi event | CODE |
| ORYN `EngineCard` | Labels every engine record "Provider-reported / Public feed", including computed, simulated and bundled ones | CODE |

### 1.4 Real datasets

ORYN's own providers are polled. Every stored item keeps provider, collection,
item id, catalog URL, acquisition time, time first seen, licence and
attribution (CODE, RUN for the rows above).

| Dataset | Source | Coverage | Cadence in ORYN | Licence / commercial use | Status |
| --- | --- | --- | --- | --- | --- |
| Sentinel-2 L2A (COG) | Earth Search (AWS) | Global land; archive from 2015-06-27 | Polled per area; 10-day look-back, 180-day backfill | Copernicus terms, commercial OK with attribution | RUN |
| Landsat C2 L2 | Planetary Computer | Global; archive from 1982-08-22 | Same | USGS public domain | RUN (ingest) |
| Sentinel-1 RTC | Planetary Computer | Global; from 2014-10-10 | Same | CC BY 4.0 | RUN (ingest) |
| ESA WorldCover; IO LULC annual | Planetary Computer | Global; 2020–2021; 2017–2023 | Annual | CC BY 4.0 | RUN (WorldCover ingest) |
| NWS alerts, forecasts, observations | weather.gov | US only | Polled | Public domain | RUN |
| Open-Meteo history and forecast | open-meteo.com | Global | Polled | CC BY 4.0, **free API non-commercial**; disabled in production without a paid key | RUN |
| GDELT DOC 2.0 news | gdeltproject.org | Global | 15 min | Free incl. commercial | **Never succeeded** (429 every request, DOC) |
| Census TIGERweb boundaries; Census geocoder | census.gov | US | On demand | Public domain | DOC (verified 2026-10-15) |
| OSM via Overpass | overpass-api.de | Global | On demand, capped at 5,000 features | ODbL (share-alike for derived databases) | DOC |
| USGS National Map tiles, OpenFreeMap, FEMA NFHL | | US / global | Display only; never analysed | Public domain / OSM ODbL / FEMA | DOC |
| Copernicus Data Space, NASA HLS | | | Catalog search only; never analysed | | CODE |

Temporal extents above were read from the providers' STAC collection
endpoints on 2026-10-17 (RUN). Revisit frequency per mission is a published
mission characteristic, not something ORYN measured (ASSUMPTION).

Engine feeds and their licences are listed in full in Appendix A.

### 1.5 Analyses implemented and how they are tested

| Analysis | Method (CODE: `web/src/server/analytics`, `pipeline`) | Test level |
| --- | --- | --- |
| NDVI, NDMI, NDWI | COG range reads on the native grid, published scale and offset. SCL classes 4–6 kept (Sentinel-2); fill, cloud, shadow, cirrus and snow excluded (Landsat). Under 20 % usable pixels → stored unusable. More than 10 % of clear pixels below −0.02 → refused as `implausible_reflectance`. | Unit (exact numbers); one opt-in real-COG smoke test. RUN on this machine. |
| NDVI anomaly | z-score against the area's own same-season history (at least 3 dates) | Unit |
| Low-vigour zones | median − max(1.5 × robust σ, 0.10), at least 2,000 m², persistence check | Unit, integration |
| NDVI candidate change | \|ΔNDVI\| ≥ 0.2, at least 2,000 m², 4-connected. Compared against the most recent earlier usable image of the same collection within 400 days, same CRS, at least 30 % clear in both. Evidence grade strong/moderate/weak with stored reasons; no numeric confidence. | Unit; integration with **mocked imagery** |
| Radar water (Sentinel-1) | VV < −18 dB; same relative orbit only | Unit only; the pipeline integration test never reaches this branch |
| Water change | Newly wet pixels | Unit only |
| Land-cover composition | Aggregates the provider's own classification maps (ORYN has no model of its own) | Unit |
| Alert evaluation (9 rule types) | Rule thresholds over observations, weather and warnings | Integration |
| Report summary (optional) | Anthropic API; each sentence must cite evidence or is dropped; deterministic fallback | Unit with an injected client; the real client is untested |
| Validation | GDAL/numpy reproduction of NDVI on the US-Ne1 maize field (2026-10-16) | DOC only; not in the test suite |

Engine analytics are client-side filtering, counting and nearest-neighbour
over records already loaded in the browser, plus SGP4 satellite passes (CODE).
They are not geospatial analytics over ORYN data.

### 1.6 Data-processing capabilities (CODE)

- Raster:
  - COG windowed reads over HTTP.
  - The area is projected into the image CRS (EPSG:4326, 3857 or WGS84 UTM
    only) and the grid snaps to source pixels, so there is no resampling.
  - 25 M pixel budget.
  - Exact statistics: mean, median, p10, p90, standard deviation, histogram.
  - PNG rendering (index palettes, true colour), GeoTIFF export.
- Vector: PostGIS validation, geodesic area, buffering, change-region
  polygons, GeoJSON/CSV export.
- **Not supported:**
  - Mosaicking. An area spanning two tiles gets one observation per tile.
  - Comparison across UTM zones.
  - Shapefile, KML and GeoPackage upload (rejected explicitly).
  - Elevation analysis. The `elevation` asset kind exists in the schema;
    nothing fills it.
  - PNG export, which the schema allows but nothing implements.

### 1.7 Partial or broken (all verified in code unless noted)

| # | Defect | Where | Effect |
| --- | --- | --- | --- |
| 1 | The "schedule" alert trigger is declared by all 9 rule types, but nothing enqueues it | `web/src/server/alerts/rules.ts`; enqueues only in `pipeline/{process,change,context,zones}.ts` | `stale_observations` cannot fire when imagery stops arriving entirely. New rules are not evaluated until new data arrives. |
| 2 | Notes ignore area restrictions | `web/src/server/results/service.ts:451-455` checks only `org_id` | A member restricted to some areas can read and write notes on any record in the org by id |
| 3 | Dashboard "Field health" and the area chart mix Sentinel-2 and Landsat, including same-pass tile duplicates | `web/src/app/(platform)/app/[org]/page.tsx:40-49` | Contradicts the registry's own non-comparability limitation |
| 4 | Fixture observations under a "real" banner | 1.3 | Misleading in demos |
| 5 | `GET /exports` checks `results.read`, but the service asserts `exports.create` | exports route vs `listExports` | Viewers get 403 (fails closed) |
| 6 | Scheduled cluster syncs are stored with `org_id = null` | sources page | Tenants see only backfills |
| 7 | AI summary is on by default through the API, opt-in in the UI | `web/src/server/reports/handlers.ts:74` | Inconsistent consent |
| 8 | Removing a member does not revoke their API keys | `orgs/service.ts:111-131` | Access persists until expiry or account disable |
| 9 | FIRMS events reach ORYN with no observation time (bridge reads `acqMs`, record has `acqTime`); FIRMS ids change on every refresh | `src/ui/host/hostBridge.js:58`, `src/layers/firms/firmsAdapt.js:34` | Integration bug introduced in this branch |
| 10 | Cyclone events always have `observedAt: null` | `hostBridge.js:80` | Missing time on official advisories |
| 11 | Google, TomTom and Mapillary routes return 403 through the ORYN proxy | `src/localRequestGate.mjs` refuses `x-forwarded-host` | Those layers cannot work under ORYN (they also need paid keys) |
| 12 | Turning on Space Missions switches other layers off without explanation | engine context-mode policy | Confusing |
| 13 | GDELT has never returned data; CDSE and HLS are catalog-only | DOC | Not usable |
| 14 | Deployment files and `docs/DEPLOYMENT.md` are referenced but absent | excluded at import | No deploy path from this repo |

### 1.8 What blocks a customer pilot

Ordered by severity. All CODE unless noted.

1. **Licensing.**
   - The served engine build contains non-commercial data: TeleGeography
     cables (CC BY-NC-SA) and the Bhote Koshi pack (CC BY-NC).
   - Restricted feeds are reachable: OpenSky (non-commercial), Google News
     RSS (personal use), the Open-Meteo free tier inside the engine, Esri World
     Imagery as the default engine basemap, adsbdb enrichment, FOSSGIS OSRM,
     and DelDOT cameras.
   - ORYN's notices state that none of these are used
     (`web/THIRD_PARTY_NOTICES.md`, `web/docs/PROVIDERS.md`).
   - The engine build ships without its MIT notice or Cesium's licence.
2. **Engine isolation.**
   - The engine is same-origin with no sandbox.
   - Its CSP allows `'unsafe-eval'`, any https `connect-src`, and third-party
     script hosts.
   - ORYN pushes areas and findings into it.
   - So any script running in the engine could call `/api/v1/*` with the
     user's cookie. No concrete XSS was found, but this is the blast radius.
3. **No deployment path and no CI for `web/`.** The engine "server" is
   `vite preview`.
4. **The public tunnel (RUN).**
   - The dev server is reachable at a public `trycloudflare.com` address.
   - The database there holds the e2e accounts, including platform admin
     `e2e-admin@oryn.local`, whose password is the default published in the
     repository.
   - Dev mode also turns off secure cookies, HSTS and the integration gates.
5. **Engine gate and rate limits.**
   - The gate checks for a session only: not membership, `mustChangePassword`
     or trial limits. Results are cached 30 s.
   - Every user shares one engine rate-limit bucket, because all requests
     arrive from 127.0.0.1.
   - 14 engine routes have no limiter.
6. **Customer-facing gaps.**
   - No MFA or SSO.
   - No delete path for areas, findings or users, and no customer data export
     or offboarding.
   - Failed sign-ins and password resets are not audited.
   - No `statement_timeout`.
   - The outbound URL guard can be bypassed through redirects.
   - Engine assets are served `no-store` (44 MB).
   - No privacy policy, terms, DPA or accessibility statement.
   - No pen test or SOC 2 (DOC).

Working well (CODE): authentication design, RLS on every tenant table,
explicit org filters, hashed scoped API keys, guarded server actions, job
queue (SKIP LOCKED, idempotency, heartbeats, reclaim), fixed upstream URLs with
size caps, secret redaction in logs, and permissive licences for all code
dependencies (no GPL/AGPL/SSPL/BUSL).

---

## Phase 2: shared geospatial intelligence architecture (PROPOSAL)

One set of primitives serves agriculture, property and land, and municipal
users. A domain is configuration (default rules, report templates, labels),
not a separate code path. Most primitives already exist; the work is to make
them uniform and to add the missing ones.

```
                       ORYN web (Next.js)                         engine (GEV, framed)
  ┌───────────────────────────────────────────────────────────┐   ┌──────────────────┐
  │ UI: Map workspace (2D: draw, timeline, compare, review)   │   │ globe, live feeds│
  │     Intelligence globe ──bridge──────────────────────────────►│ context only;    │
  │     Findings · Investigations · Reports · Monitoring      │   │ no DB access     │
  ├───────────────────────────────────────────────────────────┤   └──────────────────┘
  │ API /api/v1/orgs/[org]/…  · server actions                │
  │ access.assert(permission) · aoiVisibleTo(member)          │
  ├───────────────────────────────────────────────────────────┤
  │ Services: areas · ingestion · analysis · comparison ·     │
  │   findings+evidence · rules/alerts · reports · cases      │
  ├───────────────────────────────────────────────────────────┤
  │ withTenant(org) → PostgreSQL + PostGIS (RLS on org_id)    │
  │ object storage, keys under orgs/<org>/                    │
  │ job queue + worker (same services, same tenant context)   │
  │ audit_events (append-only)                                │
  └───────────────────────────────────────────────────────────┘
```

| Primitive | Exists today | Proposed change |
| --- | --- | --- |
| **Area** (`aois`) | Geometry, provenance, monitoring config, per-member restriction | Add a domain profile (agriculture, property, municipal) that selects default rules and report templates |
| **Ingestion** | Provider adapters → shared `source_assets` → `aoi_assets` → jobs; polled; licence per item | Add versioned reference datasets with vintage and licence: customer-supplied parcels, 3DEP elevation, NFHL zones clipped per area, CDL. All go through the same registry and gates. |
| **Provenance** | Per asset (provider, item id, URLs, acquisition time, first seen, licence) and per run (model, version, parameters, input and baseline assets) | Assemble one **Evidence** record server-side: source, observation date, method and version, parameters, uncertainty (grade, reasons, clear fraction, pixel count), limitations, data state. Render it identically in the app, API and PDF. |
| **Data state** | Unusable observations and gated providers say why | One vocabulary on every value: `current`, `stale` (older than a per-source threshold), `missing`, `unavailable` (provider off or failing), `contradictory` (for example, two sensors disagree beyond tolerance). Each state carries a reason, so nothing is shown as current when it is not. |
| **Time comparison** | Consecutive comparison: latest usable image vs the most recent earlier one | Add explicit **period comparisons**: baseline and comparison windows, the observation chosen in each, and why it was chosen. Stored as their own records. |
| **Spatial analysis** | Raster statistics, change regions, PostGIS geometry | Intersect findings with reference features (parcels, flood zones, land cover) and store each result with the source vintage |
| **Findings** | `detections` with evidence grade, reasons, verification state, notes | Attach the Evidence record; findings link to period comparisons |
| **Monitoring rules and alerts** | 9 rule types, dedupe, cooldown, escalation, in-app notifications, email when configured | Add the missing scheduled evaluation and data-freshness rules; ship domain rule templates |
| **Reports** | 8 types, PDF, frozen evidence snapshot | Add a change-evidence report with a page per finding |
| **Investigations** | Notes and audit history only | `cases` grouping findings, alerts, observations, notes and reports, with status, assignee, due date and a timeline built from audit events |

**Connection to the existing backend (all PROPOSAL, following existing
patterns, CODE):**

- **Persistence and isolation.** Every new table gets `org_id` and
  `enable_tenant_rls`, is written only through `withTenant`, and keeps
  storage keys under `orgs/<org>/`.
- **Authorization.**
  - New permissions (for example `cases.read`, `cases.write`,
    `comparisons.run`) are added to `web/src/lib/authz.ts` for the five roles.
  - Area-restricted members are filtered with `aoiVisibleTo`, including notes
    (defect 2).
  - API-key scopes are extended explicitly.
- **Jobs and audit.** Long work runs as queue jobs under the same tenant
  context. Every state change writes `audit_events`.
- **The engine.** It never reads the database. ORYN passes it only what the
  signed-in user may see, through the bridge. A dated engine event can be
  pinned into an investigation as an `external_events` row with source, time
  and licence, from licence-clean feeds only.
- **The 2D Map workspace** stays the place where areas are edited and
  findings are reviewed, as decided.

---

## Phase 3: ranked roadmap

Scores are my judgement (ASSUMPTION), 1–5, higher is better on every column:

- **Complexity:** 5 = least build and maintenance.
- **Demo:** 5 = fastest to a convincing demo.

All criteria are weighted equally.

| Rank | Candidate | Problem | Free data | Complexity | Reliability | Demo | Value | Municipal | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Exportable polished reports | 4 | 5 | 4 | 4 | 5 | 5 | 5 | **32** |
| 2 | Evidence-backed findings and investigation history | 4 | 5 | 4 | 5 | 4 | 4 | 5 | **31** |
| 3 | Historical imagery and land-change detection (period comparison) | 5 | 5 | 3 | 3 | 4 | 5 | 4 | **29** |
| 3 | AOI monitoring and alerts (hardening) | 4 | 5 | 4 | 4 | 4 | 4 | 4 | **29** |
| 5 | Case management and team workflows | 3 | 5 | 3 | 5 | 3 | 3 | 4 | **26** |
| 6 | Property and parcel intelligence | 4 | 2 | 3 | 3 | 3 | 4 | 4 | **23** |
| 7 | Terrain, land cover, preliminary flood-hazard screening | 4 | 4 | 2 | 2 | 3 | 3 | 4 | **22** |
| 8 | Agricultural land and crop context | 3 | 3 | 3 | 4 | 3 | 3 | 1 | **20** |

Reasoning behind the less obvious scores:

- **Land change, reliability 3.** Consecutive-scene ΔNDVI mostly measures
  phenology and residual cloud. Season-matched comparison is the method that
  fits land-change questions. The 10 m pixel and the 2,000 m² minimum also
  exclude small structures.
- **Parcels, free data 2.** There is no free national parcel layer. Counties
  publish their own data under varying terms, so parcels must come from the
  customer (ASSUMPTION).
- **Flood screening, reliability 2.** FEMA NFHL is regulatory mapping, and
  ORYN's water analytics are explicitly not flood forecasts. Any "screening"
  output is hard to validate and carries liability, so it needs careful
  wording and scope.
- **Crop context, free data 3.**
  - Planetary Computer's `usda-cdl` ends in 2021 and is marked proprietary in
    its STAC entry (RUN).
  - Current CDL years would have to come from USDA NASS directly and be
    hosted as COGs (ASSUMPTION: NASS CDL is public domain).
- **Elevation.**
  - `3dep-seamless` on Planetary Computer is PDDL-1.0 (RUN).
  - `cop-dem-glo-30` is marked proprietary in STAC (RUN), so its terms need
    review before commercial use.

**Strongest first paid offering (PROPOSAL):** *area change monitoring with
evidence reports*. Ranks 1, 2 and 3 combine into one product: a customer
defines areas, ORYN compares like-for-like seasons, analysts review candidate
changes, and the customer receives a PDF in which every finding shows its
imagery, dates, method and uncertainty.

- **Municipal fit.** Land clearing and grading, new impervious surface at
  site scale, vegetation loss along buffers and corridors, new standing water.
- **Property and land fit.** Monitoring of holdings and easements.
- **Agriculture fit.** Season-to-season field change, plus the existing
  low-vigour zones.
- **Why it fits.** It uses only free, commercially usable imagery (Sentinel-2,
  Landsat) and infrastructure that already works (RUN). It depends on none of
  the licence-restricted engine feeds.

---

## Phase 4: milestones (PROPOSAL)

Order: **M0 → M1 → M2 → M3**, then **M4–M6** as customer demand dictates. M0 is
a gate. No paid pilot happens before M0b, whatever feature work is done.

### M0a: make the current build truthful and safe (blocks any external demo)

**Problem.** The build ships non-commercial data and has several defects that
show wrong or missing facts.

**Files.**

- Engine build: `scripts/oryn-engine.mjs`, `build/vite.js`,
  `src/data/layerState.js`, `src/app/constructCatalog.js`, `src/data/bhoteKoshi*`.
- Engine data handling: `src/ui/host/hostBridge.js`,
  `src/layers/firms/firmsAdapt.js`, `src/data/infrastructure.js`.
- Engine card: `web/src/components/intel/engine-workspace.tsx`.
- ORYN defects: `web/src/server/results/service.ts`, exports route,
  `web/src/server/reports/handlers.ts`,
  `web/src/app/(platform)/app/[org]/page.tsx`, `web/src/server/orgs/service.ts`,
  the sources page query.
- Fixtures and notices: `web/scripts/oryn/e2e-fixtures.ts`,
  `web/tests/e2e/global-setup.ts`, `web/THIRD_PARTY_NOTICES.md`,
  `web/docs/PROVIDERS.md`.

**Data and licensing.**

- The host-mode build excludes the TeleGeography cables and the Bhote Koshi
  pack.
- In host mode these feeds are disabled or opt-in: OpenSky (use adsb.lol under
  ODbL), Google News RSS, Open-Meteo free tier, FOSSGIS OSRM, DelDOT, adsbdb.
- The Esri default basemap is replaced with a commercially usable one. USGS
  National Map imagery is the US option ORYN already uses; outside the US this
  is an open question.
- The engine and Cesium licence files ship with the build.
- The notices are corrected.

**Changes.**

- Engine bridge:
  - FIRMS `observedAt` from `acqTime`.
  - Stable FIRMS ids (satellite, acquisition time and position).
  - Cyclone `observedAt` from `issuedAt`.
  - Dams source label.
- `EngineCard` provenance labels distinguish observed, model, computed,
  simulated, estimated and bundled, using the engine's own metadata.
- ORYN defects 2, 3, 5, 6, 7 and 8 from 1.7.
- The e2e fixtures move to their own database, and the synthetic banner says
  which rows are fixtures.

**Acceptance.**

- `dist-engine/` contains no CC BY-NC or CC BY-NC-SA file (grep test in CI).
- With default settings, no restricted feed is requested.
- Each defect has a failing test first, then passes.

**Tests.**

- Engine: bridge mapping tests for FIRMS and cyclones.
- Web integration: notes with an area-restricted member; exports list by
  role; API key revocation on member removal.
- Unit: the dashboard series filters to one collection.

**Out of scope.** Commercial licences for restricted feeds.

### M0b: pilot-grade operation (blocks a paid pilot)

**Problem.** There is no deployment path, the engine is not isolated, and
access controls are too coarse for customer data.

**Files.** `web/src/server/intel/engine-gate.ts`, `web/src/proxy.ts`,
`server/providers/common/rate-limit.js`, `.github/workflows/ci.yml`,
deployment files (restored from ORYN-WEBSITE with your approval),
`web/src/server/net.ts`, the database client configuration.

**Changes.**

- **Engine isolation.** Serve the engine from its own origin, so ORYN cookies
  cannot reach it, and move the bridge to `postMessage`. Until then, ship a
  host-mode CSP limited to the hosts the enabled feeds need, with no
  third-party script hosts.
- **Engine gate.** Require an active membership in the org being viewed and
  no `mustChangePassword`. Cache negative results briefly and rate-limit them.
- **Rate limits.** Key engine limits per user: ORYN forwards a hashed user id,
  which the engine trusts only from loopback. Add limiters to the 14 routes
  that have none.
- **Database and network.** Add `statement_timeout` for app and worker
  connections. Re-validate the outbound URL guard on every redirect.
- **Caching.** Serve hashed engine assets `immutable`.
- **CI.** Run unit, integration (Postgres service), type check, lint and
  build for `web/`.
- **Accounts.** MFA through Better Auth's free two-factor plugin. Audit failed
  sign-ins and password resets.
- **Data rights.** Delete and export paths for areas and their results.

**Acceptance.**

- An engine document cannot read `document.cookie` for the ORYN origin, and
  cannot fetch `/api/v1` with credentials.
- The CI run is green on a fresh runner.
- A removed member loses API and engine access immediately.

**Tests.** Playwright cross-origin checks, gate tests per account state,
redirect-to-private-address test, timeout test.

**Out of scope.** SOC 2, SSO/SAML, and legal documents (these need counsel).

### M1: period change evidence report (recommended next feature, Phase 5)

Specified in Phase 5 below.

### M2: monitoring that reports its own freshness

**Problem.**

- A monitored area can silently stop receiving usable imagery.
- New rules wait for new data before they run.

**Files.** `web/src/server/alerts/{rules,pipeline,handlers}.ts`, the
scheduler in `web/src/server/jobs/`, `web/src/components/map/aoi-inspector.tsx`,
and a data-state helper in `web/src/lib/`.

**Data.** No new sources.

**Changes.**

- A daily scheduled evaluation per area, which also runs once when a rule is
  created.
- The data-state vocabulary from Phase 2 on the area inspector and dashboard.
  Staleness thresholds come from each product's expected revisit plus a cloud
  allowance, documented per product.

**Acceptance.**

- `stale_observations` fires for an area with no new usable image beyond its
  threshold.
- A new rule evaluates once against existing data.
- Each area shows when each source last delivered usable data, and why if not.

**Tests.** Integration with a frozen clock; idempotency of the daily sweep.

**Failure handling.**

- A provider outage marks sources `unavailable`. It does not mark areas
  stale.
- Escalation stays capped at once per alert.

**Out of scope.** SMS and push notifications.

### M3: investigations

**Problem.** Reviewers need to group related findings, alerts and notes,
assign the work, and show the history to a supervisor or auditor.

**Database.**

- New tables `cases` and `case_links`, with RLS.
- The case timeline is a view over `audit_events` and notes.

**UI and API.** A case list and a case page in the platform shell, using
existing `ui.tsx` components. An "Add to case" action on finding and alert
cards. API routes under `/api/v1/orgs/[org]/cases`.

**Permissions.**

- `cases.read` for every role except field operators restricted to other
  areas.
- `cases.write` for org admins and analysts.

**Acceptance.**

- A case lists its linked items with their Evidence records.
- Every change appears in its timeline.
- A restricted member sees only cases whose items are all visible to them.

**Tests.** RLS and authorization integration tests; e2e of the create,
link, assign and close flow.

**Out of scope.** External sharing links.

### M4: parcel attribution (customer-supplied parcels)

**Problem.** Municipal and property users think in parcels, not polygons.

**Data.**

- The customer uploads their parcel layer as GeoJSON (existing upload path,
  `parcels` category).
- ORYN stores the declared source and vintage, and does not redistribute it.
- No national parcel source is used.

**Changes.**

- Intersect each finding with parcels in PostGIS.
- Store the parcel id and the overlap area with the parcel layer's vintage.
- Show this on finding cards and in reports.

**Acceptance.** Each finding lists the intersecting parcels, with overlap in
m² and the layer's date.

**Out of scope.**

- Ownership lookup.
- Valuation.
- Any statement about permit status.

### M5: terrain, land cover and flood-zone context

**Data.**

- USGS 3DEP seamless DEM (PDDL-1.0, via Planetary Computer).
- ESA WorldCover and IO LULC (already ingested).
- FEMA NFHL zones intersected per area. The terms need to be confirmed
  before any stored copy.

**Output.**

- Per-area context: slope, elevation range, land-cover shares, share of the
  area in mapped flood zones, each with source and vintage.
- Labelled "context, not a flood model".

**Out of scope.** Flood prediction, inundation depth, insurance-grade risk.

### M6: crop context (agriculture)

**Data.**

- USDA NASS Cropland Data Layer, current years fetched from NASS and hosted
  as COGs. Licence and terms to be confirmed (ASSUMPTION: public domain).
- Planetary Computer's copy stops at 2021.

**Output.** The dominant prior-season crop class per field, with NASS's
published accuracy for that state and crop shown next to it.

**Out of scope.**

- In-season crop identification.
- Yield.

---

## Phase 5: recommended next feature: period change evidence report

**What it is.** For one area, compare the same season in two periods. For
example, September 2025 against September 2026, or a chosen date against "the
same weeks last year". ORYN produces reviewable candidate changes and a PDF in
which every finding carries its evidence.

**Why this one.**

- It turns the strongest working capability, real Sentinel-2 processing with
  provenance (RUN), into the answer customers will pay for: "what changed
  here, and how sure are you?"
- Comparing like-for-like seasons removes the main weakness of today's
  consecutive-scene change, which is phenology.
- It serves all three domains.
- It needs no new data source, no paid service and no restricted feed.

**Scope (first increment).**

1. **Request.** Area, baseline window, comparison window (each up to 60 days),
   and collection. Sentinel-2 L2A only in the first increment.
   - Started from the area inspector in the Map workspace, or through
     `POST /api/v1/orgs/[org]/aois/[id]/comparisons`.
   - Requires a new permission, `comparisons.run`, for analysts and org admins.
2. **Selection.**
   - In each window, ORYN picks the usable observation with the highest clear
     fraction on the same tile and CRS.
   - It searches the catalog for the baseline window if that window predates
     the 180-day backfill.
   - The reason for each choice is stored, along with the runner-up
     candidates.
3. **Analysis.**
   - Reuses the existing NDVI change analytic: same thresholds, minimum area,
     evidence grading and model version.
   - The baseline is pinned to the selected observation instead of "most
     recent earlier".
   - Results are stored as `candidate_change` detections linked to a new
     `comparisons` record (RLS), so they never mix with consecutive-scene
     detections.
4. **Evidence per finding:**
   - before and after true-colour crops, already rendered per observation;
   - the ΔNDVI crop;
   - item ids, acquisition times (UTC and the org's time zone), clear fraction
     in both images, method and version, thresholds;
   - evidence grade and its reasons;
   - review state and notes;
   - fixed limitations text.
5. **Report.**
   - A new `change_evidence` report type built on the existing PDF pipeline.
   - Layout: a summary page, an area map, then one page per finding.
   - Includes the attribution "Contains modified Copernicus Sentinel data
     [year]".
   - The optional AI summary keeps the existing rule: a sentence without
     evidence is dropped.
6. **Explicit outcomes when there is nothing to show:**
   - "no usable image in window" (with the scenes rejected and why);
   - "tiles or CRS differ: not compared";
   - "less than 30 % clear in both images";
   - "no change above threshold". This is a valid, reportable result.

**Likely files.**

- New: `web/db/migrations/0009_comparisons.sql`,
  `web/src/server/comparisons/{service,handlers,select}.ts`, the API route,
  and a comparison panel in `web/src/components/map/`.
- Modified: `web/src/server/pipeline/change.ts` (accept a pinned baseline),
  `web/src/server/reports/{types,assemble,pdf}.ts`, `web/src/lib/authz.ts`,
  `web/src/server/jobs/types.ts`.

**Acceptance criteria.**

- On a real area, a comparison stores both chosen observations with their
  selection reasons.
- Every finding in the PDF shows source item id, acquisition date, method and
  version, clear fractions, evidence grade with reasons, and limitations.
- Re-running the same request is idempotent.
- A viewer cannot start a comparison. A restricted member cannot compare
  areas they cannot see. Another org gets 404.
- Every "nothing to show" case renders its reason in the app and the PDF.

**Tests.**

- Unit: observation selection, including ties, all-unusable windows and
  mixed CRS.
- Integration: comparison against fixed raster fixtures, run with real
  analytics (not mocked), RLS and permissions.
- e2e: request, review, report download.
- A recorded real-scene smoke test, opt-in like the existing COG test.

**Risks.**

- Season-matched NDVI still reacts to crop rotation, harvest timing, drought
  and residual cloud or shadow. Findings stay "candidate change" until
  reviewed, and the PDF states this.
- Areas spanning two Sentinel-2 tiles get one comparison per tile, and the
  covered share is shown. Mosaicking is later work.
- A one-year baseline outside the backfill window needs extra catalog
  searches and processing, which means extra time and network use. Both are
  free sources and are rate-limited by the existing job queue.
- PDF size grows with the number of findings. Cap at 50 finding pages, with
  the rest listed in a table and in the GeoJSON export.

**Not supported.**

- Identifying what changed (for example "a building was constructed").
- Changes smaller than 2,000 m².
- Comparison across sensors.
- Accuracy figures, which ORYN cannot state without ground truth.

**Dependency.** M0a should land first, so that demos run on a build without
non-commercial data and with the fixture banner corrected.

---

## Appendix A: engine layers (CODE)

| Layer | Source | Credentials | Nature | Licence note |
| --- | --- | --- | --- | --- |
| Air quality | ECCC GeoMet AQHI | none | Observed, Canada only | Attribution |
| Live AIS vessels | AISStream | `AISSTREAM_API_KEY` | Observed | Beta, no formal terms |
| ALPR cameras | OSM via a community tile host | none | Crowd-mapped locations, US and Canada | ODbL; host terms unstated |
| Bhote Koshi flood and locator | Bundled | none | Static event | **CC BY-NC** |
| Bikeshare | GBFS (52 systems) | none | Observed | Per feed |
| CCTV | About 20 agency packs | optional keys | Real stills and HLS; **poses estimated** | Per agency; DelDOT unconfirmed |
| Directions | FOSSGIS OSRM | none | Computed | **Commercial use restricted** |
| Earthquakes | USGS | none | Observed (M ≥ 2.5 kept) | Public domain |
| Fire perimeters | NIFC WFIGS | none | Observed | Public domain |
| Live flights | OpenSky, fallback adsb.lol | optional | Observed, dead-reckoned between fixes | **OpenSky non-commercial**; adsb.lol ODbL |
| GNSS integrity | adsb.lol | none | Derived; unvalidated classifier | ODbL |
| Dams; datacenters | Bundled OSM extracts | none | Static | ODbL; dams mislabelled USACE |
| FIRMS fires | NASA FIRMS | `FIRMS_MAP_KEY` | Observed | Public domain |
| Military flights | adsb.lol | none | Observed | ODbL |
| Global context | Derived from other layers | n/a | Proximity only | Inherits |
| Mapped installations | OpenFreeMap and a bundled names pack | none | Crowd-mapped | ODbL |
| Radio | Radio Browser | none | Directory | PDDL |
| Recent imagery | NASA GIBS, CMR | none | Observed imagery | Public domain |
| Space missions | Launch Library 2, CelesTrak | none | Records plus **estimated trajectories** | Attribution |
| Satellites | CelesTrak | none | **SGP4 model output** | Citation requested |
| Street level | Mapillary, Google, KartaView, Panoramax | Mapillary or Google keys | Photos | CC BY-SA; Google terms |
| Submarine cables | Bundled TeleGeography | none | Static | **CC BY-NC-SA** |
| Street traffic | OSM roads, optional TomTom | `TOMTOM_API_KEY` | **Simulated** without a key | ODbL; TomTom proprietary |
| Transit | 16 GTFS-RT feeds | none | Observed, interpolated | Per operator; some revocable |
| Cyclones | NHC | none | Official advisories and forecasts | Public |
| Lightning, radar, satellite clouds | NOAA nowCOAST | none | Observed products | Public |
| Wind | GFS or ECMWF | none | **Model forecast** | Public domain / CC BY 4.0 |
| Local ADS-B | User's own receiver | hardware | Observed locally | User's own |

Voice control (OpenAI Realtime, paid) is not forwarded by ORYN and stays
unavailable.
