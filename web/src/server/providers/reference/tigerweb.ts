/**
 * U.S. Census Bureau TIGERweb (ArcGIS REST) — place and county boundaries.
 *
 * Layers (current vintage, verified 2026-10-15 — layer descriptions read
 * "January 1, 2026 vintage"):
 *   Places_CouSub_ConCity_SubMCD/MapServer/4   Incorporated Places
 *   Places_CouSub_ConCity_SubMCD/MapServer/5   Census Designated Places
 *   State_County/MapServer/1                   Counties (most detailed scale band)
 *
 * Inputs are validated strictly before they reach a where clause: names are
 * letters/digits/space/.'- only (no SQL wildcards), single quotes are
 * doubled, state FIPS codes are two digits, place GEOIDs seven digits and
 * county GEOIDs five. ArcGIS reports query errors as HTTP 200 with an
 * {"error": …} body; those become ProviderError "bad_response".
 * Boundaries are returned as MultiPolygon in EPSG:4326 with provenance.
 * Census Bureau data are public domain.
 */
import type { MultiPolygonGeometry, Position } from "@/lib/geo";
import { httpJson, ProviderError, type FetchLike } from "@/server/providers/http";
import type { ProviderDescriptor } from "@/server/providers/types";

export const TIGERWEB_ID = "tigerweb";
export const TIGERWEB_BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";
export const TIGERWEB_LICENSE = "Public domain (U.S. Census Bureau)" as const;

export const TIGERWEB_LAYERS = {
  incorporated_place: { service: "Places_CouSub_ConCity_SubMCD", layerId: 4, name: "Incorporated Places" },
  census_designated_place: { service: "Places_CouSub_ConCity_SubMCD", layerId: 5, name: "Census Designated Places" },
  county: { service: "State_County", layerId: 1, name: "Counties" },
} as const;
export type CensusGeographyKind = keyof typeof TIGERWEB_LAYERS;

export const TIGERWEB_DESCRIPTOR: ProviderDescriptor = {
  id: TIGERWEB_ID,
  name: "Census TIGERweb",
  kind: "reference",
  operator: "U.S. Census Bureau",
  homepage: "https://tigerweb.geo.census.gov/",
  docsUrl: "https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_restmapservice.html",
  products: [
    {
      id: "tigerweb:incorporated-places",
      name: "Incorporated place boundaries",
      collection: "Places_CouSub_ConCity_SubMCD/4",
      kind: "vector",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
    },
    {
      id: "tigerweb:census-designated-places",
      name: "Census designated place boundaries",
      collection: "Places_CouSub_ConCity_SubMCD/5",
      kind: "vector",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
    },
    {
      id: "tigerweb:counties",
      name: "County boundaries",
      collection: "State_County/1",
      kind: "vector",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
    },
  ],
  licensing: {
    summary: "U.S. Census Bureau TIGER data are public domain (works of the U.S. Government).",
    url: "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html",
    redistribution: "Unrestricted.",
    commercialUse: "allowed",
    attribution: "Source: U.S. Census Bureau, TIGERweb",
  },
  credentials: { required: false, envVars: [] },
  updateCadence: "Annual vintages; the layer's stated vintage is recorded with every boundary.",
  delivery: "polling",
};

export type CensusGeography = {
  kind: CensusGeographyKind;
  geoid: string;
  name: string;
  basename: string;
  stateFips: string;
  countyFips: string | null;
  lsadCode: string | null;
  funcStat: string | null;
  areaLandM2: number | null;
  areaWaterM2: number | null;
  /** Census internal point [lon, lat], when reported. */
  position: Position | null;
};

export type BoundaryResult = {
  geometry: MultiPolygonGeometry;
  properties: Record<string, unknown>;
  provenance: {
    provider: typeof TIGERWEB_ID;
    service_url: string;
    layer: string;
    layer_id: number;
    vintage: string | null;
    query: string;
    retrieved_at: string;
    license: typeof TIGERWEB_LICENSE;
  };
};

export type TigerwebOptions = { fetchImpl?: FetchLike; signal?: AbortSignal; now?: () => Date };

// ── Validation ────────────────────────────────────────────────

export function validatePlaceName(name: string): string {
  const s = name.normalize("NFC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!/^[\p{L}\p{M}0-9 .'-]{1,100}$/u.test(s)) throw new RangeError("Name may contain only letters, digits, spaces, periods, apostrophes and hyphens (1–100 characters)");
  return s;
}

export function validateStateFips(fips: string): string {
  if (!/^\d{2}$/.test(fips)) throw new RangeError("State FIPS code must be two digits");
  return fips;
}

function validateGeoid(geoid: string, digits: 5 | 7): string {
  if (!new RegExp(`^\\d{${digits}}$`).test(geoid)) throw new RangeError(`GEOID must be ${digits} digits`);
  return geoid;
}

/** SQL string literal for an ArcGIS where clause (input must already be validated). */
export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ── Queries ───────────────────────────────────────────────────

const FIELDS = "NAME,BASENAME,GEOID,STATE,AREALAND,AREAWATER,LSADC,FUNCSTAT,INTPTLAT,INTPTLON";
const COUNTY_FIELDS = `${FIELDS},COUNTY`;

function layerUrl(kind: CensusGeographyKind): string {
  const l = TIGERWEB_LAYERS[kind];
  return `${TIGERWEB_BASE}/${l.service}/MapServer/${l.layerId}`;
}

async function arcgis<T>(url: string, params: Record<string, string>, opts: TigerwebOptions): Promise<T> {
  const res = await httpJson<T & { error?: { message?: string; code?: number } }>(`${url}?${new URLSearchParams(params).toString()}`, {
    providerId: TIGERWEB_ID,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    timeoutMs: 30_000,
    maxBytes: 30 * 1024 * 1024,
  });
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new ProviderError(TIGERWEB_ID, "bad_response", `TIGERweb query failed: ${res.error.message ?? "unknown error"}`, { retryable: false });
  }
  return res;
}

async function searchLayer(kind: CensusGeographyKind, name: string, stateFips: string | undefined, opts: TigerwebOptions): Promise<CensusGeography[]> {
  const n = validatePlaceName(name);
  const clauses = [`(UPPER(BASENAME)=UPPER(${sqlString(n)}) OR UPPER(NAME)=UPPER(${sqlString(n)}))`];
  if (stateFips !== undefined) clauses.push(`STATE=${sqlString(validateStateFips(stateFips))}`);
  const res = await arcgis<{ features?: { attributes?: Record<string, unknown> }[] }>(
    `${layerUrl(kind)}/query`,
    {
      where: clauses.join(" AND "),
      outFields: kind === "county" ? COUNTY_FIELDS : FIELDS,
      returnGeometry: "false",
      resultRecordCount: "25",
      f: "json",
    },
    opts,
  );
  if (!Array.isArray(res.features)) throw new ProviderError(TIGERWEB_ID, "bad_response", "TIGERweb response has no features", { retryable: false });
  return res.features.map((f) => toGeography(kind, f.attributes ?? {})).filter((g): g is CensusGeography => g !== null);
}

function toGeography(kind: CensusGeographyKind, a: Record<string, unknown>): CensusGeography | null {
  const geoid = str(a.GEOID);
  const name = str(a.NAME);
  const state = str(a.STATE);
  if (!geoid || !name || !state) return null;
  const lat = coord(a.INTPTLAT);
  const lon = coord(a.INTPTLON);
  return {
    kind,
    geoid,
    name,
    basename: str(a.BASENAME) ?? name,
    stateFips: state,
    countyFips: str(a.COUNTY),
    lsadCode: str(a.LSADC),
    funcStat: str(a.FUNCSTAT),
    areaLandM2: num(a.AREALAND),
    areaWaterM2: num(a.AREAWATER),
    position: lat !== null && lon !== null ? [lon, lat] : null,
  };
}

/** Incorporated places and census designated places whose name matches exactly (case-insensitive). */
export async function searchPlaces(name: string, stateFips?: string, opts: TigerwebOptions = {}): Promise<CensusGeography[]> {
  const incorporated = await searchLayer("incorporated_place", name, stateFips, opts);
  const cdp = await searchLayer("census_designated_place", name, stateFips, opts);
  return [...incorporated, ...cdp];
}

export async function searchCounties(name: string, stateFips?: string, opts: TigerwebOptions = {}): Promise<CensusGeography[]> {
  return searchLayer("county", name, stateFips, opts);
}

/** Boundary of an incorporated place or CDP by 7-digit GEOID. */
export async function getPlaceBoundary(geoid: string, opts: TigerwebOptions = {}): Promise<BoundaryResult> {
  validateGeoid(geoid, 7);
  for (const kind of ["incorporated_place", "census_designated_place"] as const) {
    const r = await boundary(kind, geoid, opts);
    if (r) return r;
  }
  throw new ProviderError(TIGERWEB_ID, "not_found", `No place with GEOID ${geoid}`, { retryable: false });
}

/** Boundary of a county by 5-digit GEOID. */
export async function getCountyBoundary(geoid: string, opts: TigerwebOptions = {}): Promise<BoundaryResult> {
  validateGeoid(geoid, 5);
  const r = await boundary("county", geoid, opts);
  if (!r) throw new ProviderError(TIGERWEB_ID, "not_found", `No county with GEOID ${geoid}`, { retryable: false });
  return r;
}

async function boundary(kind: CensusGeographyKind, geoid: string, opts: TigerwebOptions): Promise<BoundaryResult | null> {
  const where = `GEOID=${sqlString(geoid)}`;
  const res = await arcgis<{ type?: string; features?: { geometry?: unknown; properties?: Record<string, unknown> }[] }>(
    `${layerUrl(kind)}/query`,
    {
      where,
      outFields: kind === "county" ? "NAME,BASENAME,GEOID,STATE,COUNTY,AREALAND,AREAWATER,LSADC,FUNCSTAT" : "NAME,BASENAME,GEOID,STATE,AREALAND,AREAWATER,LSADC,FUNCSTAT",
      returnGeometry: "true",
      outSR: "4326",
      geometryPrecision: "6",
      f: "geojson",
    },
    opts,
  );
  const feature = res.features?.[0];
  if (!feature) return null;
  const geometry = toMultiPolygon(feature.geometry);
  if (!geometry) throw new ProviderError(TIGERWEB_ID, "bad_response", `TIGERweb returned no polygon geometry for GEOID ${geoid}`, { retryable: false });
  const layer = TIGERWEB_LAYERS[kind];
  return {
    geometry,
    properties: { ...(feature.properties ?? {}), kind },
    provenance: {
      provider: TIGERWEB_ID,
      service_url: layerUrl(kind),
      layer: layer.name,
      layer_id: layer.layerId,
      vintage: await layerVintage(kind, opts),
      query: where,
      retrieved_at: (opts.now ?? (() => new Date()))().toISOString(),
      license: TIGERWEB_LICENSE,
    },
  };
}

const vintageCache = new Map<CensusGeographyKind, { vintage: string | null; at: number }>();

/** "January 1, 2026" from the layer description ("…; January 1, 2026 vintage"); null when unavailable. */
async function layerVintage(kind: CensusGeographyKind, opts: TigerwebOptions): Promise<string | null> {
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const hit = vintageCache.get(kind);
  if (hit && nowMs - hit.at < 24 * 3_600_000) return hit.vintage;
  let vintage: string | null = null;
  try {
    const meta = await arcgis<{ description?: string }>(layerUrl(kind), { f: "json" }, opts);
    vintage = parseVintage(meta.description);
  } catch {
    vintage = null;
  }
  vintageCache.set(kind, { vintage, at: nowMs });
  return vintage;
}

export function parseVintage(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const m = /;\s*([^;]+?)\s+vintage\b/i.exec(description);
  return m ? m[1]!.trim() : null;
}

export function clearTigerwebCache(): void {
  vintageCache.clear();
}

/** Polygon or MultiPolygon GeoJSON → MultiPolygon with closed rings, or null. */
export function toMultiPolygon(g: unknown): MultiPolygonGeometry | null {
  if (!g || typeof g !== "object") return null;
  const geom = g as { type?: unknown; coordinates?: unknown };
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : null;
  if (!Array.isArray(polys) || polys.length === 0) return null;
  const out: Position[][][] = [];
  for (const poly of polys) {
    if (!Array.isArray(poly) || poly.length === 0) return null;
    const rings: Position[][] = [];
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return null;
      const pts: Position[] = [];
      for (const p of ring) {
        if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
        pts.push([p[0], p[1]]);
      }
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) pts.push([first[0], first[1]]);
      rings.push(pts);
    }
    out.push(rings);
  }
  return { type: "MultiPolygon", coordinates: out };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** TIGER coordinates are strings like "+35.9042418" / "-077.5555414". */
function coord(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !/^[+-]?\d+(\.\d+)?$/.test(v.trim())) return null;
  return Number(v.trim());
}
