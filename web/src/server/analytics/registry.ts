/**
 * Analytic model registry.
 *
 * Every analytic has an id, a semantic version, an input contract, an output
 * schema, a result class, and documented limitations. Stored results carry
 * (model_id, model_version) so any number shown in the product can be traced
 * to the exact method that produced it. Changing a method's behaviour
 * requires a new version; results from older versions are preserved.
 *
 * Result classes (never conflated):
 *   raw_observation           a value reported by a source as-is
 *   deterministic_calculation a formula applied to source values (e.g. NDVI)
 *   model_prediction          the output of a classifier or statistical model
 *   candidate_change          a change flagged by comparing observations —
 *                             requires human verification
 *   rule_evaluation           a configured rule evaluated against results
 */
import type { Tx } from "@/server/db/client";
import { jsonb } from "@/server/db/client";

export type ResultClass =
  | "raw_observation"
  | "deterministic_calculation"
  | "model_prediction"
  | "candidate_change"
  | "rule_evaluation";

export type AnalyticDefinition = {
  id: string;
  version: string;
  name: string;
  resultClass: ResultClass;
  description: string;
  inputContract: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  limitations: string[];
};

const S2_MASK_NOTE =
  "Sentinel-2 pixels are masked using the L2A Scene Classification Layer (SCL): only vegetation, not-vegetated, and water classes (4, 5, 6) are kept; no data, saturated/defective, dark area/topographic shadow, cloud shadow, unclassified, medium/high-probability cloud, thin cirrus, and snow/ice are excluded.";
const LANDSAT_MASK_NOTE =
  "Landsat pixels are masked using QA_PIXEL bits: fill, dilated cloud, cirrus, cloud, cloud shadow, and snow are excluded.";

export const ANALYTICS = {
  ndvi: {
    id: "ndvi",
    version: "1.0.0",
    name: "Normalized Difference Vegetation Index",
    resultClass: "deterministic_calculation",
    description:
      "NDVI = (NIR − Red) / (NIR + Red), computed per pixel from surface reflectance (Sentinel-2 L2A B08/B04 at 10 m, or Landsat Collection 2 Level-2 SR_B5/SR_B4 at 30 m) after applying each band's published scale and offset. Summarized over the AOI's valid pixels.",
    inputContract: {
      products: ["earth-search:sentinel-2-l2a", "planetary-computer:landsat-c2-l2"],
      bands: { sentinel2: ["red", "nir", "scl"], landsat: ["red", "nir08", "qa_pixel"] },
      reflectance: "surface reflectance (Level-2A / Level-2)",
    },
    outputSchema: {
      metrics: ["mean", "median", "p10", "p90", "std", "min", "max", "valid_pixels", "total_pixels", "valid_fraction", "masked_fraction", "histogram"],
      raster: "PNG visualization + Float32 grid in the source CRS",
    },
    limitations: [
      "Requires multispectral surface reflectance; never computed from RGB imagery.",
      S2_MASK_NOTE,
      LANDSAT_MASK_NOTE,
      "NDVI saturates over dense canopy and is affected by soil background in sparse cover.",
      "Thin cloud or haze not flagged by the provider mask can depress NDVI.",
      "Values are not comparable across sensors without cross-calibration; series are compared within one sensor family.",
    ],
  },
  ndmi: {
    id: "ndmi",
    version: "1.0.0",
    name: "Normalized Difference Moisture Index",
    resultClass: "deterministic_calculation",
    description:
      "NDMI = (NIR − SWIR1) / (NIR + SWIR1) (Gao 1996), computed per pixel from surface reflectance after each band's published scale and offset: Sentinel-2 L2A B8A/B11 on their native 20 m grid, or Landsat Collection 2 Level-2 SR_B5/SR_B6 at 30 m. Summarized over the AOI's valid pixels. Responds to vegetation canopy water content.",
    inputContract: {
      products: ["earth-search:sentinel-2-l2a", "planetary-computer:landsat-c2-l2"],
      bands: { sentinel2: ["nir08 (B8A)", "swir16 (B11)", "scl"], landsat: ["nir08", "swir16", "qa_pixel"] },
      reflectance: "surface reflectance (Level-2A / Level-2)",
    },
    outputSchema: {
      metrics: ["mean", "median", "p10", "p90", "std", "min", "max", "valid_pixels", "total_pixels", "valid_fraction", "masked_fraction", "histogram"],
      raster: "PNG visualization + Float32 grid in the source CRS (20 m Sentinel-2, 30 m Landsat)",
    },
    limitations: [
      "NDMI responds to the water content and density of the vegetation canopy. It is not a measurement of soil moisture or root-zone water, and it cannot by itself establish irrigation need or failure.",
      "Values depend strongly on crop type, growth stage, canopy cover, and soil background: compare an area with itself over time and with similar fields, not with a universal threshold.",
      "Computed on a 20 m (Sentinel-2) or 30 m (Landsat) grid, coarser than 10 m NDVI; narrow features and field edges are blended with neighbouring land.",
      S2_MASK_NOTE,
      LANDSAT_MASK_NOTE,
      "Values are not comparable across sensors without cross-calibration; series are compared within one sensor family.",
    ],
  },
  ndwi: {
    id: "ndwi",
    version: "1.0.0",
    name: "Normalized Difference Water Index (McFeeters)",
    resultClass: "deterministic_calculation",
    description:
      "NDWI = (Green − NIR) / (Green + NIR) from Sentinel-2 L2A B03/B08. Pixels with NDWI > 0 are counted as open-water candidates to estimate surface-water area within the AOI.",
    inputContract: { products: ["earth-search:sentinel-2-l2a"], bands: ["green", "nir", "scl"] },
    outputSchema: { metrics: ["mean", "water_fraction", "water_area_m2", "valid_fraction", "threshold"] },
    limitations: [
      S2_MASK_NOTE,
      "Open-water candidates only: flooded vegetation, water under canopy, and turbid shallow water are frequently missed.",
      "Dark surfaces (asphalt, shadow) can be misclassified as water.",
      "The fixed threshold (0.0) is a common convention, not calibrated for this AOI.",
    ],
  },
  "s1-water": {
    id: "s1-water",
    version: "1.0.0",
    name: "Sentinel-1 radar open-water candidate",
    resultClass: "model_prediction",
    description:
      "Classifies pixels as open-water candidates where Sentinel-1 radiometrically terrain-corrected VV backscatter is below −18 dB (smooth water reflects radar away from the sensor). Works through cloud cover.",
    inputContract: { products: ["planetary-computer:sentinel-1-rtc"], bands: ["vv"], units: "linear gamma0 converted to dB" },
    outputSchema: { metrics: ["water_fraction", "water_area_m2", "mean_vv_db", "valid_fraction", "threshold_db"] },
    limitations: [
      "A fixed backscatter threshold; wind-roughened water appears bright and is missed.",
      "Smooth dry surfaces (tarmac, sand) and radar shadow can appear as false water.",
      "Flooded vegetation and flooded urban areas often brighten radar returns and are not detected by this rule.",
      "10 m pixel spacing; speckle is not filtered.",
    ],
  },
  "landcover-composition": {
    id: "landcover-composition",
    version: "1.0.0",
    name: "Land-cover composition",
    resultClass: "model_prediction",
    description:
      "Class composition of the AOI from published land-cover products (ESA WorldCover 10 m; Impact Observatory annual 10 m LULC). The classes are the provider's model predictions; ORYN only aggregates them.",
    inputContract: { products: ["planetary-computer:esa-worldcover", "planetary-computer:io-lulc-annual-v02"], bands: ["map"] },
    outputSchema: { metrics: ["classes: [{code, label, pixels, fraction, area_m2}]", "valid_fraction"] },
    limitations: [
      "Inherits the provider's classification accuracy — see each product's published validation report (ESA reports 76.7% global overall accuracy for WorldCover 2021 v200). Local accuracy for this AOI is unknown.",
      "Annual products describe the year as a whole, not a specific date.",
      "Small or linear features (narrow roads, single buildings) are below the 10 m resolution.",
    ],
  },
  "ndvi-change": {
    id: "ndvi-change",
    version: "1.0.0",
    name: "Vegetation change candidates",
    resultClass: "candidate_change",
    description:
      "Compares two NDVI observations of the same AOI from the same sensor family. Pixels valid in both whose NDVI changed by at least the threshold (default 0.20) are grouped into 4-connected regions; regions at or above the minimum area become candidate changes.",
    inputContract: { inputs: "two current NDVI observations, same sensor family, overlapping valid pixels", parameters: ["threshold", "min_area_m2"] },
    outputSchema: { detections: ["geometry", "area_m2", "mean_delta", "direction", "pixel_count", "valid_overlap_fraction"] },
    limitations: [
      "A candidate is not a confirmed real-world change; it requires review.",
      "Seasonal growth, harvest, irrigation timing, phenology, and illumination differences produce genuine NDVI change that may not be of interest.",
      "Residual cloud, haze, or shadow missed by the mask can create false candidates.",
      "Different relative orbits or acquisition geometry can shift pixel values; registration error between dates is typically under one pixel for same-tile Sentinel-2 products but is not zero.",
    ],
  },
  "water-change": {
    id: "water-change",
    version: "1.1.0",
    name: "Surface-water change candidates",
    resultClass: "candidate_change",
    description:
      "Compares water-candidate masks from two observations of the same product (Sentinel-2 NDWI or Sentinel-1 VV threshold) and groups newly wet pixels into candidate inundation regions. Sentinel-1 images are compared only with an earlier image from the same relative orbit (same viewing geometry). 1.1.0: added the same-orbit requirement; 1.0.0 compared across orbits.",
    inputContract: { inputs: "two current water observations from the same product", parameters: ["min_area_m2"] },
    outputSchema: { detections: ["geometry", "area_m2", "pixel_count"] },
    limitations: [
      "Inherits the limitations of the underlying water classification.",
      "Rivers and reservoirs fluctuate normally; compare against the season, not only the previous image.",
      "Not a flood forecast and not current conditions unless the comparison image is recent — check its acquisition time.",
      "Sentinel-1 RTC scenes are not snapped to a common pixel grid; the baseline is resampled (nearest neighbour), so edges may shift by up to one pixel.",
    ],
  },
  "ndvi-anomaly": {
    id: "ndvi-anomaly",
    version: "1.1.0",
    name: "Vegetation anomaly vs. own baseline",
    resultClass: "deterministic_calculation",
    description:
      "Standard score of the latest AOI mean NDVI against the AOI's own prior valid observations from the same sensor family within ±30 days of the same time of year in earlier years (circular, so late December and early January are the same season), or, if fewer than 3 such dates exist, the previous 90 days. Observations from the same acquisition date (neighbouring tiles of one pass) count as one baseline sample, and the observation's own pass is never part of its baseline.",
    inputContract: { inputs: "AOI NDVI observation history" },
    outputSchema: { metrics: ["z_score", "baseline_mean", "baseline_std", "baseline_n", "baseline_window"] },
    limitations: [
      "Needs at least 3 baseline observations; otherwise reported as insufficient baseline.",
      "Crop rotation or management change makes prior seasons a poor baseline.",
    ],
  },
  "ndvi-zones": {
    id: "ndvi-zones",
    version: "1.0.0",
    name: "Within-field low-vigour zones",
    resultClass: "deterministic_calculation",
    description:
      "Localized areas whose NDVI is low relative to the rest of the same area of interest on the same date. Threshold: the area's median NDVI minus the larger of 1.5 robust standard deviations (1.4826 × median absolute deviation) and 0.10; low pixels are grouped into 4-connected zones, zones under 2,000 m² are dropped, and zones are ranked by area × NDVI deficit. Each zone is checked against the previous usable image of the same sensor within 45 days (the same rule applied to that image) to report whether it persists.",
    inputContract: { inputs: "One valid NDVI observation (stored Float32 grid and AOI mask); optionally the previous valid NDVI observation for persistence." },
    outputSchema: {
      detections: "type low_vigor_zone",
      metrics: ["area_m2", "pixel_count", "mean_ndvi", "min_ndvi", "field_median", "deficit", "relative_deficit", "threshold", "score", "rank", "edge_masked_fraction", "persistence"],
    },
    limitations: [
      "A low-vigour zone is NDVI that is low relative to the rest of the same area on the same date. It is not a diagnosis: possible causes include planting gaps or later emergence, a different crop or variety, bare soil or tracks, waterlogging, drought stress, nutrient deficiency, pest or disease, hail or lodging, and residual cloud shadow. Each zone needs a field check before any action.",
      "Not computed when less than 70% of the area is usable in the image, when fewer than 100 pixels are usable, or when the area's median NDVI is below 0.3 (bare soil, before emergence, or after harvest), because relative differences are not meaningful then.",
      "An area that mixes different crops, fields, or non-crop land will show the lowest-NDVI land use as zones; draw one field per area for field-level results.",
      "Pixels are 10 m (Sentinel-2) or 30 m (Landsat); zones smaller than 0.2 ha are not reported and field edges mix with neighbouring land.",
      "Persistence across images raises confidence that a pattern is real, but does not establish its cause.",
    ],
  },
  "alert-rule": {
    id: "alert-rule",
    version: "1.0.0",
    name: "Configured alert rule",
    resultClass: "rule_evaluation",
    description: "Evaluation of an organization-configured alert rule against stored observations, detections, weather records, and warnings.",
    inputContract: {},
    outputSchema: {},
    limitations: ["An alert reflects only the data available to ORYN at evaluation time."],
  },
} as const satisfies Record<string, AnalyticDefinition>;

export type AnalyticId = keyof typeof ANALYTICS;

/** "id@version" for every current model version (results from older versions are history). */
export function currentModelKeys(): string[] {
  return (Object.values(ANALYTICS) as AnalyticDefinition[]).map((a) => `${a.id}@${a.version}`);
}

export function analytic(id: AnalyticId): AnalyticDefinition {
  return ANALYTICS[id];
}

/** Upsert model definitions so stored results can reference them. Idempotent. */
export async function registerAnalytics(tx: Tx): Promise<void> {
  for (const a of Object.values(ANALYTICS) as AnalyticDefinition[]) {
    await tx`
      insert into analytic_models (id, version, name, result_class, description, input_contract, output_schema, limitations)
      values (${a.id}, ${a.version}, ${a.name}, ${a.resultClass}, ${a.description},
              ${jsonb(a.inputContract)}::jsonb, ${jsonb(a.outputSchema)}::jsonb, ${a.limitations as unknown as string[]})
      on conflict (id, version) do update set
        name = excluded.name, description = excluded.description,
        input_contract = excluded.input_contract, output_schema = excluded.output_schema,
        limitations = excluded.limitations`;
  }
}
