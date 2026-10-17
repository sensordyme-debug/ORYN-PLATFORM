/**
 * Layers and modes of the 3D intelligence globe. Pure data; safe for client
 * components. Every layer says what kind of information it carries, so the
 * view never presents a computed position as an observation or a cached
 * snapshot as live.
 */

export const INTEL_LAYER_IDS = ["aois", "detections", "usgs-earthquakes", "nifc-wildfire-perimeters", "satellites", "cameras", "viirs-daily", "usgs-aerial"] as const;
export type IntelLayerId = (typeof INTEL_LAYER_IDS)[number];

export type IntelLayer = {
  id: IntelLayerId;
  name: string;
  group: "ORYN data" | "Public events" | "Orbits" | "Cameras" | "Imagery";
  /** What a record is. */
  kind: "organization data" | "derived analytics" | "measurement" | "official report" | "model output" | "camera" | "imagery";
  description: string;
  attribution?: string;
};

export const INTEL_LAYERS: Record<IntelLayerId, IntelLayer> = {
  aois: { id: "aois", name: "Areas of interest", group: "ORYN data", kind: "organization data", description: "Your organization's monitored fields and areas." },
  detections: {
    id: "detections",
    name: "Candidate changes and zones",
    group: "ORYN data",
    kind: "derived analytics",
    description: "ORYN findings from the last year at moderate evidence or stronger; review them in the map workspace.",
  },
  "usgs-earthquakes": {
    id: "usgs-earthquakes",
    name: "Earthquakes (M2.5+)",
    group: "Public events",
    kind: "measurement",
    description: "USGS events in the chosen window before the shown time (archive: past 30 days).",
    attribution: "Earthquake data: U.S. Geological Survey",
  },
  "nifc-wildfire-perimeters": {
    id: "nifc-wildfire-perimeters",
    name: "Wildfire perimeters (current, US)",
    group: "Public events",
    kind: "official report",
    description: "Current interagency perimeters — a present-day snapshot, hidden when you look back in time.",
    attribution: "Wildfire perimeters: National Interagency Fire Center (WFIGS)",
  },
  satellites: {
    id: "satellites",
    name: "Imaging satellites",
    group: "Orbits",
    kind: "model output",
    description: "Sentinel-2, Landsat and Sentinel-1 — the sources of ORYN's imagery — at positions computed from orbital elements.",
    attribution: "Orbital elements: CelesTrak",
  },
  cameras: {
    id: "cameras",
    name: "Traffic cameras (California)",
    group: "Cameras",
    kind: "camera",
    description: "Caltrans state-highway cameras: still images with capture times, and live video where Caltrans streams it. No computer vision runs.",
    attribution: "Traffic cameras: Caltrans CWWP2",
  },
  "viirs-daily": {
    id: "viirs-daily",
    name: "Daily true colour (VIIRS)",
    group: "Imagery",
    kind: "imagery",
    description: "NOAA-20 VIIRS corrected reflectance for one UTC day, 375 m; swath gaps and clouds as observed.",
    attribution: "Imagery: NASA EOSDIS GIBS / NOAA-20 VIIRS",
  },
  "usgs-aerial": {
    id: "usgs-aerial",
    name: "USGS aerial imagery (US)",
    group: "Imagery",
    kind: "imagery",
    description: "High-resolution US orthoimagery when zoomed in — a mosaic of varying dates, not current conditions.",
    attribution: "USDA, USGS The National Map: Orthoimagery",
  },
};

/** Base globe imagery (always on). */
export const BLUE_MARBLE = {
  url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
  maximumLevel: 8,
  credit: "Blue Marble: NASA Earth Observatory, via NASA EOSDIS GIBS",
} as const;

export const VIIRS_DAILY = {
  url: (date: string) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
  maximumLevel: 9,
  credit: "NOAA-20 VIIRS corrected reflectance: NASA EOSDIS GIBS",
} as const;

export const INTEL_MODE_IDS = ["global", "agriculture", "municipal", "traffic", "incident"] as const;
export type IntelModeId = (typeof INTEL_MODE_IDS)[number];

export type IntelMode = {
  id: IntelModeId;
  label: string;
  description: string;
  layers: IntelLayerId[];
  camera: "globe" | "areas" | "california";
  /** Earthquake look-back, days. */
  eventDays?: 1 | 7 | 30;
};

/**
 * Modes switch on implemented layers only; a layer that is off in this
 * deployment (e.g. not yet verified) stays off and the mode says so.
 * Camera coverage is California only (the one camera source implemented).
 */
export const INTEL_MODES: IntelMode[] = [
  {
    id: "global",
    label: "Global intelligence",
    description: "Public hazard events worldwide and the imaging satellites over them.",
    layers: ["usgs-earthquakes", "nifc-wildfire-perimeters", "satellites"],
    camera: "globe",
    eventDays: 7,
  },
  {
    id: "agriculture",
    label: "Agriculture and environment",
    description: "Your fields and findings, the satellites that image them, wildfire context, and today's VIIRS view.",
    layers: ["aois", "detections", "satellites", "nifc-wildfire-perimeters", "viirs-daily"],
    camera: "areas",
  },
  {
    id: "municipal",
    label: "Municipal and infrastructure",
    description: "Your areas and findings with seismic and wildfire context over aerial imagery.",
    layers: ["aois", "detections", "usgs-earthquakes", "nifc-wildfire-perimeters", "usgs-aerial"],
    camera: "areas",
    eventDays: 30,
  },
  {
    id: "traffic",
    label: "Traffic and cameras",
    description: "Caltrans highway cameras (California only) with live video where available, plus seismic and wildfire context.",
    layers: ["cameras", "usgs-earthquakes", "nifc-wildfire-perimeters", "usgs-aerial"],
    camera: "california",
    eventDays: 7,
  },
  {
    id: "incident",
    label: "Incident investigation",
    description: "Your areas, findings, and public events from the last 7 days; step back in time with the timeline.",
    layers: ["aois", "detections", "usgs-earthquakes", "nifc-wildfire-perimeters"],
    camera: "areas",
    eventDays: 7,
  },
];
