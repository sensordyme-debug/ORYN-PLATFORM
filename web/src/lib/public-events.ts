/**
 * Public event layers — keyless public hazard feeds shown as context on the
 * map. Pure data and types; safe for client components.
 *
 * These are public records, not ORYN findings: they are never written into
 * an organization's alerts or review queue automatically, and each layer
 * says exactly what it is (an official report or a measurement), when it was
 * observed, when ORYN retrieved it, and under what terms.
 *
 * Feed-state model adapted from God's Eye View (src/data/feedState.js,
 * https://github.com/bilawalsidhu/gods-eye-view, MIT License,
 * Copyright (c) 2026 Bilawal Sidhu — see THIRD_PARTY_NOTICES.md).
 */

export const PUBLIC_EVENT_LAYER_IDS = ["usgs-earthquakes", "nifc-wildfire-perimeters"] as const;
export type PublicEventLayerId = (typeof PUBLIC_EVENT_LAYER_IDS)[number];

export type PublicEventLayer = {
  id: PublicEventLayerId;
  name: string;
  category: "hazard";
  geometry: "point" | "polygon";
  provider: string;
  dataset: string;
  /** What a record is. */
  recordKind: "measurement" | "official_report";
  coverage: string;
  license: string;
  attribution: string;
  sourceUrl: string;
  /** How often the upstream feed is regenerated. */
  upstreamCadence: string;
  /** How long ORYN reuses a retrieved snapshot before fetching again. */
  cacheSeconds: number;
  /** Selectable look-back windows (days), when the feed has a time range. */
  windows?: readonly number[];
  limitations: string[];
};

export const PUBLIC_EVENT_LAYERS: Record<PublicEventLayerId, PublicEventLayer> = {
  "usgs-earthquakes": {
    id: "usgs-earthquakes",
    name: "Earthquakes (M2.5+)",
    category: "hazard",
    geometry: "point",
    provider: "U.S. Geological Survey",
    dataset: "ANSS ComCat summary feed — M2.5+, past 30 days",
    recordKind: "measurement",
    coverage: "Worldwide",
    license: "Public domain (U.S. Government work)",
    attribution: "Earthquake data: U.S. Geological Survey",
    sourceUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
    upstreamCadence: "Regenerated every minute",
    cacheSeconds: 300,
    windows: [1, 7, 30],
    limitations: [
      "Automatic solutions can change or be deleted after seismologist review; the status says which this is.",
      "Only events of magnitude 2.5 or more from the past 30 days; older history is not shown here.",
      "Location is the epicentre; shaking extends well beyond the marker and is not modelled here.",
    ],
  },
  "nifc-wildfire-perimeters": {
    id: "nifc-wildfire-perimeters",
    name: "Wildfire perimeters (current, US)",
    category: "hazard",
    geometry: "polygon",
    provider: "National Interagency Fire Center (WFIGS)",
    dataset: "WFIGS Interagency Perimeters — current incidents",
    recordKind: "official_report",
    coverage: "United States",
    license: "Public domain (U.S. Government interagency data, NIFC Open Data)",
    attribution: "Wildfire perimeters: National Interagency Fire Center (WFIGS)",
    sourceUrl: "https://data-nifc.opendata.arcgis.com/",
    upstreamCadence: "Updated by incident teams as perimeters are mapped (irregular)",
    cacheSeconds: 900,
    limitations: [
      "Perimeters are mapped by incident teams at irregular intervals; the perimeter date is when this boundary was current, not live fire extent.",
      "Boundaries are simplified to about 100 m for display.",
      "Only incidents the interagency system currently lists; small or unreported fires are absent.",
    ],
  },
};

export const isPublicEventLayerId = (v: string): v is PublicEventLayerId => (PUBLIC_EVENT_LAYER_IDS as readonly string[]).includes(v);

/** Normalized feature properties (GeoJSON) returned by the public-events API. */
export type EarthquakeProps = {
  layer: "usgs-earthquakes";
  id: string;
  title: string;
  magnitude: number;
  magnitudeType: string | null;
  depthKm: number | null;
  place: string | null;
  /** Event origin time (ISO). */
  observedAt: string | null;
  /** When USGS last updated this solution (ISO). */
  updatedAt: string | null;
  /** "automatic" or "reviewed" by a seismologist. */
  reviewStatus: string | null;
  eventType: string;
  tsunamiFlag: boolean;
  url: string | null;
};

export type WildfireProps = {
  layer: "nifc-wildfire-perimeters";
  id: string;
  title: string;
  /** Incident size, acres (as reported by the incident). */
  acres: number | null;
  percentContained: number | null;
  state: string | null;
  county: string | null;
  incidentType: string | null;
  cause: string | null;
  /** Fire discovery time (ISO). */
  discoveredAt: string | null;
  /** When this perimeter was current (ISO). */
  observedAt: string | null;
};

export type PublicEventProps = EarthquakeProps | WildfireProps;

/** Honest status of a feed, shown next to its toggle. */
export type FeedState = "nominal" | "loading" | "partial" | "stale" | "unavailable" | "disabled";

export type PublicEventFeed = {
  state: Exclude<FeedState, "loading">;
  /** When ORYN retrieved the snapshot being served (ISO), if any. */
  retrievedAt: string | null;
  /** When the provider generated it (ISO), when the feed says. */
  generatedAt: string | null;
  message: string | null;
  retryAfterSeconds: number | null;
};

export type PublicEventsResponse = {
  layer: PublicEventLayer;
  feed: PublicEventFeed;
  /** Matching records before the response limit was applied. */
  total: number;
  features: GeoJSON.FeatureCollection<GeoJSON.Geometry, PublicEventProps>;
};

/**
 * One state per feed. Serving the last good snapshot after a failed refresh
 * is "stale" (never "nominal"); a failure with nothing to show is
 * "unavailable"; a truncated response is "partial".
 */
export function feedState(s: { disabled?: boolean; loading?: boolean; error?: boolean; hasData: boolean; stale?: boolean; truncated?: boolean }): FeedState {
  if (s.disabled) return "disabled";
  if (s.loading && !s.hasData) return "loading";
  if (s.error && !s.hasData) return "unavailable";
  if (s.stale || (s.error && s.hasData)) return "stale";
  if (s.truncated) return "partial";
  return "nominal";
}

export const FEED_STATE_LABEL: Record<FeedState, string> = {
  nominal: "Current",
  loading: "Loading",
  partial: "Partial",
  stale: "Stale",
  unavailable: "Unavailable",
  disabled: "Off",
};
