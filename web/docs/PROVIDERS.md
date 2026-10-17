# Data providers

ORYN reaches every external source through an adapter behind a provider-independent interface (`src/server/providers/types.ts`). The table of record is the registry in `src/server/providers/registry.ts`; this page is generated from it plus operational notes.

**Principles**

* No provider pushes data to ORYN; catalogs are **polled** on each area's schedule (clustered per product, see `docs/ARCHITECTURE.md`).
* A provider that is unconfigured, licence-gated, or failing contributes nothing and says why — on the **Data sources** page (`/app/[org]/sources`), in sync runs, and in processing history. Nothing is simulated.
* Every stored item keeps its provenance: provider, collection, item id, catalog URL, acquisition time, time first seen by ORYN, licence, attribution.
* Weather records keep their kind (`observation`, `forecast`, `model_estimate`); NWS alerts are stored as official warnings; news items are stored as claims grouped into stories, with corroboration counted only across independent domains.

## Verification status (2026-10-15)

Production gates: email, GDELT, NASA HLS reads, and AI summaries stay off in production until verified in that deployment (see [DEPLOYMENT.md → Integrations](DEPLOYMENT.md#integrations-verify-before-enabling)).

| Provider | Verified live | Notes |
| --- | --- | --- |
| Earth Search (Sentinel-2 L2A COGs) | Yes — search, COG range reads, full pipeline | Items flagged `earthsearch:boa_offset_applied` already have the BOA offset applied although `raster:bands` still lists −0.1; the analyzer is told and does not apply it twice. A plausibility check refuses mismatched scaling. |
| Planetary Computer (S1 RTC, Landsat C2 L2, WorldCover, IO LULC) | Yes — anonymous SAS tokens, full pipeline | Sentinel-1 RTC scenes are not on a common grid; water change compares only within one relative orbit and resamples the baseline. |
| NOAA / NWS | Yes — alerts, forecasts, station observations | Daily precipitation totals are produced only when every hour of the local day has a report; missing values are never treated as zero. |
| Open-Meteo | Yes (non-commercial endpoint, development) | **Free API is non-commercial only.** In production set `OPEN_METEO_API_KEY` (commercial plan) or it stays disabled. History is ERA5-based reanalysis → stored as `model_estimate`. |
| GDELT DOC 2.0 | **No** | Every request from the development network on 2026-10-15 returned `429` (including a single request after 6 s idle), and no article was ever stored. Requests are now spaced across processes, a 429 starts a shared 10-minute cooldown, and the job retries after it. **Off in production** until `oryn:verify -- gdelt` succeeds from the deployment's egress address. `publishedAt` is GDELT's first-seen time. |
| Census TIGERweb | Yes — Tarboro boundary (GEOID 3766700) imported | Public domain. |
| Census Geocoder | Yes | U.S. addresses only. |
| Overpass (OpenStreetMap) | Yes (public instance intermittently overloaded) | ODbL: share-alike applies to derived databases; attribution required. Imports stop at 5,000 features and record `truncated: true` (the Tarboro import hit the cap); use a dedicated instance for production volume. |
| USGS The National Map tiles, OpenFreeMap, FEMA NFHL | Yes | FEMA NFHL draws only at zoom ≥ 15 and is regulatory mapping, not observed flooding. |
| Copernicus Data Space | Catalog search only | Downloads need an OAuth client; the products are not COGs and are not used by ORYN analytics yet. |
| NASA CMR (HLS) | Catalog search only without a token | Reads need `EARTHDATA_TOKEN`; not exercised live. **Off in production** until `oryn:verify -- nasa-hls` succeeds. No analytics consume HLS yet. |

## Providers

### Earth Search (Element 84) (`earth-search`)

- **Operator:** Element 84 (catalog); data hosted by AWS Open Data; Sentinel-2 by ESA / Copernicus — https://element84.com/earth-search/
- **Kind:** imagery; **update cadence:** Continuous as ESA publishes Level-2A products (a 2026-10-08 scene was catalogued about 8 hours after acquisition).; **delivery:** polled
- **Products:** `earth-search:sentinel-2-l2a` (feeds: ndvi, ndwi)
- **Credentials:** optional: EARTH_SEARCH_STAC_URL
- **Licence:** Copernicus Sentinel data are provided free, full and open under the Copernicus Sentinel data terms: use, reproduction, modification and redistribution, including commercial, are permitted with attribution. (https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice)
- **Redistribution:** Imagery and derived products may be redistributed with the attribution “Contains modified Copernicus Sentinel data [year]”. **Commercial use:** allowed.
- **Rate limits:** See provider terms; ORYN retries 429/5xx with backoff.

### Microsoft Planetary Computer (`planetary-computer`)

- **Operator:** Microsoft — https://planetarycomputer.microsoft.com/
- **Kind:** imagery; **update cadence:** Per collection: Sentinel-1/2 and Landsat continuously as published upstream; land-cover products annually.; **delivery:** polled
- **Products:** `planetary-computer:sentinel-1-rtc` (feeds: s1-water); `planetary-computer:landsat-c2-l2` (feeds: ndvi); `planetary-computer:sentinel-2-l2a`; `planetary-computer:esa-worldcover` (feeds: landcover-composition); `planetary-computer:io-lulc-annual-v02` (feeds: landcover-composition)
- **Credentials:** optional: PLANETARY_COMPUTER_SUBSCRIPTION_KEY, PLANETARY_COMPUTER_STAC_URL, PLANETARY_COMPUTER_SAS_URL
- **Licence:** Licence is per collection, from each collection's STAC metadata: Sentinel-1 RTC, ESA WorldCover and Impact Observatory LULC are CC BY 4.0; Landsat Collection 2 is public domain (USGS); Sentinel-2 follows the Copernicus Sentinel data terms. Use of the Planetary Computer service itself: see provider terms. (https://planetarycomputer.microsoft.com/docs/)
- **Redistribution:** Permitted for all listed collections; CC BY 4.0 and Copernicus collections require the attribution recorded on each asset. **Commercial use:** allowed.
- **Rate limits:** See provider documentation; a subscription key (optional) is sent with SAS token requests when configured.

### Copernicus Data Space Ecosystem (`copernicus-dataspace`)

- **Operator:** European Commission / ESA (operated by a consortium led by CloudFerro) — https://dataspace.copernicus.eu/
- **Kind:** imagery; **update cadence:** Continuous as ESA publishes products.; **delivery:** polled
- **Products:** `copernicus-dataspace:sentinel-2-l2a` — catalog only
- **Credentials:** optional: CDSE_CLIENT_ID, CDSE_CLIENT_SECRET, CDSE_STAC_URL
- **Licence:** Copernicus Sentinel data are free, full and open under the Copernicus Sentinel data terms; use, modification and redistribution, including commercial, are permitted with attribution. Data Space service quotas and terms: see provider terms. (https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice)
- **Redistribution:** Permitted with the attribution “Contains modified Copernicus Sentinel data [year]”. **Commercial use:** allowed.
- **Rate limits:** Quotas apply to downloads; see provider terms.

### NASA CMR-STAC (LP DAAC) (`nasa-cmr`)

- **Operator:** NASA Earthdata (Common Metadata Repository; LP DAAC) — https://www.earthdata.nasa.gov/
- **Kind:** imagery; **update cadence:** Continuous as LP DAAC publishes HLS granules.; **delivery:** polled
- **Products:** `nasa-cmr:hls`
- **Credentials:** required: EARTHDATA_TOKEN, NASA_CMR_STAC_URL
- **Licence:** NASA Earth science data are openly shared without restriction on use (NASA Earth Science Data Use Policy; the HLS collections declare CC0-1.0). Data citation is requested. HLS S30 is derived from Copernicus Sentinel-2. (https://earthdata.nasa.gov/earth-observation-data/data-use-policy)
- **Redistribution:** Permitted; cite the HLS dataset DOI and, for S30, include the Copernicus Sentinel attribution. **Commercial use:** allowed.
- **Rate limits:** See provider terms.

### U.S. National Weather Service API (`nws`)

- **Operator:** NOAA National Weather Service — https://www.weather.gov/
- **Kind:** weather; **update cadence:** Alerts as issued; forecasts several times per day; observations typically hourly or more often.; **delivery:** polled
- **Products:** `nws:alerts` — catalog only; `nws:forecast` — catalog only; `nws:observations` — catalog only
- **Credentials:** optional: NWS_USER_AGENT
- **Licence:** NWS information is in the public domain unless noted otherwise and may be used for any lawful purpose, provided it is not claimed as your own, does not imply NOAA/NWS endorsement, and modified content is not presented as official. (https://www.weather.gov/disclaimer)
- **Redistribution:** Permitted; do not present modified NWS products as official. **Commercial use:** allowed.
- **Rate limits:** Not published; NWS documents a generous limit that clears within about 5 seconds when exceeded.

### Open-Meteo (`open-meteo`)

- **Operator:** Open-Meteo.com — https://open-meteo.com/
- **Kind:** weather; **update cadence:** Forecasts update several times per day; the historical archive is extended daily (see provider docs).; **delivery:** polled
- **Products:** `open-meteo:historical-daily` — catalog only; `open-meteo:forecast-daily` — catalog only
- **Credentials:** optional: OPEN_METEO_API_KEY, OPEN_METEO_ALLOW_NONCOMMERCIAL
- **Licence:** Data are licensed CC BY 4.0 (attribution required). The free API is for non-commercial use only; commercial use requires an API subscription (customer endpoints with an API key). (https://open-meteo.com/en/licence)
- **Redistribution:** Permitted under CC BY 4.0: credit Open-Meteo with a link to https://open-meteo.com/ (“Weather data by Open-Meteo.com”) and indicate changes. **Commercial use:** requires license.
- **Rate limits:** Free API (non-commercial): fewer than 10,000 calls/day, 5,000/hour, 600/minute per the terms of use; subscriptions per plan.

### GDELT DOC 2.0 API (`gdelt`)

- **Operator:** The GDELT Project — https://www.gdeltproject.org/
- **Kind:** news; **update cadence:** Every 15 minutes.; **delivery:** polled
- **Products:** `gdelt:doc-artlist` — catalog only
- **Credentials:** optional: GDELT_ENABLED
- **Licence:** GDELT datasets are available for unlimited and unrestricted use, including commercial, without fee; any use or redistribution must cite the GDELT Project and link to https://www.gdeltproject.org/. Linked articles remain the copyright of their publishers — ORYN stores only titles, URLs, and outlet metadata. (https://www.gdeltproject.org/about.html)
- **Redistribution:** GDELT metadata may be redistributed with a citation and link to the GDELT Project; article text is not redistributed. **Commercial use:** allowed.
- **Rate limits:** One request every 5 seconds (enforced at ≥ 5.5 s process-wide).

### Census TIGERweb (`tigerweb`)

- **Operator:** U.S. Census Bureau — https://tigerweb.geo.census.gov/
- **Kind:** reference; **update cadence:** Annual vintages; the layer's stated vintage is recorded with every boundary.; **delivery:** polled
- **Products:** `tigerweb:incorporated-places` — catalog only; `tigerweb:census-designated-places` — catalog only; `tigerweb:counties` — catalog only
- **Credentials:** none
- **Licence:** U.S. Census Bureau TIGER data are public domain (works of the U.S. Government). (https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html)
- **Redistribution:** Unrestricted. **Commercial use:** allowed.

### OpenStreetMap (Overpass API) (`overpass`)

- **Operator:** OpenStreetMap contributors (data); public Overpass API instance at overpass-api.de (query service) — https://www.openstreetmap.org/
- **Kind:** reference; **update cadence:** Minutely replication from OpenStreetMap.; **delivery:** polled
- **Products:** `overpass:osm-features` — catalog only
- **Credentials:** optional: OVERPASS_URL
- **Licence:** OpenStreetMap data are licensed under the Open Database License (ODbL) 1.0: free to use, including commercially, with attribution; databases derived from OSM and publicly used must be made available under the ODbL (share-alike). Produced works such as maps and reports need attribution only. (https://www.openstreetmap.org/copyright)
- **Redistribution:** Attribution “© OpenStreetMap contributors” required; derived databases are share-alike under the ODbL. **Commercial use:** allowed.
- **Rate limits:** Public instance: limited concurrent slots per IP; heavy users should run their own instance (see provider terms).

### Census Geocoder (`census-geocoder`)

- **Operator:** U.S. Census Bureau — https://geocoding.geo.census.gov/geocoder/
- **Kind:** geocoding; **update cadence:** Benchmark address ranges are refreshed periodically by the Census Bureau.; **delivery:** polled
- **Products:** `census-geocoder:onelineaddress` — catalog only
- **Credentials:** none
- **Licence:** Results are works of the U.S. Government (Census Bureau) and not subject to U.S. copyright; API use is subject to the Census Bureau terms of service. (https://www.census.gov/data/developers/about/terms-of-service.html)
- **Redistribution:** Unrestricted. **Commercial use:** allowed.

### USGS The National Map basemaps (`usgs-national-map`)

- **Operator:** U.S. Geological Survey — https://apps.nationalmap.gov/services/
- **Kind:** basemap; **update cadence:** Cached basemaps refreshed periodically (each service states its last refresh).; **delivery:** polled
- **Products:** `usgs-national-map:usgs-imagery` — catalog only; `usgs-national-map:usgs-topo` — catalog only; `usgs-national-map:usgs-shaded-relief` — catalog only; `usgs-national-map:usgs-hydro` — catalog only
- **Credentials:** none
- **Licence:** USGS-authored or produced data are in the U.S. public domain; the imagery service also credits USDA. Some third-party content on USGS sites is not public domain. (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
- **Redistribution:** Permitted; credit “USGS The National Map”. **Commercial use:** allowed.

### FEMA National Flood Hazard Layer (`fema-nfhl`)

- **Operator:** Federal Emergency Management Agency — https://www.fema.gov/flood-maps/national-flood-hazard-layer
- **Kind:** reference; **update cadence:** Updated as FEMA flood map revisions become effective.; **delivery:** polled
- **Products:** `fema-nfhl:fema-nfhl-flood-zones` — catalog only
- **Credentials:** none
- **Licence:** U.S. Government flood hazard data published by FEMA. Regulatory mapping, not observed flooding. Reuse terms: see provider terms. (https://www.fema.gov/flood-maps/national-flood-hazard-layer)
- **Redistribution:** See provider terms; cite FEMA NFHL and the effective date of the map shown. **Commercial use:** allowed.

### OpenFreeMap (`openfreemap`)

- **Operator:** OpenFreeMap (Hyperknot Software Kft.) — https://openfreemap.org/
- **Kind:** basemap; **update cadence:** Planet tiles rebuilt regularly from OpenStreetMap (see provider).; **delivery:** polled
- **Products:** `openfreemap:openfreemap-liberty` — catalog only
- **Credentials:** none
- **Licence:** Free public vector-tile service without SLA (OpenFreeMap terms of service). Map data © OpenStreetMap contributors under the ODbL 1.0; tiles follow the OpenMapTiles schema. Attribution is required. (https://openfreemap.org/tos/)
- **Redistribution:** Display with attribution; bulk downloads are limited by the OpenFreeMap terms. **Commercial use:** allowed.

### Public event layers — USGS earthquakes (`usgs-earthquakes`) and NIFC WFIGS (`nifc-wildfire-perimeters`)

Map context only (`src/server/public-events/`); fetched by the **web** service on demand and cached per process, not polled per area and not stored.

- **USGS ANSS ComCat summary feed** — https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php — `summary/2.5_month.geojson` (M2.5+, past 30 days, worldwide; ~1.4 MB; regenerated every minute). Cached 5 minutes. **Licence:** U.S. public domain; credit "U.S. Geological Survey". Records keep origin time, last update, and review status (automatic / reviewed).
- **NIFC WFIGS Interagency Perimeters — current** — ArcGIS feature service `WFIGS_Interagency_Perimeters_Current` (keyless; paged with `exceededTransferLimit`; simplified to ~100 m). Cached 15 minutes. **Licence:** U.S. Government interagency data (NIFC Open Data, public domain); credit "National Interagency Fire Center (WFIGS)". Records keep the perimeter date (`poly_DateCurrent`) and discovery time.
- **Credentials:** none. **Commercial use:** allowed. **Gated:** off in production until `node dist/verify.mjs <id>` passes and the id is added to the web service's `ORYN_VERIFIED_INTEGRATIONS`.
- Not used (licence or key): NASA FIRMS (needs a MAP_KEY), Esri World Imagery (Esri terms), Cesium ion / Google 3D tiles (keys, non-commercial or metered).

### Intelligence globe — CelesTrak (`celestrak`), Caltrans CCTV (`caltrans-cctv`), NASA GIBS

- **CelesTrak GP elements** — `https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=json` and `?NAME=SENTINEL-1&FORMAT=json` (two small requests). CelesTrak updates every 2 hours and temporarily blocks clients that download more often (HTTP 403); ORYN downloads at most once per 2 hours, waits 30 minutes after a failure, and keeps serving the last good elements marked stale. Used only for the satellites behind ORYN's imagery (Sentinel-2A/2B/2C, Landsat 8/9, Sentinel-1A/1C/1D). Positions and overpasses are computed server-side (satellite.js SGP4); browsers never receive the raw elements. No formal licence is published; attribution “CelesTrak”.
- **Caltrans CWWP2 CCTV** — `https://cwwp2.dot.ca.gov/data/d{N}/cctv/cctvStatusD{NN}.json`, N = 1–12 (~10 MB in total). Refreshed at most every 12 hours on demand. In-service cameras only; media URLs must be on `cwwp2.dot.ca.gov` (stills) or `wzmedia.dot.ca.gov` (HLS). Stills refresh every ~2 minutes and carry their capture time in `Last-Modified`; many cameras stream live H.264 HLS (720p) with CORS open. Some listed streams are offline (playlist 404) — the server-side health check reports that. Caltrans states the files “are available for integration into your application … There is no charge for the use of this data”, and that it neither retains nor archives footage. ORYN never relays or records video (no egress cost, nothing stored).
- **NASA GIBS** — Blue Marble (base) and NOAA-20 VIIRS corrected reflectance (daily, by UTC date) WMTS tiles, loaded by the browser. Keyless; NASA imagery is free to use with credit.
- Not used: Google Photorealistic 3D Tiles / Cesium ion (keys, metered or non-commercial), Esri World Imagery (Esri terms), OpenSky (non-commercial), AISStream (key), NCDOT cameras (developer key), NYC DOT / TfL (agreements), DelDOT and Maryland CHART (no published reuse terms), Iowa DOT (site terms limit use to non-commercial; pending clarification).

## Adding a provider

1. Implement the relevant interface (`ImageryProvider` for catalogs; plain functions returning `WeatherRecord` / `WeatherWarning` / `NewsArticle` / `ReferenceFeature` otherwise) in `src/server/providers/<kind>/`.
2. Describe it (`ProviderDescriptor`: products, licensing, credentials, cadence) and add it to `PROVIDERS` in `registry.ts`, including an `availability()` that explains missing credentials or licence gates.
3. Map items to ORYN's canonical asset keys so the analytics can read them, and record licence/attribution per item.
4. Add fixture-based unit tests with an injected fetch, and an opt-in network smoke test.
