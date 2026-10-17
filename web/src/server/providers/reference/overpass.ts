/**
 * OpenStreetMap features via the Overpass API.
 *
 * fetchOsmFeatures(bbox, categories) runs one Overpass QL query for the
 * requested categories inside a bounding box and converts elements to
 * ReferenceFeatures:
 *   node                                  → Point
 *   closed way that is an area (building,
 *     facility, bridge outline, area=yes) → Polygon
 *   any other way (roads, waterways, …)   → LineString
 * Relations (multipolygons) are not fetched in this version.
 *
 * Limits: the bbox must be ≤ 400 km² and at most 5,000 elements are returned
 * (`truncated` reports when the cap was hit). Overpass "runtime error"
 * remarks (timeouts, memory) become retryable ProviderErrors. Requests to the
 * public instance are spaced ≥ 1 s apart process-wide.
 *
 * Licence: OSM data are © OpenStreetMap contributors under the ODbL 1.0.
 * Attribution is required, and a database derived from OSM data that is
 * publicly used must be offered under the ODbL (share-alike).
 */
import { bboxToPolygon, geometryArea, type BBox, type Geometry, type Position } from "@/lib/geo";
import { env } from "@/server/config/env";
import { httpJson, ProviderError, type FetchLike } from "@/server/providers/http";
import type { ProviderDescriptor, ReferenceFeature } from "@/server/providers/types";

export const OVERPASS_ID = "overpass";
export const OVERPASS_MAX_BBOX_KM2 = 400;
export const OVERPASS_MAX_FEATURES = 5_000;
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors" as const;
export const OSM_LICENSE = "ODbL-1.0" as const;
export const OSM_LICENSE_URL = "https://www.openstreetmap.org/copyright" as const;

export const OSM_CATEGORIES = ["roads", "buildings", "bridges", "critical_facilities", "waterways"] as const;
export type OsmCategory = (typeof OSM_CATEGORIES)[number];

export const OVERPASS_DESCRIPTOR: ProviderDescriptor = {
  id: OVERPASS_ID,
  name: "OpenStreetMap (Overpass API)",
  kind: "reference",
  operator: "OpenStreetMap contributors (data); public Overpass API instance at overpass-api.de (query service)",
  homepage: "https://www.openstreetmap.org/",
  docsUrl: "https://wiki.openstreetmap.org/wiki/Overpass_API",
  products: [
    {
      id: "overpass:osm-features",
      name: "OSM roads, buildings, bridges, critical facilities, waterways",
      collection: "osm",
      kind: "vector",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: `Community-mapped; completeness varies by area. Bounding box ≤ ${OVERPASS_MAX_BBOX_KM2} km², ≤ ${OVERPASS_MAX_FEATURES} features per request.`,
    },
  ],
  licensing: {
    summary:
      "OpenStreetMap data are licensed under the Open Database License (ODbL) 1.0: free to use, including commercially, with attribution; databases derived from OSM and publicly used must be made available under the ODbL (share-alike). Produced works such as maps and reports need attribution only.",
    url: OSM_LICENSE_URL,
    redistribution: "Attribution “© OpenStreetMap contributors” required; derived databases are share-alike under the ODbL.",
    commercialUse: "allowed",
    attribution: OSM_ATTRIBUTION,
  },
  credentials: { required: false, envVars: ["OVERPASS_URL"] },
  updateCadence: "Minutely replication from OpenStreetMap.",
  delivery: "polling",
  rateLimit: "Public instance: limited concurrent slots per IP; heavy users should run their own instance (see provider terms).",
};

const ROAD_CLASSES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
const FACILITY_FILTERS = [
  '["amenity"~"^(hospital|clinic|fire_station|police|school|shelter|townhall|community_centre)$"]',
  '["emergency"="ambulance_station"]',
  '["healthcare"="hospital"]',
  '["power"~"^(substation|plant)$"]',
  '["man_made"~"^(water_tower|water_works|wastewater_plant|pumping_station)$"]',
];

const STATEMENTS: Record<OsmCategory, string[]> = {
  roads: [`way["highway"~"^(${ROAD_CLASSES})$"];`],
  buildings: ['way["building"];'],
  bridges: ['way["bridge"]["bridge"!="no"];', 'way["man_made"="bridge"];'],
  critical_facilities: FACILITY_FILTERS.flatMap((f) => [`node${f};`, `way${f};`]),
  waterways: ['way["waterway"~"^(river|stream|canal|drain|ditch)$"];'],
};

export function validateBbox(bbox: BBox): BBox {
  const [w, s, e, n] = bbox;
  if (![w, s, e, n].every((v) => typeof v === "number" && Number.isFinite(v))) throw new RangeError("bbox must contain four finite numbers");
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new RangeError("bbox must be [west, south, east, north] with west < east and south < north");
  const km2 = geometryArea(bboxToPolygon(bbox)) / 1e6;
  if (km2 > OVERPASS_MAX_BBOX_KM2) throw new RangeError(`bbox covers ${km2.toFixed(0)} km²; the limit is ${OVERPASS_MAX_BBOX_KM2} km²`);
  return bbox;
}

export function buildOverpassQuery(bbox: BBox, categories: readonly OsmCategory[]): string {
  const [w, s, e, n] = validateBbox(bbox);
  const cats = [...new Set(categories)];
  if (cats.length === 0 || !cats.every((c) => (OSM_CATEGORIES as readonly string[]).includes(c))) {
    throw new RangeError(`categories must be a non-empty subset of ${OSM_CATEGORIES.join(", ")}`);
  }
  const f = (v: number) => v.toFixed(6);
  const body = cats.flatMap((c) => STATEMENTS[c]).join("");
  return `[out:json][timeout:25][bbox:${f(s)},${f(w)},${f(n)},${f(e)}];(${body});out geom ${OVERPASS_MAX_FEATURES + 1};`;
}

export type OsmFeatureResult = {
  features: ReferenceFeature[];
  truncated: boolean;
  attribution: typeof OSM_ATTRIBUTION;
  license: typeof OSM_LICENSE;
  licenseUrl: typeof OSM_LICENSE_URL;
  shareAlike: string;
  /** OSM data timestamp reported by Overpass. */
  osmBase: string | null;
  retrievedAt: string;
  sourceUrl: string;
  query: string;
};

type OverpassElement = {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: ({ lat?: number; lon?: number } | null)[];
};

export async function fetchOsmFeatures(
  bbox: BBox,
  categories: OsmCategory[],
  signal?: AbortSignal,
  opts: { fetchImpl?: FetchLike; endpoint?: string; now?: () => Date } = {},
): Promise<OsmFeatureResult> {
  const query = buildOverpassQuery(bbox, categories);
  const endpoint = opts.endpoint ?? env.overpassUrl();
  const res = await httpJson<{ elements?: OverpassElement[]; remark?: string; osm3s?: { timestamp_osm_base?: string } }>(endpoint, {
    providerId: OVERPASS_ID,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
    signal,
    fetchImpl: opts.fetchImpl,
    // The public instance queues requests for a free slot; small queries have taken ~55 s under load.
    timeoutMs: 60_000,
    retries: 1,
    minIntervalMs: 1_000,
    maxBytes: 50 * 1024 * 1024,
  });
  if (typeof res.remark === "string" && /runtime error/i.test(res.remark)) {
    const timedOut = /timed out|timeout/i.test(res.remark);
    throw new ProviderError(OVERPASS_ID, timedOut ? "timeout" : "unavailable", `Overpass: ${res.remark.slice(0, 200)}`, { retryable: true });
  }
  if (!Array.isArray(res.elements)) throw new ProviderError(OVERPASS_ID, "bad_response", "Overpass response has no elements", { retryable: false });

  const requested = new Set(categories);
  const features: ReferenceFeature[] = [];
  for (const el of res.elements.slice(0, OVERPASS_MAX_FEATURES)) {
    const f = elementToFeature(el, requested);
    if (f) features.push(f);
  }
  return {
    features,
    truncated: res.elements.length > OVERPASS_MAX_FEATURES,
    attribution: OSM_ATTRIBUTION,
    license: OSM_LICENSE,
    licenseUrl: OSM_LICENSE_URL,
    shareAlike: "Derived databases that are publicly used must be offered under the ODbL; produced works require attribution.",
    osmBase: typeof res.osm3s?.timestamp_osm_base === "string" ? res.osm3s.timestamp_osm_base : null,
    retrievedAt: (opts.now ?? (() => new Date()))().toISOString(),
    sourceUrl: endpoint,
    query,
  };
}

/** Categories (among those requested) that an element's tags satisfy. */
export function categoriesOf(tags: Record<string, string>, requested: ReadonlySet<OsmCategory>): OsmCategory[] {
  const out: OsmCategory[] = [];
  const has = (k: string, re: RegExp) => typeof tags[k] === "string" && re.test(tags[k]!);
  if (requested.has("bridges") && ((tags.bridge && tags.bridge !== "no") || tags.man_made === "bridge")) out.push("bridges");
  if (requested.has("buildings") && tags.building) out.push("buildings");
  if (requested.has("roads") && has("highway", new RegExp(`^(${ROAD_CLASSES})$`))) out.push("roads");
  if (requested.has("waterways") && has("waterway", /^(river|stream|canal|drain|ditch)$/)) out.push("waterways");
  if (
    requested.has("critical_facilities") &&
    (has("amenity", /^(hospital|clinic|fire_station|police|school|shelter|townhall|community_centre)$/) ||
      tags.emergency === "ambulance_station" ||
      tags.healthcare === "hospital" ||
      has("power", /^(substation|plant)$/) ||
      has("man_made", /^(water_tower|water_works|wastewater_plant|pumping_station)$/))
  ) {
    out.push("critical_facilities");
  }
  return out;
}

export function elementToFeature(el: OverpassElement, requested: ReadonlySet<OsmCategory>): ReferenceFeature | null {
  if ((el.type !== "way" && el.type !== "node") || typeof el.id !== "number") return null;
  const tags = el.tags ?? {};
  const cats = categoriesOf(tags, requested);
  if (cats.length === 0) return null;
  let geometry: Geometry | null = null;
  if (el.type === "node") {
    if (validLonLat(el.lon, el.lat)) geometry = { type: "Point", coordinates: [el.lon!, el.lat!] };
  } else {
    const pts: Position[] = [];
    for (const g of el.geometry ?? []) if (g && validLonLat(g.lon, g.lat)) pts.push([g.lon!, g.lat!]);
    if (pts.length !== (el.geometry ?? []).length || pts.length < 2) return null;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const closed = pts.length >= 4 && first[0] === last[0] && first[1] === last[1];
    const isArea =
      tags.area === "yes" ||
      Boolean(tags.building) ||
      tags.man_made === "bridge" ||
      (cats.includes("critical_facilities") && !tags.highway && !tags.waterway);
    geometry = closed && isArea && tags.area !== "no" ? { type: "Polygon", coordinates: [pts] } : { type: "LineString", coordinates: pts };
  }
  if (!geometry) return null;
  return {
    externalId: `${el.type}/${el.id}`,
    geometry,
    properties: { osm_type: el.type, osm_id: el.id, category: cats[0], categories: cats, tags },
  };
}

function validLonLat(lon: unknown, lat: unknown): boolean {
  return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}
