# ORYN platform architecture

## Components

```
                 ┌───────────────────────────── Next.js (one codebase) ─────────────────────────────┐
 Browser ──────▶ │ proxy.ts (CSP nonce, optimistic auth redirect)                                   │
 (MapLibre,      │ (marketing)/  public site                                                         │
  terra-draw)    │ (auth)/       sign-in, invitations, password reset   ──▶ Better Auth (/api/auth)  │
                 │ (platform)/app/[org]/…  server components + server actions                        │
 API clients ──▶ │ /api/v1/orgs/[org]/…    REST (session cookie or API key)                          │
                 │ /api/cron/tick          scheduler + bounded drain (serverless hosts)              │
                 └───────────────┬───────────────────────────────────────────────┬──────────────────┘
                                 │ oryn_app role (RLS enforced)                  │ object storage
                                 ▼                                               ▼ (local fs / S3)
                         PostgreSQL + PostGIS  ◀──────────────  Worker (npm run worker)
                         (tenant data, jobs,                    scheduler · catalog sync · raster analytics
                          audit, sessions)                      change detection · alerts · reports · exports
                                                                           │
                                                                           ▼
                         Earth Search · Planetary Computer · CDSE · NASA CMR · NWS · Open-Meteo · GDELT
                         Census TIGERweb · Census Geocoder · Overpass (OSM) · USGS / FEMA / OpenFreeMap tiles
                         USGS earthquakes · NIFC WFIGS perimeters (public event layers, fetched by the web app)
```

* **Server code** lives in `src/server` and is framework-independent where possible (the worker and tests import the same modules as the web app).
* **Long-running work** never runs in the request path: requests enqueue jobs; the worker executes them.
* **The browser never receives provider credentials or full scenes**; it receives GeoJSON and small rendered PNGs over tenant-checked endpoints.

## Tenancy and authorization

* Every tenant-owned table has `org_id` and **row-level security** (`enable_tenant_rls` in `db/migrations/0001`). The app connects as `oryn_app` (no BYPASSRLS) and runs each unit of work in a transaction with `app.org_id` set (`withTenant`). A missing `WHERE org_id = …` therefore returns nothing rather than another tenant's rows.
* Application code *also* filters by org explicitly; RLS is the second wall.
* Three contexts (`src/server/db/client.ts`): `withTenant` (one org), `withUser` (the user's own memberships only, to list their orgs), `withSystem` (cross-tenant platform operations: job claiming, scheduler, AOI matching, platform admin). `withSystem` call sites are few and grep-able.
* **Access resolution** (`src/server/authz/access.ts`) turns a session or API key into an `OrgAccess` with an explicit permission set from the role matrix (`src/lib/authz.ts`). Unknown org and non-member are indistinguishable (404). Platform administrators get **no** implicit tenant data access.
* Roles: organization administrator, analyst, field operator, read-only viewer, auditor. Members can be restricted to specific AOIs (`aoi_grants`).
* Pre-tenant lookups (pending invitation for an email, invitation by token, API key by prefix, whether an account is disabled) are narrow `SECURITY DEFINER` functions.
* **Accounts** are provisioned, never self-registered (`src/server/accounts/service.ts`; operator CLI `scripts/oryn/accounts.ts`; platform admin UI `/app/admin/accounts`). Sign-in is by username (Better Auth username plugin) or email. Account restrictions live in `account_controls` — *disabled*, *must change password* (no non-trial org until an administrator-issued password is replaced), *trial-only* (trial organizations only, which are synthetic by constraint) — and are loaded by the access resolver itself, so no caller can skip them; database triggers enforce trial isolation as well. Only an allowlist of Better Auth endpoints is served over HTTP (`src/server/auth/http.ts`). See `docs/OPERATIONS.md#accounts`.

## Data model (key tables)

| Table | Purpose |
| --- | --- |
| `organizations` (incl. `is_trial`), `memberships`, `invitations`, `api_keys`, `platform_admins` | Tenancy and access |
| `auth_*` | Better Auth users (incl. `username`, `displayUsername`), sessions, accounts, verification, rate limits |
| `account_controls` | Per-account restrictions: disabled, must change password, trial-only (writes only in platform context) |
| `aois`, `aoi_grants` | Areas of interest (MultiPolygon, EPSG:4326; geodesic area; boundary provenance; monitoring config) |
| `source_assets` | Provider catalog items (not tenant-owned): footprint, acquisition time, first/last seen by ORYN, GSD, cloud, grid, assets, licence |
| `aoi_assets` | Which assets matter to which AOI, coverage fraction, processing status and reason |
| `jobs` | Queue: idempotency keys, attempts, backoff, heartbeats, errors history, dead-letter |
| `analytic_models` | Registered analytic ids/versions, contracts, limitations |
| `processing_runs` | Every execution: model version, inputs, baseline, parameters, outcome, messages, software version |
| `observations` | Per (AOI, asset, model version) results: metrics, quality, raster refs, status valid/unusable; history kept across versions |
| `detections` | Candidate changes and other intelligence objects: geometry, metrics, thresholds, evidence grade + reasons, verification status |
| `alert_rules`, `alerts`, `alert_events`, `notifications` | Rule-driven alerting with distinct timestamps, dedupe, cooldown, lifecycle, escalation |
| `weather_records`, `external_events`, `news_articles`, `aoi_news_matches` | Context: observations / forecasts / model estimates, official warnings, news claims |
| `reference_layers`, `reference_features`, `uploads` | Imported reference data and uploaded files |
| `reports`, `exports`, `notes`, `audit_events` | Outputs, analyst notes, append-only audit trail |
| `saved_scenes` | Saved map views (view state only; `private` scenes visible to their author by RLS) |

The intelligence globe adds no tables: orbital elements and camera lists are public reference data cached in the web process.

## Workflows

### A — Agricultural monitoring
1. A user signs in (Better Auth) and opens the organization; the server resolves membership and role.
2. Fields are drawn on the map, uploaded as GeoJSON, or created via the API. Creation validates geometry in PostGIS, records boundary provenance, audits, and **queues a 180-day imagery backfill and a context refresh**.
3. The worker searches Sentinel-2 L2A (Earth Search) and Landsat C2 L2 (Planetary Computer), links matching scenes, and analyzes each: NDVI/NDWI per pixel from surface reflectance at 10 m, NDMI (canopy moisture) on its own 20 m (Landsat 30 m) grid, cloud/shadow masking (SCL / QA_PIXEL), AOI statistics, rendered previews.
4. The inspector and time-series chart (NDVI or NDMI, with daily precipitation) show every observation — unusable ones with their reason.
5. Within-field **low-vigour zones** are delineated on each usable NDVI image (relative to the field's own median that day) and checked for persistence in the previous usable image; change detection compares each observation with the most recent earlier usable one of the same collection (the ΔNDVI map is viewable on the map); the anomaly score compares with the field's own history.
6. Alert rules (NDVI drop vs. baseline, dry spell, heat, NWS warnings, stale data, …) evaluate as results arrive.

### B — Municipal monitoring
Same engine; boundary imported from Census TIGERweb; Sentinel-1 radar water, land-cover composition, candidate land change, NWS warnings, and news claims. Candidate changes enter the inspection queue; analysts confirm/dismiss with notes; reports and exports are generated in the background; every action is audited.

### C — New data arrives
1. **Scheduler** (`src/server/jobs/scheduler.ts`, every minute): due AOIs are grouped per product and **clustered spatially** (`ST_ClusterWithin`); one `provider.catalog_sync` job per cluster (time-bucketed idempotency key).
2. **Sync** searches the catalog for the cluster's bounding box and a lookback window, upserts `source_assets` (dedupe on provider+collection+item; republished metadata detected).
3. **Matching** intersects each footprint with every subscribed active AOI across tenants, computing coverage; links are recorded once; low coverage or excessive scene cloud is recorded as `skipped` with the reason.
4. **Processing** (`aoi.process_asset`) runs the AOI's enabled analytics; idempotent per (AOI, asset, model version).
5. **Validation**: unusable imagery is stored as `unusable` with a reason; implausible scaling metadata is refused (no numbers produced).
6. **Comparison** (`aoi.change_detection`) and **alert evaluation** (`alerts.evaluate`) follow as separate jobs.
7. Imagery loaded during a backfill that was acquired more than 7 days earlier is flagged **historical**: alerts are recorded but never notified as new.
8. **Context** (weather, warnings, news) runs as **one `aoi.context_sync` job per provider** (`nws`, `open-meteo`, `gdelt`). A provider failure fails only its own job — recorded in `jobs` and as a `failed` row in `provider_sync_runs`, then retried by the queue (non-retryable provider errors fail permanently; rate limits wait for the provider's cooldown). A provider that is not configured, not verified, or not licensed is not called, and its run is recorded as `skipped`. GDELT requests are spaced across all processes on the database clock (`provider_request_slots`).

Job failure policy (`src/server/jobs/queue.ts`): errors are retried with exponential backoff (30 s → 1 h, ±20 %) up to `max_attempts`, then dead-lettered; an error declaring `retryable: false` fails immediately; `retryAfterMs` (Retry-After, provider cooldown) is the minimum delay. User-requested reports and exports run at higher priority than background imagery work.

## Analytics

`src/server/analytics/registry.ts` defines each analytic with id, version, result class, contract, and limitations. Result classes are never conflated:

| Class | Example |
| --- | --- |
| `deterministic_calculation` | NDVI, NDWI, NDMI, anomaly z-score, within-field low-vigour zones |
| `model_prediction` | Sentinel-1 water threshold classifier; WorldCover / IO LULC classes |
| `candidate_change` | NDVI change and water change candidates (unverified until reviewed) |
| `rule_evaluation` | Alerts |

Raster processing (`src/server/analytics`) reads Cloud-Optimized GeoTIFF windows over HTTP range requests (geotiff.js), projects the AOI into the asset CRS (proj4), snaps the analysis grid to the source pixel lattice (no resampling of native bands), rasterizes the AOI, masks with provider quality bands, computes indices with each band's published scale/offset, summarizes over valid pixels, labels connected components, vectorizes exactly along pixel edges, and renders PNG previews (nearest-neighbour; masked pixels shown grey).

Evidence grades for candidate changes are derived from listed criteria — magnitude vs. threshold, overlap of valid pixels, grid alignment, time between images, residual masking, size — and the reasons are stored with each detection. No numeric confidence is invented.

**Low-vigour zones** (`ndvi-zones`, `src/server/analytics/zones.ts`): threshold = the area's median NDVI − max(1.5 × robust σ (1.4826·MAD), 0.10); 4-connected zones ≥ 2,000 m², ranked by area × deficit. Not computed when < 70 % of the area is usable, < 100 pixels, or median NDVI < 0.3 (bare soil, before emergence, after harvest). Grades use the deficit, size, the share of the zone's edge on masked pixels (residual cloud shadow) or on the area boundary (mixed pixels), the image's masking, and persistence (the same rule applied to the previous usable image's own NDVI within 45 days). Persistence cannot vouch for boundary zones. A zone is a measurement relative to the rest of the field, not a diagnosis.

Enabling an analytic on an existing area re-queues its already-processed images (≤ 180 days, ≤ 200 items); processing computes only the method versions an image lacks.

### Validated against real data

`scripts/oryn/validate-field.ts` runs the real pipeline on a development database for the University of Nebraska–Lincoln Mead site US-Ne1 (irrigated maize centre pivot, AmeriFlux). Results on 2026-10-16 (Sentinel-2 L2A, 180 days, 97 images on two UTM tiles):

* The NDVI/NDMI series follow the maize season: bare soil (NDVI ≈ 0.17, NDMI ≈ −0.2) → full canopy (≈ 0.88 / +0.44) → harvest (≈ 0.33 / −0.23); 8 cloudy images were rejected with their reasons.
* An independent reproduction with GDAL/numpy (a separate code path: `gdal.Warp` onto ORYN's recorded grid, SCL mask, GDAL rasterization of the AOI) of 9 NDVI and NDMI rasters on both tiles, including one 13 %-cloud-masked image, matched ORYN exactly: identical AOI and validity masks, per-pixel difference ≤ 3 × 10⁻⁸ (float32 rounding), identical mean/median/p10/p90.
* Zones appeared only in canopy months, never on bare-soil, harvested, or under-70 %-usable images. About half sat on the AOI boundary; this led to the boundary-edge measure and grade cap.
* A field report generated from these results cites each finding's evidence rows (images, observations, zones).

What this does **not** validate: agronomic meaning of individual zones (no ground truth was available), other sensors' scaling beyond the recorded Landsat metadata, and areas spanning tiles (each tile yields its own observation; there is no mosaicking).

## Timestamps

Distinct clocks are stored and shown separately: **acquired** (sensor time, `source_assets.acquired_at` / `observations.observed_at`), **available to ORYN** (`first_seen_at`), **processed** (`processed_at`), **real-world event** (when known, e.g. warning onset), **alert raised**, and **notified**. The UI shows data age ("current / recent / aging / stale") from the acquisition time, not from when ORYN checked.

## Provenance

Every result can be traced: detection → baseline and comparison observations → processing runs (model id/version, parameters, software version) → source assets (provider, collection, item id, STAC URL, licence, attribution). Reports freeze a snapshot of the evidence they cite.

## Map engines

ORYN has two views over one data model, one permission system, and one set of APIs:

* **2D map workspace** (`src/components/map/`, MapLibre GL) — the analytical map: field drawing and editing (terra-draw), satellite rasters placed by their four real UTM corners, change maps, review, notes. Optional globe projection for a quick overview.
* **3D intelligence globe** (`src/components/intel/`, CesiumJS engine, `/app/[org]/intel`) — global context: imaging satellites moving on computed orbits with their swaths, public events in time, cameras with live video, ORYN areas and findings, a timeline, and search. One click switches between the views at the same place (`?at=`).

**Why both (decision 2026-10-17).** Option A (MapLibre only) cannot animate tracks against a time-dynamic clock, light the globe for the shown time, or render orbits in 3D. Option B (CesiumJS for 3D, MapLibre kept for fields) delivers a genuine 3D experience without breaking field editing or exact raster placement, which Cesium cannot do as-is (terra-draw has no Cesium adapter; Cesium imagery layers are north-up rectangles). Cesium is loaded only on the globe page (~1.2 MB gzipped, lazy). It uses `@cesium/engine` alone — no Widgets/knockout, no Cesium ion, no keys: base imagery is NASA GIBS Blue Marble and terrain is the ellipsoid.

**Boundaries.** `globe-scene.ts` is the only file that touches Cesium; the React workspace drives it through a small API (set layers, select, fly, clock). Every record comes from `/api/v1/orgs/[org]/…` routes that check membership and area access. Review, notes, alerts and reports stay in their existing workflows: globe cards link to them (findings → map workspace; events → “Add note” on an area). Nothing on the globe creates alerts.

**Honesty rules** (enforced in code and tests): computed satellite positions are labelled as model output with their elements' epoch; overpasses are “geometric”, never “will image”; wildfire perimeters (a current snapshot) are hidden when the timeline looks back; earthquakes are filtered by event time; camera stills carry their capture time (HTTP `Last-Modified`) and are never called live; live video is played straight from the operator and its stream is health-checked server-side; no computer vision runs (`analytics.status = "not_enabled"`).

**CSP.** The globe page alone adds `'wasm-unsafe-eval'` (WebAssembly compilation only — Cesium's bundled meshoptimizer decoder), plus image/connect hosts for GIBS and camera media hosts, and `media-src blob:` for hls.js. No `'unsafe-eval'`.

### Intelligence sources

| Layer | Source | Kind | Route | Gate |
| --- | --- | --- | --- | --- |
| Imaging satellites | CelesTrak GP elements → SGP4 (server) | model output | `intel/satellites`, `intel/satellites/passes` | `celestrak` |
| Traffic cameras | Caltrans CWWP2 (12 districts) | camera | `intel/cameras`, `intel/cameras/[id]/health` | `caltrans-cctv` |
| Earthquakes, wildfire perimeters | USGS, NIFC (see below) | measurement / official report | `public-events/[layer]` | `usgs-earthquakes`, `nifc-wildfire-perimeters` |
| Base / daily imagery | NASA GIBS (browser-direct tiles) | imagery | — | — |

**Cameras and video, architecture for what comes next.** `src/lib/intel/cameras.ts` defines the registry contract (location, still, video, provider terms, media hosts) and `CameraAnalyticsStatus`. A future detector would run server-side on frames the operator permits processing of, write results with model/version/confidence like any other ORYN analytic, and flip `analytics.status`; until then the UI says no computer vision runs.

### Public event layers

`src/lib/public-events.ts` (descriptors, types, feed states) · `src/server/public-events/` (normalization, cache) · `GET /api/v1/orgs/[org]/public-events/[layer]?bbox=&days=`.

* Keyless public feeds: USGS earthquakes (M2.5+, past 30 days, worldwide) and NIFC WFIGS current wildfire perimeters (US).
* Fixed upstream URLs; callers pick a layer id, never a URL. Members only (no open proxy). Rate-limited per user.
* One snapshot per layer per web process, refreshed at most once per cache period (5 min / 15 min) with a single shared in-flight request; a failed or malformed refresh keeps the last good snapshot and marks it **stale**; with nothing to show the feed is **unavailable** (never an empty "current" layer). A missing timestamp stays unknown.
* They are context, not findings: drawn in neutral ink (rings, hatching) so ORYN's own findings keep the categorical colours, never written to alerts automatically. A user can record one on a nearby area as a note, labelled as a public record.
* Gated integrations (`usgs-earthquakes`, `nifc-wildfire-perimeters`): off in production until verified in that deployment.

### Saved scenes

`saved_scenes` (migration 0008) · `src/lib/scenes.ts` (schema, presets) · `src/server/scenes/service.ts` · `/api/v1/orgs/[org]/scenes`.

A scene stores view state only: camera, projection, basemap and overlays, public event layers, selected area, the displayed image (kind + exact acquisition instant), chart index and change filters. It never stores data or grants access: on restore every record is fetched again through the normal APIs; the server removes an area the viewer cannot see before returning a scene, and a saved image is restored only from that area's own observation list (or reported as no longer available). Private scenes are hidden by a restrictive RLS policy. Sharing with the organization needs `notes.write`; deleting needs authorship or `org.manage`. Presets only switch existing functionality (no fabricated places or datasets).
