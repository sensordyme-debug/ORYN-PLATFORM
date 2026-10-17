/**
 * Generic STAC API client and item normalization.
 *
 * search()   POST /search with intersects / datetime / query / sortby, then
 *            follows rel="next" links (POST with body, or GET) up to a page
 *            cap. Stops on a missing next link, an empty page, a repeated
 *            next link, the item cap, or the page cap (reported as
 *            `truncated`).
 * toAsset()  maps one STAC item to a NormalizedAsset using a per-collection
 *            map from ORYN canonical asset keys (red, nir, scl, vv, map, …)
 *            to the provider's asset keys. Only http(s) assets are kept
 *            (s3:// duplicates are ignored unless the asset carries an https
 *            alternate). Projection, raster scale/offset, nodata and gsd are
 *            read from STAC 1.0 extensions (proj:epsg, raster:bands) and
 *            STAC 1.1 forms (proj:code "EPSG:32618", bands[], raster:scale).
 *
 * Nothing is invented: a value the item does not carry is null/undefined.
 * Items without an id, a polygonal footprint, or an acquisition time are
 * skipped with a warning rather than failing the whole search.
 */
import type { Geometry, Position } from "@/lib/geo";
import { log } from "@/server/log";
import { httpJson, ProviderError, type FetchLike } from "@/server/providers/http";
import type { AssetFile, ImagerySearch, NormalizedAsset, RasterBandInfo } from "@/server/providers/types";

export const CANONICAL_ASSET_KEYS = [
  "red",
  "green",
  "blue",
  "nir",
  "nir08",
  "swir16",
  "swir22",
  "scl",
  "qa_pixel",
  "visual",
  "vv",
  "vh",
  "map",
  "data",
  "fmask",
] as const;
export type CanonicalAssetKey = (typeof CANONICAL_ASSET_KEYS)[number];

// ── STAC shapes (only the parts ORYN reads) ───────────────────

export type StacLink = {
  rel: string;
  href: string;
  type?: string;
  title?: string;
  method?: string;
  body?: Record<string, unknown>;
  merge?: boolean;
  headers?: Record<string, string>;
};

export type StacAsset = {
  href: string;
  type?: string;
  title?: string;
  roles?: string[];
  gsd?: number;
  alternate?: Record<string, { href?: string }>;
  [key: string]: unknown;
};

export type StacItem = {
  type?: string;
  id: string;
  collection?: string;
  geometry: unknown;
  bbox?: number[];
  properties: Record<string, unknown>;
  assets: Record<string, StacAsset>;
  links?: StacLink[];
};

export type StacItemCollection = { type?: string; features?: StacItem[]; links?: StacLink[] };

export type StacCollection = { id: string; title?: string; license?: string; links?: StacLink[]; [key: string]: unknown };

// ── Per-collection mapping ────────────────────────────────────

export type CollectionLicense = { license: string | null; licenseUrl: string | null; attribution: string | null };

export type StacCollectionConfig = {
  /** STAC collection id at the provider. */
  collection: string;
  kind: NormalizedAsset["kind"];
  /** Canonical key → provider asset key(s); the first key present on the item wins. */
  assetMap: Partial<Record<CanonicalAssetKey, string | readonly string[]>>;
  /** e.g. "L2A"; used when the item does not state processing:level. */
  processingLevel?: string | null;
  /** Collection-level licence used when the item does not carry a usable one. "[year]" in attribution is replaced by the acquisition year. */
  license: CollectionLicense;
  /** Whether eo:cloud_cover is a queryable for this collection. */
  cloudCoverQueryable?: boolean;
  /** Provider-specific grid code derivation, used only when standard properties are absent. */
  gridCode?: (item: StacItem) => string | null;
};

export type StacClient = {
  providerId: string;
  /** API root, e.g. https://earth-search.aws.element84.com/v1 */
  baseUrl: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
};

export type StacSearchParams = {
  collections: string[];
  intersects: Geometry;
  /** RFC 3339 interval, e.g. "2026-09-01T00:00:00.000Z/2026-10-15T00:00:00.000Z". */
  datetime: string;
  /** Page size requested from the server (default 100). */
  pageSize?: number;
  /** Stop after this many items (default 500). */
  maxItems?: number;
  /** Stop after this many pages (default 10). */
  maxPages?: number;
  query?: Record<string, unknown>;
  sortby?: { field: string; direction: "asc" | "desc" }[];
  signal?: AbortSignal;
};

export type StacSearchResult = { items: StacItem[]; pages: number; truncated: boolean };

export function datetimeInterval(start: Date, end: Date): string {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError("start and end must be valid dates");
  }
  if (start.getTime() > end.getTime()) throw new RangeError("start must not be after end");
  return `${start.toISOString()}/${end.toISOString()}`;
}

/** STAC API item search with pagination. */
export async function stacSearch(client: StacClient, params: StacSearchParams): Promise<StacSearchResult> {
  const pageSize = Math.max(1, Math.min(params.pageSize ?? 100, 1000));
  const maxItems = Math.max(1, params.maxItems ?? 500);
  const maxPages = Math.max(1, params.maxPages ?? 10);
  const body: Record<string, unknown> = {
    collections: params.collections,
    intersects: params.intersects,
    datetime: params.datetime,
    limit: Math.min(pageSize, maxItems),
  };
  if (params.query && Object.keys(params.query).length > 0) body.query = params.query;
  if (params.sortby && params.sortby.length > 0) body.sortby = params.sortby;

  const items: StacItem[] = [];
  const seen = new Set<string>();
  let request: { url: string; method: "GET" | "POST"; body?: Record<string, unknown>; headers?: Record<string, string> } = {
    url: `${trimSlash(client.baseUrl)}/search`,
    method: "POST",
    body,
  };
  let pages = 0;
  let truncated = false;

  for (;;) {
    const page = await httpJson<StacItemCollection>(request.url, {
      providerId: client.providerId,
      method: request.method,
      json: request.method === "POST" ? request.body : undefined,
      headers: { accept: "application/geo+json, application/json", ...client.headers, ...request.headers },
      signal: params.signal,
      timeoutMs: client.timeoutMs ?? 30_000,
      retries: client.retries,
      fetchImpl: client.fetchImpl,
    });
    pages++;
    if (!page || typeof page !== "object" || !Array.isArray(page.features)) {
      throw new ProviderError(client.providerId, "bad_response", "STAC search response has no features array", { retryable: false });
    }
    for (const f of page.features) {
      if (items.length >= maxItems) break;
      if (f && typeof f.id === "string" && !seen.has(`${f.collection ?? ""}/${f.id}`)) {
        seen.add(`${f.collection ?? ""}/${f.id}`);
        items.push(f);
      }
    }
    const next = (page.links ?? []).find((l) => l && l.rel === "next" && typeof l.href === "string");
    if (!next || page.features.length === 0 || items.length >= maxItems) {
      truncated = Boolean(next) && page.features.length > 0;
      break;
    }
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const nextMethod = (next.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const nextBody = nextMethod === "POST" ? (next.merge ? { ...request.body, ...next.body } : (next.body ?? request.body)) : undefined;
    const key = `${nextMethod} ${next.href} ${nextBody ? JSON.stringify(nextBody) : ""}`;
    const prevKey = `${request.method} ${request.url} ${request.body ? JSON.stringify(request.body) : ""}`;
    if (key === prevKey) {
      log.warn("stac pagination repeated the same page; stopping", { provider: client.providerId });
      truncated = true;
      break;
    }
    request = { url: next.href, method: nextMethod, body: nextBody, headers: next.headers };
  }
  return { items, pages, truncated };
}

export async function getStacCollection(client: StacClient, collection: string, signal?: AbortSignal): Promise<StacCollection> {
  const c = await httpJson<StacCollection>(`${trimSlash(client.baseUrl)}/collections/${encodeURIComponent(collection)}`, {
    providerId: client.providerId,
    headers: client.headers,
    signal,
    timeoutMs: client.timeoutMs ?? 15_000,
    retries: client.retries ?? 1,
    fetchImpl: client.fetchImpl,
  });
  if (!c || typeof c !== "object" || typeof c.id !== "string") {
    throw new ProviderError(client.providerId, "bad_response", "STAC collection response has no id", { retryable: false });
  }
  return c;
}

/**
 * Run an ImagerySearch against one product's STAC collections and normalize
 * the results. Cloud cover is filtered server-side when every collection
 * supports it, and re-checked client-side (items without a cloud-cover value,
 * e.g. radar or land cover, are kept). Results are newest first.
 */
export async function searchStacProduct(
  client: StacClient,
  configs: readonly StacCollectionConfig[],
  q: ImagerySearch,
): Promise<NormalizedAsset[]> {
  if (configs.length === 0) return [];
  const datetime = datetimeInterval(q.start, q.end);
  const limit = Math.max(1, Math.min(q.limit ?? 200, 2000));
  const max = q.maxCloudCover;
  if (max !== undefined && (!Number.isFinite(max) || max < 0 || max > 100)) throw new RangeError("maxCloudCover must be between 0 and 100");
  const query = max !== undefined && configs.every((c) => c.cloudCoverQueryable) ? { "eo:cloud_cover": { lte: max } } : undefined;

  const { items, truncated } = await stacSearch(client, {
    collections: configs.map((c) => c.collection),
    intersects: q.intersects,
    datetime,
    pageSize: Math.min(limit, 100),
    maxItems: limit,
    query,
    sortby: [{ field: "properties.datetime", direction: "desc" }],
    signal: q.signal,
  });
  if (truncated) log.info("stac search truncated at cap", { provider: client.providerId, product: q.productId, items: items.length });

  const byCollection = new Map(configs.map((c) => [c.collection, c]));
  const out: NormalizedAsset[] = [];
  for (const item of items) {
    const config = (item.collection ? byCollection.get(item.collection) : undefined) ?? (configs.length === 1 ? configs[0] : undefined);
    if (!config) continue;
    const asset = stacItemToAsset(item, { providerId: client.providerId, config, baseUrl: client.baseUrl });
    if (!asset) continue;
    if (max !== undefined && asset.cloudCover !== null && asset.cloudCover > max) continue;
    out.push(asset);
  }
  return out.sort((a, b) => b.acquiredAt.getTime() - a.acquiredAt.getTime());
}

/** The asset file for a canonical key, or a not_found ProviderError naming what is missing. */
export function requireAssetFile(providerId: string, asset: { collection: string; assets: Record<string, AssetFile> }, key: string): AssetFile {
  const file = asset.assets[key];
  if (!file || typeof file.href !== "string" || !/^https?:\/\//i.test(file.href)) {
    throw new ProviderError(providerId, "not_found", `Asset "${key}" is not available for this ${asset.collection} item`, { retryable: false });
  }
  return file;
}

// ── Normalization ─────────────────────────────────────────────

/** "EPSG:32618" | 32618 | "32618" → 32618. Other authorities → null. */
export function parseEpsg(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string") {
    const m = /^(?:EPSG:)?(\d{4,6})$/i.exec(v.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

/** Item → NormalizedAsset, or null when the item lacks an id, footprint, or acquisition time. */
export function stacItemToAsset(
  item: StacItem,
  ctx: { providerId: string; config: StacCollectionConfig; baseUrl?: string },
): NormalizedAsset | null {
  const p = item.properties ?? {};
  const footprint = toFootprint(item.geometry);
  const acquiredAt = parseDate(p.datetime) ?? parseDate(p.start_datetime);
  if (typeof item.id !== "string" || !item.id || !footprint || !acquiredAt) {
    log.warn("stac item skipped: missing id, footprint, or acquisition time", { provider: ctx.providerId, id: item.id ?? null });
    return null;
  }
  const collection = item.collection ?? ctx.config.collection;

  const itemEpsg = parseEpsg(p["proj:epsg"]) ?? parseEpsg(p["proj:code"]);
  const itemShape = toShape(p["proj:shape"]);
  const itemTransform = toTransform(p["proj:transform"]);
  const itemGsd = num(p.gsd);

  const assets: Record<string, AssetFile> = {};
  for (const key of CANONICAL_ASSET_KEYS) {
    const sources = ctx.config.assetMap[key];
    if (!sources) continue;
    for (const src of typeof sources === "string" ? [sources] : sources) {
      const a = item.assets?.[src];
      if (!a) continue;
      const file = toAssetFile(a, { epsg: itemEpsg, shape: itemShape, transform: itemTransform, gsd: itemGsd });
      if (file) {
        assets[key] = file;
        break;
      }
    }
  }

  const assetGsds = Object.values(assets)
    .map((a) => a.gsd)
    .filter((g): g is number => typeof g === "number");
  const gsdM = itemGsd ?? (assetGsds.length ? Math.min(...assetGsds) : null);
  const epsg = itemEpsg ?? Object.values(assets).find((a) => typeof a.epsg === "number")?.epsg ?? null;

  const license = resolveLicense(item, ctx.config.license, acquiredAt);
  const selfLink = item.links?.find((l) => l.rel === "self" && /^https?:\/\//.test(l.href))?.href;
  const stacUrl =
    selfLink ??
    (ctx.baseUrl ? `${trimSlash(ctx.baseUrl)}/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(item.id)}` : null);

  return {
    providerId: ctx.providerId,
    collection,
    externalId: item.id,
    kind: ctx.config.kind,
    platform: str(p.platform),
    instruments: Array.isArray(p.instruments) ? p.instruments.filter((x): x is string => typeof x === "string") : [],
    acquiredAt,
    acquiredEndAt: parseDate(p.end_datetime),
    providerPublishedAt: latest(parseDate(p.created), parseDate(p.updated), parseDate(p.published)),
    footprint,
    cloudCover: num(p["eo:cloud_cover"]),
    gsdM,
    epsg,
    gridCode: gridCodeOf(item) ?? ctx.config.gridCode?.(item) ?? null,
    processingLevel: ctx.config.processingLevel ?? str(p["processing:level"]),
    processingBaseline: str(p["s2:processing_baseline"]) ?? str(p["processing:version"]),
    properties: selectProperties(p),
    assets,
    license: license.license,
    licenseUrl: license.licenseUrl,
    attribution: license.attribution,
    stacUrl,
  };
}

/** Grid identifier from standard STAC properties: grid:code, MGRS, Landsat WRS-2, Sentinel-1 relative orbit. */
export function gridCodeOf(item: StacItem): string | null {
  const p = item.properties ?? {};
  const grid = str(p["grid:code"]);
  if (grid) return grid;
  const zone = p["mgrs:utm_zone"];
  const band = str(p["mgrs:latitude_band"]);
  const square = str(p["mgrs:grid_square"]);
  if ((typeof zone === "number" || typeof zone === "string") && band && square) return `MGRS-${zone}${band}${square}`;
  const s2tile = str(p["s2:mgrs_tile"]);
  if (s2tile && /^\d{1,2}[A-Z]{3}$/.test(s2tile)) return `MGRS-${s2tile}`;
  const path = str(p["landsat:wrs_path"]);
  const row = str(p["landsat:wrs_row"]);
  if (path && row) return `WRS2-${path.padStart(3, "0")}${row.padStart(3, "0")}`;
  const platform = (str(p.platform) ?? str(p.constellation) ?? "").toLowerCase();
  const relOrbit = p["sat:relative_orbit"];
  if (platform.startsWith("sentinel-1") && typeof relOrbit === "number") return `S1-RELORB-${String(relOrbit).padStart(3, "0")}`;
  return null;
}

function toAssetFile(
  a: StacAsset,
  item: { epsg: number | null; shape: [number, number] | undefined; transform: number[] | undefined; gsd: number | null },
): AssetFile | null {
  const href = httpHref(a);
  if (!href) return null;
  const bands = bandsOf(a);
  const firstRes = num((Array.isArray(a["raster:bands"]) ? (a["raster:bands"] as Record<string, unknown>[])[0] : undefined)?.spatial_resolution);
  const gsd = num(a.gsd) ?? firstRes ?? item.gsd ?? undefined;
  const epsg = parseEpsg(a["proj:epsg"]) ?? parseEpsg(a["proj:code"]) ?? item.epsg;
  const file: AssetFile = { href };
  if (typeof a.type === "string") file.type = a.type;
  if (Array.isArray(a.roles)) file.roles = a.roles.filter((r): r is string => typeof r === "string");
  if (bands.length > 0) file.bands = bands;
  if (gsd !== undefined) file.gsd = gsd;
  const shape = toShape(a["proj:shape"]) ?? item.shape;
  if (shape) file.projShape = shape;
  const transform = toTransform(a["proj:transform"]) ?? item.transform;
  if (transform) file.projTransform = transform;
  if (epsg !== null) file.epsg = epsg;
  return file;
}

/** Prefer an http(s) href; fall back to an https alternate (e.g. CDSE s3:// assets). */
function httpHref(a: StacAsset): string | null {
  if (typeof a.href === "string" && /^https?:\/\//i.test(a.href)) return a.href;
  for (const alt of Object.values(a.alternate ?? {})) {
    if (alt && typeof alt.href === "string" && /^https:\/\//i.test(alt.href)) return alt.href;
  }
  return null;
}

/** raster:bands (STAC 1.0) or bands[] / asset-level raster fields (STAC 1.1). */
function bandsOf(a: StacAsset): RasterBandInfo[] {
  const fromEntry = (b: Record<string, unknown>, fallback: Record<string, unknown>): RasterBandInfo => {
    const info: RasterBandInfo = {};
    const scale = num(b.scale) ?? num(b["raster:scale"]) ?? num(fallback["raster:scale"]);
    const offset = num(b.offset) ?? num(b["raster:offset"]) ?? num(fallback["raster:offset"]);
    const nodata = "nodata" in b ? b.nodata : fallback.nodata;
    const dataType = str(b.data_type) ?? str(fallback.data_type);
    const unit = str(b.unit) ?? str(fallback.unit);
    if (scale !== null) info.scale = scale;
    if (offset !== null) info.offset = offset;
    if (typeof nodata === "number") info.nodata = nodata;
    else if (nodata === null) info.nodata = null;
    if (dataType) info.dataType = dataType;
    if (unit) info.unit = unit;
    return info;
  };
  const raster = a["raster:bands"];
  if (Array.isArray(raster) && raster.length > 0) {
    return raster.filter(isRecord).map((b) => fromEntry(b, {}));
  }
  const assetLevel = a as Record<string, unknown>;
  const hasAssetLevel = ["raster:scale", "raster:offset", "nodata", "data_type"].some((k) => k in assetLevel);
  const bands = a.bands;
  if (Array.isArray(bands) && bands.length > 0) {
    const mapped = bands.filter(isRecord).map((b) => fromEntry(b, assetLevel));
    return mapped.some((b) => Object.keys(b).length > 0) ? mapped : [];
  }
  if (hasAssetLevel) {
    const one = fromEntry({}, assetLevel);
    return Object.keys(one).length > 0 ? [one] : [];
  }
  return [];
}

const PLACEHOLDER_LICENSES = new Set(["proprietary", "other", "various"]);

function resolveLicense(item: StacItem, fallback: CollectionLicense, acquiredAt: Date): CollectionLicense {
  const itemLicense = str(item.properties?.license);
  const link = item.links?.find((l) => l.rel === "license" && typeof l.href === "string")?.href ?? null;
  const usableItemLicense = itemLicense && !PLACEHOLDER_LICENSES.has(itemLicense.toLowerCase()) ? itemLicense : null;
  const year = String(acquiredAt.getUTCFullYear());
  // Keep licence text and URL from the same source so they never contradict each other.
  return {
    license: usableItemLicense ?? fallback.license,
    licenseUrl: usableItemLicense ? (link ?? fallback.licenseUrl) : (fallback.licenseUrl ?? link),
    attribution: fallback.attribution ? fallback.attribution.replaceAll("[year]", year) : null,
  };
}

const DROP_PROPERTY = /^(_|storage:|auth:|processing:software$|statistics$|description$)/;

/**
 * Properties downstream processing depends on; always copied verbatim.
 * earthsearch:boa_offset_applied tells the raster pipeline that the published
 * raster:bands offset is already applied to the pixel values.
 */
export const ALWAYS_KEPT_PROPERTIES = ["earthsearch:boa_offset_applied", "s2:processing_baseline", "processing:version"] as const;

/** Keep scalar properties and short scalar arrays, for provenance. */
function selectProperties(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALWAYS_KEPT_PROPERTIES) if (Object.hasOwn(p, k)) out[k] = p[k];
  for (const [k, v] of Object.entries(p)) {
    if (DROP_PROPERTY.test(k) || Object.hasOwn(out, k)) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.length <= 16 && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) out[k] = v;
  }
  return out;
}

function toFootprint(g: unknown): Geometry | null {
  if (!isRecord(g)) return null;
  const isPos = (p: unknown): p is Position =>
    Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const isRing = (r: unknown): r is Position[] => Array.isArray(r) && r.length >= 4 && r.every(isPos);
  const trim = (r: Position[]): Position[] => r.map((p) => [p[0], p[1]]);
  if (g.type === "Polygon" && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(isRing)) {
    return { type: "Polygon", coordinates: (g.coordinates as Position[][]).map(trim) };
  }
  if (
    g.type === "MultiPolygon" &&
    Array.isArray(g.coordinates) &&
    g.coordinates.length > 0 &&
    g.coordinates.every((poly) => Array.isArray(poly) && poly.length > 0 && poly.every(isRing))
  ) {
    return { type: "MultiPolygon", coordinates: (g.coordinates as Position[][][]).map((poly) => poly.map(trim)) };
  }
  return null;
}

function toShape(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)
    ? [v[0] as number, v[1] as number]
    : undefined;
}

/** Affine transform; a 3×3 form whose last row is [0, 0, 1] is reduced to its first six terms. */
function toTransform(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || !v.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  if (v.length === 6) return v as number[];
  if (v.length === 9 && v[6] === 0 && v[7] === 0 && v[8] === 1) return (v as number[]).slice(0, 6);
  return undefined;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function latest(...dates: (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
