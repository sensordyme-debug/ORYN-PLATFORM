/**
 * Shapes of the JSON stored in observations.metrics / observations.quality /
 * observations.raster and detections.metrics. Producers (the processing
 * pipeline) and consumers (alert rules, reports, exports, UI) share these.
 */

export type Histogram = { min: number; max: number; counts: number[] };

/** observations.kind = 'ndvi' or 'ndmi' (index statistics over the AOI's valid pixels) */
export type NdviMetrics = {
  mean: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
  min: number;
  max: number;
  valid_pixels: number;
  total_pixels: number;
  /** valid_pixels / total_pixels (pixels inside the AOI polygon). */
  valid_fraction: number;
  /** Fraction of AOI pixels removed by the cloud/shadow/quality mask. */
  masked_fraction: number;
  pixel_area_m2: number;
  histogram: Histogram;
};

/** observations.kind = 'ndwi' (Sentinel-2) or 's1_water' (Sentinel-1) */
export type WaterMetrics = {
  water_fraction: number;
  water_area_m2: number;
  valid_fraction: number;
  valid_pixels: number;
  total_pixels: number;
  pixel_area_m2: number;
  /** NDWI threshold (optical) or VV dB threshold (radar). */
  threshold: number;
  mean_index?: number;
  mean_vv_db?: number;
};

/** observations.kind = 'landcover' */
export type LandcoverMetrics = {
  classes: { code: number; label: string; pixels: number; fraction: number; area_m2: number }[];
  valid_fraction: number;
  total_pixels: number;
  pixel_area_m2: number;
};

export type ObservationQuality = {
  /** Fraction of the AOI covered by the source footprint. */
  coverage_fraction: number;
  /** Provider-reported scene cloud cover (%), when available. */
  scene_cloud_cover: number | null;
  /** Fraction of AOI pixels masked as cloud / shadow / no data. */
  masked_fraction: number;
  /** Human-readable flags, e.g. "partial_coverage", "high_mask_fraction", "below_min_valid_fraction". */
  flags: string[];
  /** Native ground sample distance used (m). */
  gsd_m: number;
  /** Why the observation is unusable, when status = 'unusable'. */
  unusable_reason?: string;
};

/** observations.raster — a derived grid in the source CRS plus a rendered preview. */
export type RasterRef = {
  /** Storage key of the rendered RGBA PNG (transparent outside the AOI / masked). */
  png_key: string;
  /** Storage key of the Float32 values (little-endian, row-major, NaN = no data). */
  data_key: string;
  width: number;
  height: number;
  epsg: number;
  /** GDAL-style affine transform [originX, pixelW, 0, originY, 0, -pixelH] in the source CRS. */
  transform: [number, number, number, number, number, number];
  /** Image corners in lon/lat for map display: top-left, top-right, bottom-right, bottom-left. */
  corners: [[number, number], [number, number], [number, number], [number, number]];
  /** Legend for the PNG. */
  legend: { kind: "ndvi" | "ndwi" | "ndmi" | "water_mask" | "landcover" | "true_color" | "delta_ndvi"; min?: number; max?: number; stops?: { value: number; color: string; label?: string }[] };
  /** Optional true-colour preview PNG on the same grid (optical sources only). */
  true_color_key?: string;
  /** Uint8 AOI mask on the same grid (1 = pixel centre inside the AOI at processing time). */
  mask_key?: string;
};

/** detections.metrics for candidate changes */
export type ChangeMetrics = {
  pixel_count: number;
  area_m2: number;
  mean_delta?: number;
  min_delta?: number;
  max_delta?: number;
  direction: "decrease" | "increase" | "new_water" | "water_loss";
  /** Fraction of AOI pixels valid in both observations. */
  valid_overlap_fraction: number;
  days_between: number;
  same_grid: boolean;
};

export const WEATHER_VARIABLES = {
  precipitation_mm: { unit: "mm", label: "Precipitation" },
  temperature_max_c: { unit: "°C", label: "Maximum temperature" },
  temperature_min_c: { unit: "°C", label: "Minimum temperature" },
  temperature_c: { unit: "°C", label: "Temperature" },
  et0_mm: { unit: "mm", label: "Reference evapotranspiration (FAO-56)" },
  wind_speed_max_ms: { unit: "m/s", label: "Maximum wind speed" },
  relative_humidity_pct: { unit: "%", label: "Relative humidity" },
  precipitation_probability_pct: { unit: "%", label: "Precipitation probability" },
} as const;
export type WeatherVariable = keyof typeof WEATHER_VARIABLES;
