# ORYN agriculture intelligence: methods, sources, validation

Date 2026-10-18. Branch `feat/oryn-pilot-hardening` (local only). This file
records what the agriculture subsystem computes, from what, under which
terms, and how it was checked.

Software tests show a formula is implemented as published. They do not show
that a number is right for a farmer's field, and nothing here is a field
validation.

## What works end to end

| Capability | Where | Status |
| --- | --- | --- |
| Imagery discovery and processing (Sentinel-2 L2A via Earth Search, Landsat C2 L2 via Planetary Computer), SCL / QA_PIXEL cloud masking, per-band scale and offset, implausible-scaling refusal, unusable images kept with their reason | `web/src/server/pipeline/process.ts`, `web/src/server/analytics/analyze.ts` | Existing, verified earlier |
| Indices NDVI, **EVI**, **SAVI**, NDMI, NDWI, one typed engine with rejected-pixel counts | `web/src/server/analytics/indices.ts` | EVI and SAVI new (`a61da118`) |
| Within-field low-vigour zones, NDVI anomaly against the field's own baseline, change candidates, season comparison with change evidence report | `web/src/server/analytics/zones.ts`, `pipeline/anomaly.ts`, `pipeline/change.ts`, `server/comparisons/` | Existing |
| **Crop water balance** (FAO-56 single Kc), field agronomy inputs, irrigation log | `web/src/lib/fao56.ts`, `web/src/server/agronomy/`, migration `0010` | New (`16714b92`) |
| Field report with EVI, SAVI and water-balance sections, PDF | `web/src/server/reports/` | Extended (`16714b92`) |
| Map inspector: index chart (NDVI, EVI, SAVI, NDMI, one sensor at a time), water-balance panel, field-details form, irrigation log | `web/src/components/map/` | New |

## Methods (each result stores its id and version)

| Method | Definition | Reference | Result class |
| --- | --- | --- | --- |
| `ndvi@1.0.0` | (NIR − Red) / (NIR + Red) | Rouse et al. 1974; Tucker 1979 | deterministic calculation |
| `evi@1.0.0` | 2.5 (NIR − Red) / (NIR + 6 Red − 7.5 Blue + 1); values outside −1 to 1 and denominators ≤ 0 rejected and counted | Huete et al. 2002 (RSE 83:195–213); coefficients and valid range as in the USGS Landsat Level-2 EVI product | deterministic calculation |
| `savi@1.0.0` | 1.5 (NIR − Red) / (NIR + Red + 0.5) | Huete 1988 (RSE 25:295–309); L = 0.5 as in the USGS Landsat Level-2 SAVI product | deterministic calculation |
| `ndmi@1.0.0`, `ndwi@1.0.0` | normalized differences (NIR/SWIR1; Green/NIR) | Gao 1996; McFeeters 1996 | deterministic calculation |
| `fao56-single-kc-water-balance@1.0.0` | Kc curve (Eq. 66; Tables 11, 12), ETc,adj = Ks·Kc·ETo (Eq. 81), TAW and RAW (Eq. 82, 83), Ks (Eq. 84), daily depletion (Eq. 85–88), p + 0.04(5 − ETc) | FAO Irrigation and Drainage Paper 56 (Allen et al. 1998) | planning estimate, computed on request from stored inputs; not stored as an observation |
| Hargreaves ETo | 0.0023 (Tmean + 17.8)(Tmax − Tmin)^0.5 · 0.408 Ra (Eq. 52); Ra from Eq. 21–25 | FAO-56 chapter 3 | used only when no Penman-Monteith ETo is permitted |

How the FAO-56 values were checked (2026-10-18):

- **What was verified:** Tables 11, 12, 19 and 22 and equations 21–25, 52 and
  82–88, against FAO's online edition (`fao.org/4/x0490e`, chapters 3, 6
  and 8).
- **Image-only cells:** where FAO's pages show a table as an image (the Kc_ini
  column, Table 19), the values were checked against two independent
  extractions of the same tables:
  - the CRAN package FAO56 (GPL; consulted, not copied into ORYN);
  - CropWaterBalance (MIT).

  Both agree with every value FAO's text shows.
- **Crops covered:** maize (grain), soybeans, cotton, groundnut, spring
  wheat, potato and sugar beet. Other crops are rejected rather than
  approximated.

The simplifications, each reported with every estimate:

- rain below 0.2 ETo is ignored;
- no runoff;
- no capillary rise;
- Kc is not adjusted for local wind or humidity;
- rooting depth is held at its maximum from planting;
- the season starts at field capacity.

## Data sources

| Source | Used for | Terms | Commercial use | Attribution | Enabled |
| --- | --- | --- | --- | --- | --- |
| Copernicus Sentinel-2 L2A via Element84 Earth Search | All indices | Copernicus free, full and open data policy | Permitted | "Contains modified Copernicus Sentinel data [year]" (shown per asset) | Yes |
| Landsat Collection 2 Level-2 via Microsoft Planetary Computer | All indices except NDWI | USGS public domain; Planetary Computer service under preview terms | Data permitted; **service terms open item** (`ORYN_LICENCE_REVIEW.md`) | USGS | Yes |
| NOAA NWS (station observations, forecasts) | Water balance fallback (Hargreaves ETo, station rain), weather context | U.S. public domain | Permitted | NOAA/NWS | Yes. Station history accumulates only as ORYN syncs, so a season is rarely complete. |
| Open-Meteo free API (ERA5-based reanalysis, forecasts) | Water balance ETo (Penman-Monteith) and rain, weather context | Free API: non-commercial only | **Not permitted** without a paid plan | Labelled on every use | **Off** in the licence-clean configuration. On only with `ORYN_ALL_LAYERS=1` or `OPEN_METEO_ALLOW_NONCOMMERCIAL`, and then labelled non-commercial in the panel and the report. |
| FAO-56 coefficients and soil table | Water balance parameters | Published scientific reference values, cited | Treated as citable reference values; **counsel to confirm** | Cited in every result | Yes |
| User-entered agronomy and irrigation | Water balance | The organization's own records | — | Shown as "Field agronomy inputs" and "Irrigation logged by members of this organization" | Yes |

## Validation records (RUN, 2026-10-18)

| Check | Inputs | Expected | Actual |
| --- | --- | --- | --- |
| EVI, SAVI on real Sentinel-2 | Field A (synthetic boundary), `S2C_18STE_20261016_0_L2A`, Earth Search, `boa_offset_applied` | Independent recomputation from the source COGs (B02/B04/B08 via geotiff.js, DN × 0.0001) | All 1,624 valid pixels within 1.5 × 10⁻⁸; mean EVI 0.1817 both ways; no rejected pixels; `reflectance_offset_overridden` flagged |
| EVI, SAVI backfill | Field A, enabling both through the API | Images from the last 180 days | 46 processing jobs succeeded; 39 usable and 7 unusable for each index, the same images as NDVI; the 20 April image falls outside the window by design |
| EVI, SAVI formulas | Hand-worked values | e.g. EVI(0.40, 0.05, 0.03) = 0.875/1.475; SAVI(0.40, 0.05) = 0.525/0.95 | Unit tests pass; Sentinel-2 and Landsat scaling both covered; ignoring the offset is shown to give a different value |
| Extraterrestrial radiation | FAO-56 Example 8 | 32.2 MJ m⁻² d⁻¹ (20° S, 3 September) | 32.2 |
| Water balance, real weather | Field A, cotton, planted 2026-05-01, sandy loam (validation inputs for a synthetic field), 170 days of Open-Meteo reanalysis | Independent recomputation from the stored records | Depletion 106.3 mm (73.2–131.1 across rooting depth), crop use 608.4 mm, deep percolation 200.8 mm; recomputation identical |
| Water balance, licence-clean | Same field, Open-Meteo not permitted | Explicit outcome | "No estimate: 170 of 170 days since planting lack ETo or rainfall from NWS station observations"; no number shown |
| Field report | Field A, 2026-05-01 to 2026-10-18 | Section present and honest | PDF page 10: "MISSING: No estimate …"; EVI and SAVI findings F4 and F5 |

None of these is a field validation. The water balance has not been compared
with soil-moisture measurements on any field. EVI and SAVI have not been
compared with ground observations of crop condition.

## Deliberately not built, or disabled

- **Crop disease, soil N/P/K, yield and crop-type models.** None was built.
  ORYN has no lawful, commercially usable training data and no ground truth
  for any of them, so a model would be an unvalidated guess. The existing
  registry already supports model predictions (result class
  `model_prediction`, versions, limitations) for when data and validation
  exist. AgroVision Precision was rejected (no licence; no working code).
- **Season-to-date relative vigour against prior seasons** (directive
  priority B). Not built in this session. The season comparison and the
  anomaly score cover parts of it.
- **Water-balance alert rules.** Not built. The estimate is shown on
  request and in reports.

## What a supervised pilot needs

1. **A commercially licensed daily weather source** for ETo and rain: an
   Open-Meteo commercial plan or another provider. Until then the water
   balance works only where NWS station history covers the whole season.
2. **Soil data per field.** USDA NRCS Soil Data Access (SSURGO, public
   domain) can supply surveyed available water storage for U.S. fields.
   It is not integrated yet.
3. **Field validation** against soil-moisture probes on a few fields per
   crop and soil, before any irrigation claim.
4. **Local Kc and stage lengths.** The API accepts stage-length overrides;
   the form does not offer them yet.
5. **Counsel review** of the FAO-56 table use and of the Planetary Computer
   preview terms.
