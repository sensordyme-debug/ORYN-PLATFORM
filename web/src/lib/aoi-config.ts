/**
 * AOI vocabulary shared by forms, API validation, and the map UI.
 * Pure data — safe for client components.
 */

export const AOI_KINDS = [
  "field",
  "farm",
  "municipal_boundary",
  "construction_site",
  "watershed",
  "road_corridor",
  "public_asset",
  "infrastructure_project",
  "region",
  "other",
] as const;
export type AoiKind = (typeof AOI_KINDS)[number];

export const AOI_KIND_LABEL: Record<AoiKind, string> = {
  field: "Agricultural field",
  farm: "Farm",
  municipal_boundary: "Municipal boundary",
  construction_site: "Construction site",
  watershed: "Watershed",
  road_corridor: "Road corridor",
  public_asset: "Public asset",
  infrastructure_project: "Infrastructure project",
  region: "Region",
  other: "Other",
};

/** Data sources an AOI can monitor. Imagery ids are "<provider>:<collection>" product ids. */
export const DATA_SOURCES = {
  "earth-search:sentinel-2-l2a": { label: "Sentinel-2 L2A (10 m multispectral)", group: "imagery" },
  "planetary-computer:landsat-c2-l2": { label: "Landsat 8/9 Collection 2 L2 (30 m)", group: "imagery" },
  "planetary-computer:sentinel-1-rtc": { label: "Sentinel-1 radar RTC (10 m, all-weather)", group: "imagery" },
  "planetary-computer:esa-worldcover": { label: "ESA WorldCover land cover (annual, 10 m)", group: "imagery" },
  "planetary-computer:io-lulc-annual-v02": { label: "Impact Observatory land use/land cover (annual, 10 m)", group: "imagery" },
  nws: { label: "NOAA National Weather Service (observations, forecasts, warnings)", group: "context" },
  "open-meteo": { label: "Open-Meteo (reanalysis history, forecasts)", group: "context" },
  gdelt: { label: "GDELT news reports", group: "context" },
} as const;
export type DataSourceId = keyof typeof DATA_SOURCES;
export const DATA_SOURCE_IDS = Object.keys(DATA_SOURCES) as DataSourceId[];

export const ANALYTIC_OPTIONS = {
  ndvi: "Vegetation index (NDVI)",
  ndmi: "Canopy moisture index (NDMI)",
  "ndvi-zones": "Within-field low-vigour zones",
  ndwi: "Surface water index (NDWI)",
  "s1-water": "Radar open-water detection",
  "landcover-composition": "Land-cover composition",
  "ndvi-change": "Vegetation change candidates",
  "water-change": "Surface-water change candidates",
  "ndvi-anomaly": "Vegetation anomaly vs. own baseline",
} as const;
export type AnalyticOption = keyof typeof ANALYTIC_OPTIONS;
export const ANALYTIC_IDS = Object.keys(ANALYTIC_OPTIONS) as AnalyticOption[];

export type AoiDefaults = { dataSources: DataSourceId[]; analytics: AnalyticOption[]; intervalHours: number; maxCloudCover: number };

/** Sensible starting configuration per organization type. Users can change all of it. */
export function defaultsForOrgKind(kind: string): AoiDefaults {
  if (kind === "agriculture") {
    return {
      dataSources: ["earth-search:sentinel-2-l2a", "planetary-computer:landsat-c2-l2", "nws", "open-meteo"],
      analytics: ["ndvi", "ndmi", "ndvi-zones", "ndwi", "ndvi-change", "ndvi-anomaly"],
      intervalHours: 12,
      maxCloudCover: 60,
    };
  }
  return {
    dataSources: [
      "earth-search:sentinel-2-l2a",
      "planetary-computer:sentinel-1-rtc",
      "planetary-computer:esa-worldcover",
      "nws",
      "gdelt",
    ],
    analytics: ["ndvi", "ndwi", "s1-water", "landcover-composition", "ndvi-change", "water-change"],
    intervalHours: 24,
    maxCloudCover: 50,
  };
}
