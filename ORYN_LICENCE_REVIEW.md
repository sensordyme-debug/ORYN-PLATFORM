# ORYN licence review

Review date 2026-10-17. Scope: every bundled dataset, basemap, live feed, asset
and upstream service that ORYN (the `web/` application) or the God's Eye View
engine it frames can show to a customer.

**Rule applied.** ORYN is a commercial product. A source is used only when its
provider's own terms permit commercial display, and the conditions
(attribution, limits) can be met. Sources that are non-commercial, unverified,
or ambiguous are withheld or disabled, each with its reason. Every verdict
below rests on the provider's own page, read on the review date. Short quotes
and URLs come from the two review passes; their working copies are in the
session scratchpad, not in the repository.

**This review is not legal advice.** It records what each provider publishes.
Before a paid pilot, counsel should confirm the conditional items marked
**Review** below.

Verdicts:

| Verdict | Meaning |
| --- | --- |
| OK | The provider permits commercial use, or the agency states U.S. public domain. Attribution may be required. |
| Conditions | Permitted with material conditions, listed in the table. |
| Restricted | Non-commercial only, or requires an agreement, licence or paid plan. |
| Unclear | The provider publishes no licence, or its terms say nothing about this use. |
| Unverified | The terms page could not be read. |

## Where it is enforced

| Mechanism | File |
| --- | --- |
| Per-layer engine policy (offered or withheld, nature, licence, attribution) | `src/ui/host/hostLicences.js` |
| Lifecycle guard: no path can enable a withheld layer | `installHostLicenceGuard` |
| Commercial engine build: non-commercial datasets left out; output scanned; MIT and Apache-2.0 notices shipped | `build/noncommercial.js`, `scripts/check-commercial-dist.mjs`, `scripts/oryn-engine.mjs` |
| Engine server switches: adsb.lol-only flights, CCTV pack allowlist, DriveBC ministry cameras only, no Google-derived ground heights | `server/providers/aircraft/opensky.js`, `server/providers/cctv/*` |
| Engine routes ORYN forwards (offered layers only) | `web/src/lib/intel/engine.ts`, `web/src/proxy.ts` |
| ORYN licence gate (off in every environment until cleared) | `web/src/server/integrations.ts`, `ORYN_LICENCE_CLEARED_INTEGRATIONS` |
| ORYN provider defaults (Open-Meteo opt-in; Overpass needs your own instance in production) | `web/src/server/config/env.ts`, `web/src/server/providers/reference/overpass.ts` |

## ORYN platform sources (Map workspace, analytics, reports)

| Source | Verdict | Use in ORYN | Attribution |
| --- | --- | --- | --- |
| Copernicus Sentinel-1/-2 data | OK. Commercial permission is in the Copernicus FAQ: "no restrictions on selling creative products that use Sentinel data". | Analytics (Sentinel-2 via Earth Search) | "Contains modified Copernicus Sentinel data [year]" |
| Element 84 Earth Search STAC | Conditions: no API terms; "best effort", no SLA | Used. **Review:** production reliance on a best-effort API. | — |
| AWS Open Data `sentinel-2-l2a-cogs` | OK | Used (COG reads) | Copernicus notice |
| Planetary Computer service | Conditions: "Preview" terms; "not for mission-critical" use; no SLA; tokens may not be shared or monetized | Used for Landsat, Sentinel-1 RTC and land cover. **Review before a paid pilot.** Signed URLs stay server-side. | Per collection |
| PC Sentinel-1 RTC | Conditions: CC BY 4.0 (Microsoft, Catalyst); the collection says an account is required | Used; anonymous tokens work today | Microsoft, Catalyst + Copernicus notice |
| Landsat Collection 2 (USGS) | OK: "no restrictions on the use of Landsat products" | Used | "Landsat … courtesy of the U.S. Geological Survey" |
| ESA WorldCover | OK: CC BY 4.0 | Used | "© ESA WorldCover project [year] / Contains modified Copernicus Sentinel data ([year]) processed by ESA WorldCover consortium" |
| Impact Observatory LULC | OK: CC BY 4.0 | Used | Impact Observatory, Microsoft, Esri; CC BY 4.0 |
| Copernicus Data Space | Conditions: registration needed for data | Catalog search only | Copernicus notice |
| NASA CMR / HLS | Conditions: CC0; cite; no endorsement | Catalog only (reads need a token, gated) | HLS citation |
| NWS / NOAA | OK: public domain | Used | No endorsement; do not present modified products as official |
| Open-Meteo free API | **Restricted**: "only … for non-commercial purposes" | **Off by default in every environment** (needs `OPEN_METEO_API_KEY`, or explicit `OPEN_METEO_ALLOW_NONCOMMERCIAL=true` for non-commercial evaluation) | "Weather data by Open-Meteo.com" |
| GDELT | OK: unrestricted, including commercial | Gated (never verified working from a deployment) | Cite and link the GDELT Project |
| Census TIGERweb, Geocoder | Conditions: not endorsed; boundaries are not legal land descriptions | Used | "… not endorsed or certified by the Census Bureau" (now in attribution) |
| Overpass public instance | **Restricted** for a production backend | **Production requires `OVERPASS_URL`** (own or paid instance); development may use the public one lightly | OSM ODbL |
| OpenStreetMap data | Conditions: ODbL; produced works need attribution | Basemap and imports | © OpenStreetMap contributors |
| USGS The National Map | OK: "no restrictions" | Basemaps | "Map services and data available from U.S. Geological Survey, National Geospatial Program." |
| OpenFreeMap | Conditions: free, commercial allowed, no SLA | Basemap | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" |
| FEMA NFHL | Conditions: no NFHL-specific licence; "can be used in maps or applications"; not for official determinations without accurate base maps | Display only, labelled regulatory mapping | Cite FEMA and the map's effective date |
| USGS earthquakes | OK: public domain | Used | U.S. Geological Survey |
| NIFC WFIGS perimeters | **Unclear**: no licence or public-domain statement, only a disclaimer; state agencies contribute | **Withheld** (licence gate) | — |
| CelesTrak orbital elements | **Unclear**: no reuse terms; data from Space-Track | **Withheld** (licence gate) | — |
| Caltrans cameras | **Unclear** for images: "photographs … may require additional permissions" | **Withheld** (licence gate) | — |
| Resend (email) | Conditions: free tier usable commercially, limited, can change | Optional, gated | — |
| Anthropic API (AI report summaries) | Paid service, existing optional feature | Opt-in in UI and API; gated in production | — |

## God's Eye View engine inside ORYN

**Offered (verified):**

| Layer | Source | Verdict | Nature shown |
| --- | --- | --- | --- |
| Earthquakes | USGS | OK | Observation |
| FIRMS active fires | NASA FIRMS (free MAP_KEY) | Conditions: cite "NASA FIRMS"; key limits | Observation |
| Cyclone advisories | NOAA NHC | OK (do not present modified as official) | Forecast |
| Rain radar, satellite clouds | NOAA nowCOAST | OK | Observation |
| Lightning density | NOAA nowCOAST derived product | OK (Level 5 derived product only) | Derived product |
| Wind | NOAA GFS; ECMWF Open Data | OK; Conditions (CC BY 4.0 with ECMWF terms) | Forecast |
| Recent imagery | NASA GIBS / CMR (HLS includes Copernicus data) | OK | Observation |
| Air quality | ECCC (Canada) | OK, commercial explicitly permitted | Observation |
| Dams, datacenters | Bundled OSM extracts | Conditions (ODbL) | Reference (dates not recorded) |
| Mapped installations | OSM, OpenFreeMap, Overture | Conditions (ODbL) | Reference |
| Flights, military flights | adsb.lol only | Conditions (ODbL; future feeder key; no SLA) | Observation |
| Road cameras | Fintraffic (CC BY 4.0), Statens vegvesen (NLOD), DriveBC ministry cameras (OGL-BC), Calgary (OGL-Calgary) | OK / Conditions; each licence covers the images | Observation with estimated camera geometry |
| Basemap | NASA GIBS Blue Marble + USDA NAIP via USGS The National Map | OK | — |

**Withheld (with reason, shown in the ORYN panel):**

| Layer or source | Reason |
| --- | --- |
| TeleGeography submarine cables | CC BY-NC-SA (non-commercial); removed from the ORYN build |
| Bhote Koshi event and locator | CC BY-NC 4.0; removed from the ORYN build (imagery, event file, flood path, evidence coordinates) |
| Esri World Imagery (engine default basemap) | Restricted: needs ArcGIS software or a subscription; no commercial use of Living Atlas content without a licence |
| OSM standard tiles | Access "may be withdrawn at any point" for commercial services; not used |
| OpenSky flights and tracks | Restricted: commercial use needs written permission |
| adsbdb enrichment | Route data "may not be copied, published, or incorporated into other databases" without permission |
| Google 3D tiles, Street View, Places; TomTom; Mapillary | Paid or keyed services; not configured |
| Cesium ion (terrain, imagery, geocoding) | Restricted: the ion terms (revised 2025-08) grant a personal licence that does not permit including ion in a commercially available solution; the free plan is non-commercial. `CESIUM_ION_TOKEN` is cleared by `scripts/oryn-engine.mjs`, and the viewer is created with `baseLayer: false` and `geocoder: false`, so no ion or Bing request is made. The CesiumJS library itself is Apache-2.0 (see `ORYN_UPSTREAM_ASSESSMENT.md`). |
| Re:Earth Terrain / Mapterhorn | Unclear: no terms for the hosting service and no licence for output tiles. The ORYN globe uses the smooth ellipsoid. |
| Bundled CCTV ground heights | Sampled from Google Photorealistic 3D Tiles; Google's terms forbid storing derived content. Not served. |
| Fire perimeters (NIFC), satellites (CelesTrak), launches (orbits from CelesTrak) | Unclear terms |
| Street level (KartaView, Panoramax) | No API terms for this use; share-alike images |
| Street traffic | Simulated vehicles |
| AIS vessels | No terms of service (beta) |
| ALPR cameras | Community tile host, terms unpublished |
| Bikeshare, transit | Several feeds unlicensed or revocable; not verified feed by feed |
| Directions (FOSSGIS) | Commercial terms behind a bot wall; heavy use prohibited |
| Radio | Broadcaster stream terms unverified |
| GNSS integrity | Unvalidated classifier |
| Camera packs: TfL, Catalonia, Toronto, Ontario 511, NSW, U.S. state and city packs | TfL unverified; Catalonia's licence excludes individual images; Toronto's metadata contradicts itself; Ontario needs a key; NSW images not expressly covered; U.S. packs publish no image licence |
| Photon and Nominatim place search | Best-effort services without commercial terms; engine search stays offline |
| Google News RSS, Open-Meteo (engine regional brief, weather effects) | Restricted; routes not forwarded |

## Code and fonts

- **Dependencies.** All direct dependencies of `web/` and the engine use
  permissive licences, with no GPL/AGPL/SSPL/BUSL (earlier audit).
- **Engine code and Cesium.** The engine's MIT notice and Cesium's
  Apache-2.0 licence ship in the engine build (`LICENSE.txt`,
  `licenses/cesium-LICENSE.md`).
- **Fonts.** These load from Google Fonts: Inter, JetBrains Mono, Geist and
  Geist Mono are OFL 1.1, and Material Symbols is Apache 2.0.
- **Engine 3D models.** All are CC BY 4.0, recorded in
  `public/models/README.md`. Four credits there no longer match Sketchfab's
  current names, and the Bell 206 page now returns 404. The licence was
  granted at download, but the credits should be checked against the original
  uploads.

## Open items

- **Planetary Computer.** Preview terms (no SLA, not for mission-critical
  use). Confirm with counsel, or move Landsat and land cover to a source with
  production terms (Landsat is public domain on AWS Open Data; WorldCover is on
  AWS as well).
- **Earth Search.** No SLA. A paid private catalog or self-hosted STAC is the
  production alternative.
- **NIFC, CelesTrak, Caltrans.** Ask each provider for written reuse terms.
  If granted, add the id to `ORYN_LICENCE_CLEARED_INTEGRATIONS`, and for the
  engine move the layer to "offered" in `hostLicences.js`.
- **Copernicus notice year.** The notice includes the data year; the
  per-asset attribution already does.
- **Standalone engine.** These are repository findings that ORYN does not
  depend on:
  - `DATA_SOURCES.md` calls Esri World Imagery usable in public apps with
    attribution, but Esri's terms say otherwise.
  - The CCTV ground-height sidecar (`src/data/local_data/cctv_ground_heights/`)
    is derived from Google 3D Tiles.
  - The engine requests CelesTrak in TLE format, which no longer covers
    objects with six-digit catalog numbers.
  - NASA ends Suomi NPP deliveries on 2 November 2026.
