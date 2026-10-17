/**
 * Provider-independent contracts. The core platform depends only on these
 * types; each external source is an adapter behind them, so no workflow is
 * tied to a single satellite, weather, or news provider.
 */
import type { Geometry } from "@/lib/geo";

export type ProviderKind = "imagery" | "weather" | "news" | "reference" | "geocoding" | "basemap";

export type ProductKind = "optical" | "sar" | "landcover" | "elevation" | "weather" | "news" | "vector" | "raster_tiles";

export type ProductDescriptor = {
  /** Globally unique product id, "<provider>:<collection>", e.g. "earth-search:sentinel-2-l2a". */
  id: string;
  name: string;
  collection: string;
  kind: ProductKind;
  /** Best native ground sample distance in metres, when applicable. */
  gsdM?: number;
  /** Typical revisit at mid-latitudes, in days, when applicable. */
  revisitDays?: number;
  /** Analytic model ids that can consume this product. */
  analytics: string[];
  capabilities: { search: boolean; assetAccess: boolean };
  notes?: string;
};

export type Licensing = {
  summary: string;
  url?: string;
  /** What may be redistributed in exports and reports. */
  redistribution: string;
  commercialUse: "allowed" | "restricted" | "requires_license";
  attribution?: string;
};

export type ProviderDescriptor = {
  id: string;
  name: string;
  kind: ProviderKind;
  operator: string;
  homepage: string;
  docsUrl?: string;
  products: ProductDescriptor[];
  licensing: Licensing;
  credentials: { required: boolean; envVars: string[] };
  updateCadence: string;
  /** None of the current providers push notifications; ORYN polls on a schedule. */
  delivery: "polling";
  rateLimit?: string;
};

export type ProviderAvailability =
  | { state: "available" }
  | { state: "unconfigured"; reason: string }
  | { state: "disabled"; reason: string };

export type HealthResult = { ok: boolean; latencyMs: number; message?: string; details?: Record<string, unknown> };

// ── Imagery ───────────────────────────────────────────────────

export type RasterBandInfo = { scale?: number; offset?: number; nodata?: number | null; dataType?: string; unit?: string };

export type AssetFile = {
  href: string;
  type?: string;
  roles?: string[];
  bands?: RasterBandInfo[];
  gsd?: number;
  projShape?: [number, number];
  projTransform?: number[];
  epsg?: number;
};

/** A catalog item normalized across providers. Persisted to source_assets. */
export type NormalizedAsset = {
  providerId: string;
  collection: string;
  externalId: string;
  kind: "optical" | "sar" | "landcover" | "elevation" | "other";
  platform: string | null;
  instruments: string[];
  acquiredAt: Date;
  acquiredEndAt: Date | null;
  providerPublishedAt: Date | null;
  footprint: Geometry;
  cloudCover: number | null;
  gsdM: number | null;
  epsg: number | null;
  gridCode: string | null;
  processingLevel: string | null;
  processingBaseline: string | null;
  /** Selected provider properties, kept for provenance. */
  properties: Record<string, unknown>;
  /** Canonical asset keys used by ORYN analytics (red, nir, green, swir16, scl, qa_pixel, vv, vh, visual, map, …). */
  assets: Record<string, AssetFile>;
  license: string | null;
  licenseUrl: string | null;
  attribution: string | null;
  stacUrl: string | null;
};

export type ImagerySearch = {
  productId: string;
  intersects: Geometry;
  start: Date;
  end: Date;
  maxCloudCover?: number;
  limit?: number;
  signal?: AbortSignal;
};

/** How the server reads an asset with HTTP range requests: a (possibly signed) URL and any required headers. */
export type AssetAccess = { url: string; headers?: Record<string, string> };

export interface ImageryProvider {
  descriptor: ProviderDescriptor;
  availability(): ProviderAvailability;
  search(q: ImagerySearch): Promise<NormalizedAsset[]>;
  /**
   * Resolve read access for one asset key (e.g. "red"). Signs URLs or adds
   * auth headers when the provider requires it. Throws a ProviderError with
   * code "unconfigured" when credentials are missing.
   */
  resolveAccess(asset: { collection: string; assets: Record<string, AssetFile> }, key: string, signal?: AbortSignal): Promise<AssetAccess>;
  health(signal?: AbortSignal): Promise<HealthResult>;
}

// ── Weather ───────────────────────────────────────────────────

export type WeatherRecordKind = "observation" | "forecast" | "model_estimate";

export type WeatherRecord = {
  providerId: string;
  recordKind: WeatherRecordKind;
  variable: string;
  value: number | null;
  unit: string;
  validFrom: Date;
  validTo: Date;
  issuedAt: Date | null;
  stationId: string | null;
  stationDistanceKm: number | null;
  sourceUrl: string | null;
};

export type WeatherWarning = {
  providerId: string;
  externalId: string;
  title: string;
  description: string | null;
  severity: string | null;
  certainty: string | null;
  urgency: string | null;
  category: string | null;
  geometry: Geometry | null;
  start: Date | null;
  end: Date | null;
  publishedAt: Date | null;
  sourceUrl: string | null;
};

// ── News ──────────────────────────────────────────────────────

export type NewsArticle = {
  providerId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string | null;
  language: string | null;
  sourceCountry: string | null;
  publishedAt: Date | null;
  titleFingerprint: string;
};

// ── Reference & geocoding ─────────────────────────────────────

export type ReferenceFeature = { externalId: string; geometry: Geometry; properties: Record<string, unknown> };

export type GeocodeResult = {
  label: string;
  position: [number, number];
  bbox?: [number, number, number, number];
  kind: "address" | "place" | "coordinates" | "aoi";
  source: string;
  aoiId?: string;
};
