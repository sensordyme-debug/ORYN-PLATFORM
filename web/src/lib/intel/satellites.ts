/**
 * The Earth-observation satellites behind ORYN's imagery, shown on the
 * intelligence globe. Pure data and types; safe for client components.
 *
 * Positions are COMPUTED from published orbital elements (SGP4), not
 * observed: accuracy is a few kilometres near the elements' epoch and
 * degrades by roughly 1–3 km per day away from it.
 */

export type ImagingSatellite = {
  noradId: number;
  name: string;
  mission: "Sentinel-2" | "Landsat" | "Sentinel-1";
  sensor: string;
  /** Imaging swath width, km. */
  swathKm: number;
  /** Optical sensors image the day side only. */
  optical: boolean;
  /** ORYN's catalog products that this satellite feeds. */
  orynProducts: string[];
};

export const IMAGING_SATELLITES: ImagingSatellite[] = [
  { noradId: 40697, name: "Sentinel-2A", mission: "Sentinel-2", sensor: "MSI multispectral, 10–60 m", swathKm: 290, optical: true, orynProducts: ["earth-search:sentinel-2-l2a", "planetary-computer:sentinel-2-l2a"] },
  { noradId: 42063, name: "Sentinel-2B", mission: "Sentinel-2", sensor: "MSI multispectral, 10–60 m", swathKm: 290, optical: true, orynProducts: ["earth-search:sentinel-2-l2a", "planetary-computer:sentinel-2-l2a"] },
  { noradId: 60989, name: "Sentinel-2C", mission: "Sentinel-2", sensor: "MSI multispectral, 10–60 m", swathKm: 290, optical: true, orynProducts: ["earth-search:sentinel-2-l2a", "planetary-computer:sentinel-2-l2a"] },
  { noradId: 39084, name: "Landsat 8", mission: "Landsat", sensor: "OLI/TIRS, 30 m (thermal 100 m)", swathKm: 185, optical: true, orynProducts: ["planetary-computer:landsat-c2-l2", "nasa-cmr:hls"] },
  { noradId: 49260, name: "Landsat 9", mission: "Landsat", sensor: "OLI-2/TIRS-2, 30 m (thermal 100 m)", swathKm: 185, optical: true, orynProducts: ["planetary-computer:landsat-c2-l2", "nasa-cmr:hls"] },
  { noradId: 39634, name: "Sentinel-1A", mission: "Sentinel-1", sensor: "C-band SAR (IW mode), 10 m", swathKm: 250, optical: false, orynProducts: ["planetary-computer:sentinel-1-rtc"] },
  { noradId: 62261, name: "Sentinel-1C", mission: "Sentinel-1", sensor: "C-band SAR (IW mode), 10 m", swathKm: 250, optical: false, orynProducts: ["planetary-computer:sentinel-1-rtc"] },
  { noradId: 66315, name: "Sentinel-1D", mission: "Sentinel-1", sensor: "C-band SAR (IW mode), 10 m", swathKm: 250, optical: false, orynProducts: ["planetary-computer:sentinel-1-rtc"] },
];

export const SATELLITE_SOURCE = {
  provider: "CelesTrak",
  dataset: "General perturbations (GP) orbital elements, OMM",
  attribution: "Orbital elements: CelesTrak (celestrak.org), from U.S. Space Force 18th/19th SDS data",
  sourceUrl: "https://celestrak.org/NORAD/elements/",
  license: "No formal licence published; CelesTrak publishes GP data openly and asks clients to download at most once per 2-hour update. ORYN shows derived positions only.",
  limitations: [
    "Positions are computed from orbital elements (SGP4), not observed; expect a few kilometres of error, growing with time from the elements' epoch.",
    "An overpass is geometry only: the satellite passes within half its swath of the place. Whether it actually images depends on the mission's acquisition plan, and optical images need daylight and clear skies.",
  ],
} as const;

/** One satellite's computed track for the requested window. */
export type SatelliteTrack = {
  noradId: number;
  name: string;
  /** Orbital elements epoch (ISO) and age at the requested time, hours. */
  elementsEpoch: string;
  elementsAgeHours: number;
  /** [unix ms, lon°, lat°, height m] every `stepSeconds`. */
  samples: [number, number, number, number][];
};

export type SatelliteTracksResponse = {
  feed: { state: "nominal" | "stale" | "unavailable" | "disabled"; retrievedAt: string | null; message: string | null };
  /** Centre of the sampled window (ISO) and its half-width, minutes. */
  at: string;
  halfWindowMinutes: number;
  stepSeconds: number;
  satellites: (ImagingSatellite & { track: SatelliteTrack | null })[];
};

export type Overpass = {
  noradId: number;
  name: string;
  /** Closest approach (ISO) and the sub-satellite point's distance from the place, km. */
  time: string;
  distanceKm: number;
  /** Sun elevation at the place at that time, degrees (optical passes need daylight). */
  sunElevationDeg: number;
  /** "ascending" (moving north) or "descending". */
  direction: "ascending" | "descending";
};

export type OverpassResponse = {
  feed: SatelliteTracksResponse["feed"];
  place: { lon: number; lat: number };
  fromIso: string;
  days: number;
  passes: Overpass[];
};
