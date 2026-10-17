/**
 * Report assembly: load STORED data for a report (loadReportSource) and
 * build the frozen content snapshot from it (buildReportContent, pure).
 *
 * Guarantees
 *  - Only stored rows are used; nothing is fetched from providers and no
 *    value is estimated or filled in. Missing or stale data is stated in the
 *    section's statement (e.g. "Latest usable imagery is 23 days old").
 *  - Every number is attached to an evidence id resolving to source rows.
 *  - Unusable observations are listed with their reasons, never dropped.
 *  - Observation, model-estimate, and forecast weather are summarized
 *    separately; official warnings and news claims are kept apart, and news
 *    is labelled as claims with independent-source counts (distinct
 *    publishing domains per story).
 *  - All queries filter by org_id explicitly in addition to RLS.
 */
import { currentModelKeys } from "@/server/analytics/registry";
import { formatArea } from "@/lib/geo";
import { WEATHER_VARIABLES, type ObservationQuality, type RasterRef } from "@/server/analytics/types";
import { dailySeries, type EvalWeather } from "@/server/alerts/evaluate";
import { WEATHER_KIND_CAVEAT } from "@/server/alerts/explain";
import type { Tx } from "@/server/db/client";
import type {
  AlertEntry,
  AuditEntry,
  DataStatus,
  DetectionEntry,
  EvidenceEntry,
  EvidenceKind,
  Finding,
  ModelLimitation,
  NewsStory,
  ObservationEntry,
  ProcessingRunEntry,
  ReportContent,
  ReportedEventEntry,
  ReportSectionKey,
  ReportType,
  SectionStatement,
  SourceAssetEntry,
  WarningEntry,
  WeatherKind,
  WeatherKindSummary,
  WeatherVariableSummary,
} from "@/server/reports/types";

const DAY_MS = 86_400_000;
/** Imagery older than this (days) at generation time is reported as stale. */
export const STALE_IMAGERY_DAYS = 10;
/** Forecasts retrieved longer ago than this (days) are reported as possibly outdated. */
export const STALE_FORECAST_DAYS = 2;

export const NEWS_NOTE =
  "News reports are claims made by publishers; ORYN has not verified them. \"Independent sources\" counts distinct publishing domains per story — syndicated copies on the same domain count once, and several domains repeating one wire story are not proof that the event occurred.";

// ── Source rows (as loaded from the database) ──────────────────

export type ObservationSourceRow = {
  id: string;
  aoi_id: string;
  kind: string;
  model_id: string;
  model_version: string;
  result_class: string;
  status: "valid" | "unusable";
  observed_at: Date;
  processed_at: Date;
  is_current: boolean;
  metrics: Record<string, unknown>;
  quality: Partial<ObservationQuality>;
  raster: Partial<RasterRef> | null;
  asset_id: string;
  provider_id: string;
  collection: string;
  platform: string | null;
};

export type ReportSource = {
  report: { id: string; type: ReportType; title: string; params: Record<string, unknown>; from: Date; to: Date; generatedAt: Date };
  sections: ReportSectionKey[];
  org: { id: string; name: string; slug: string; kind: string; is_synthetic: boolean };
  aoi: {
    id: string;
    name: string;
    kind: string;
    status: string;
    area_m2: number;
    lon: number | null;
    lat: number | null;
    bbox: [number, number, number, number] | null;
    geometry: { type: string; coordinates: unknown } | null;
    boundary_source: Record<string, unknown>;
    is_synthetic: boolean;
    created_at: Date;
  } | null;
  observations: ObservationSourceRow[];
  latestValid: ObservationSourceRow | null;
  detections: {
    id: string;
    type: string;
    title: string;
    result_class: string;
    area_m2: number | null;
    model_id: string | null;
    model_version: string | null;
    baseline_observed_at: Date | null;
    comparison_observed_at: Date | null;
    created_at: Date;
    evidence_grade: string;
    evidence_reasons: string[];
    verification_status: string;
    metrics: Record<string, unknown>;
    source_asset_ids: string[];
  }[];
  weather: {
    id: string;
    provider_id: string;
    record_kind: WeatherKind;
    variable: string;
    value: number | null;
    unit: string;
    valid_from: Date;
    valid_to: Date;
    issued_at: Date | null;
    retrieved_at: Date;
    station_id: string | null;
    station_distance_km: number | null;
  }[];
  warnings: {
    id: string;
    provider_id: string;
    title: string;
    severity: string | null;
    certainty: string | null;
    urgency: string | null;
    event_start: Date | null;
    event_end: Date | null;
    published_at: Date | null;
    source_url: string | null;
    claim_status: string;
  }[];
  news: {
    article_id: string;
    story_key: string;
    category: string;
    location_match: string;
    title: string;
    domain: string | null;
    url: string;
    provider_id: string;
    published_at: Date | null;
  }[];
  reportedEvents: { id: string; provider_id: string; title: string; published_at: Date | null; source_url: string | null; claim_status: string }[];
  alerts: {
    id: string;
    title: string;
    severity: string;
    status: string;
    basis: string | null;
    observed_at: Date | null;
    created_at: Date;
    from_reprocessing: boolean;
  }[];
  runs: {
    id: string;
    aoi_id: string;
    model_id: string;
    model_version: string;
    status: string;
    started_at: Date;
    finished_at: Date | null;
    input_asset_ids: string[];
    messages: string[];
    error: string | null;
    software_version: string;
  }[];
  assets: {
    id: string;
    provider_id: string;
    collection: string;
    external_id: string;
    platform: string | null;
    acquired_at: Date;
    cloud_cover: number | null;
    license: string | null;
    license_url: string | null;
    attribution: string | null;
    stac_url: string | null;
  }[];
  models: { id: string; version: string; name: string; result_class: string; limitations: string[] }[];
  audit: { id: string; created_at: Date; actor_type: string; actor_label: string | null; action: string; target_type: string | null; target_id: string | null }[];
};

// ── Loading ────────────────────────────────────────────────────

export type ReportRequest = {
  orgId: string;
  reportId: string;
  type: ReportType;
  title: string;
  aoiId: string | null;
  params: Record<string, unknown>;
  sections: ReportSectionKey[];
  /** AOIs the requester could see (null = all); applies to org-wide reports. */
  scopeAoiIds: string[] | null;
};

export function reportPeriod(params: Record<string, unknown>, generatedAt: Date): { from: Date; to: Date } {
  const parse = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
  const to = parse(params.to) ?? generatedAt;
  const from = parse(params.from) ?? new Date(to.getTime() - 90 * DAY_MS);
  return { from, to };
}

export async function loadReportSource(tx: Tx, req: ReportRequest): Promise<ReportSource> {
  const { orgId, aoiId } = req;
  const [clock] = await tx<{ now: Date }[]>`select now() as now`;
  const generatedAt = clock!.now;
  const { from, to } = reportPeriod(req.params, generatedAt);
  const has = (s: ReportSectionKey) => req.sections.includes(s);
  // Every section query aliases its table as x.
  const aoiFilter = (q: Tx) =>
    aoiId ? q`and x.aoi_id = ${aoiId}` : req.scopeAoiIds ? q`and x.aoi_id = any(${req.scopeAoiIds}::uuid[])` : q``;

  const [org] = await tx<ReportSource["org"][]>`
    select id, name, slug::text as slug, kind::text as kind, is_synthetic from organizations where id = ${orgId}`;
  if (!org) throw new Error("Organization not found for report.");

  let aoi: ReportSource["aoi"] = null;
  if (aoiId) {
    const [a] = await tx<(Omit<NonNullable<ReportSource["aoi"]>, "bbox"> & { xmin: number; ymin: number; xmax: number; ymax: number })[]>`
      select id, name, kind::text as kind, status::text as status, area_m2, ST_X(label_point) as lon, ST_Y(label_point) as lat,
             ST_XMin(geom) as xmin, ST_YMin(geom) as ymin, ST_XMax(geom) as xmax, ST_YMax(geom) as ymax,
             ST_AsGeoJSON(geom, 7)::jsonb as geometry, boundary_source, is_synthetic, created_at
        from aois where id = ${aoiId} and org_id = ${orgId}`;
    if (!a) throw new Error("AOI not found for report.");
    const { xmin, ymin, xmax, ymax, ...rest } = a;
    aoi = { ...rest, bbox: [xmin, ymin, xmax, ymax] };
  }

  const obsCols = tx`
    x.id, x.aoi_id, x.kind, x.model_id, x.model_version, x.result_class, x.status, x.observed_at, x.processed_at, x.is_current,
    x.metrics, x.quality, x.raster, x.asset_id, s.provider_id, s.collection, s.platform`;
  const needObs = has("observations") || has("processing");
  const observations = needObs
    ? await tx<ObservationSourceRow[]>`
        select ${obsCols} from observations x join source_assets s on s.id = x.asset_id
         where x.org_id = ${orgId} ${aoiFilter(tx)} and x.is_current
           and x.observed_at >= ${from} and x.observed_at <= ${to}
         order by x.observed_at, x.id
         limit 1000`
    : [];
  const [latestValid] = aoiId
    ? await tx<ObservationSourceRow[]>`
        select ${obsCols} from observations x join source_assets s on s.id = x.asset_id
         where x.org_id = ${orgId} and x.aoi_id = ${aoiId} and x.is_current and x.status = 'valid'
         order by x.observed_at desc, x.id limit 1`
    : [];

  const detections = has("detections")
    ? await tx<ReportSource["detections"]>`
        select x.id, x.type, x.title, x.result_class, x.area_m2, x.model_id, x.model_version, x.baseline_observed_at,
               x.comparison_observed_at, x.created_at, x.evidence_grade, x.evidence_reasons, x.verification_status, x.metrics,
               x.source_asset_ids
          from detections x
         where x.org_id = ${orgId} ${aoiFilter(tx)}
           and coalesce(x.comparison_observed_at, x.last_observed_at) between ${from} and ${to}
           -- Results of superseded method versions are history, not current findings.
           and (x.model_id is null or x.model_id || '@' || x.model_version = any(${currentModelKeys()}))
         order by coalesce(x.comparison_observed_at, x.last_observed_at), x.id
         limit 300`
    : [];

  const weather = has("weather")
    ? await tx<ReportSource["weather"]>`
        select x.id::text as id, x.provider_id, x.record_kind, x.variable, x.value, x.unit, x.valid_from, x.valid_to,
               x.issued_at, x.retrieved_at, x.station_id, x.station_distance_km
          from weather_records x
         where x.org_id = ${orgId} ${aoiFilter(tx)}
           and ((x.record_kind in ('observation', 'model_estimate') and x.valid_from >= ${from} and x.valid_from <= ${to})
             or (x.record_kind = 'forecast' and x.valid_from >= date_trunc('day', ${generatedAt}::timestamptz)
                 and x.valid_from <= ${generatedAt}::timestamptz + interval '16 days'))
         order by x.valid_from, x.id
         limit 20000`
    : [];

  const warnings = has("warnings")
    ? await tx<ReportSource["warnings"]>`
        select x.id, x.provider_id, x.title, x.severity, x.certainty, x.urgency, x.event_start, x.event_end, x.published_at,
               x.source_url, x.claim_status
          from external_events x
         where x.org_id = ${orgId} ${aoiFilter(tx)} and x.event_kind = 'weather_warning'
           and (coalesce(x.published_at, x.retrieved_at) between ${from} and ${to}
                or (coalesce(x.event_end, 'infinity'::timestamptz) > ${generatedAt} and coalesce(x.published_at, x.retrieved_at) <= ${generatedAt}))
         order by coalesce(x.published_at, x.retrieved_at), x.id
         limit 200`
    : [];

  const news = has("news")
    ? await tx<ReportSource["news"]>`
        select n.id as article_id, x.story_key, x.category, x.location_match, n.title, n.domain, n.url, n.provider_id, n.published_at
          from aoi_news_matches x join news_articles n on n.id = x.article_id
         where x.org_id = ${orgId} ${aoiFilter(tx)}
           and coalesce(n.published_at, x.created_at) between ${from} and ${to}
         order by x.story_key, n.published_at nulls last, n.id
         limit 500`
    : [];
  const reportedEvents = has("news")
    ? await tx<ReportSource["reportedEvents"]>`
        select x.id, x.provider_id, x.title, x.published_at, x.source_url, x.claim_status
          from external_events x
         where x.org_id = ${orgId} ${aoiFilter(tx)} and x.event_kind = 'news_report'
           and coalesce(x.published_at, x.retrieved_at) between ${from} and ${to}
         order by x.published_at nulls last, x.id
         limit 200`
    : [];

  const alerts = has("alerts")
    ? await tx<ReportSource["alerts"]>`
        select x.id, x.title, x.severity, x.status, x.explanation->>'basis' as basis, x.observed_at, x.created_at, x.from_reprocessing
          from alerts x
         where x.org_id = ${orgId} ${aoiFilter(tx)} and x.status in ('open', 'acknowledged')
         order by x.created_at desc, x.id
         limit 200`
    : [];

  const runs = has("processing")
    ? await tx<ReportSource["runs"]>`
        select x.id, x.aoi_id, x.model_id, x.model_version, x.status, x.started_at, x.finished_at, x.input_asset_ids, x.messages,
               x.error, x.software_version
          from processing_runs x
         where x.org_id = ${orgId} ${aoiFilter(tx)} and x.started_at between ${from} and ${to}
         order by x.started_at, x.id
         limit 500`
    : [];

  const assetIds = [
    ...new Set([...observations.map((o) => o.asset_id), ...(latestValid ? [latestValid.asset_id] : []), ...detections.flatMap((d) => d.source_asset_ids)]),
  ];
  const assets = assetIds.length
    ? await tx<ReportSource["assets"]>`
        select id, provider_id, collection, external_id, platform, acquired_at, cloud_cover::float8 as cloud_cover, license, license_url,
               attribution, stac_url
          from source_assets where id = any(${assetIds}::uuid[])
         order by acquired_at, id`
    : [];

  const modelKeys = [
    ...new Set([
      ...observations.map((o) => `${o.model_id}@${o.model_version}`),
      ...(latestValid ? [`${latestValid.model_id}@${latestValid.model_version}`] : []),
      ...detections.filter((d) => d.model_id && d.model_version).map((d) => `${d.model_id}@${d.model_version}`),
      ...runs.map((r) => `${r.model_id}@${r.model_version}`),
    ]),
  ];
  const models = modelKeys.length
    ? await tx<ReportSource["models"]>`
        select id, version, name, result_class, limitations from analytic_models
         where (id || '@' || version) = any(${modelKeys})
         order by id, version`
    : [];

  const audit = has("audit")
    ? await tx<ReportSource["audit"]>`
        select id::text as id, created_at, actor_type, actor_label, action, target_type, target_id
          from audit_events
         where org_id = ${orgId} and created_at between ${from} and ${to}
         order by created_at, id
         limit 2000`
    : [];

  return {
    report: { id: req.reportId, type: req.type, title: req.title, params: req.params, from, to, generatedAt },
    sections: req.sections,
    org,
    aoi,
    observations,
    latestValid: latestValid ?? null,
    detections,
    weather,
    warnings,
    news,
    reportedEvents,
    alerts,
    runs,
    assets,
    models,
    audit,
  };
}

// ── Building (pure) ────────────────────────────────────────────

class EvidenceIndex {
  readonly entries: Record<string, EvidenceEntry> = {};
  private n = 0;
  private l = 0;
  private byKey = new Map<string, string>();

  add(kind: EvidenceKind, table: string | null, rowIds: string[], label: string): string {
    // Limitations are keyed by their text: one model contributes several.
    const key = `${kind}:${table}:${rowIds.join(",")}${kind === "limitation" ? `:${label}` : ""}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = kind === "limitation" ? `L${++this.l}` : `E${++this.n}`;
    this.entries[id] = { id, kind, table, row_ids: rowIds, label };
    this.byKey.set(key, id);
    return id;
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

function scalarMetrics(m: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m ?? {})) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function rasterSummary(r: Partial<RasterRef> | null): ObservationEntry["raster"] {
  if (!r || !r.png_key || !r.corners || !r.legend) return null;
  return { png_key: r.png_key, corners: r.corners, legend: r.legend, width: r.width ?? 0, height: r.height ?? 0, epsg: r.epsg ?? 0 };
}

function obsLabel(o: ObservationSourceRow): string {
  return `${o.kind.toUpperCase()} ${o.status} observation, ${o.collection} acquired ${dayOf(o.observed_at)} (${o.model_id}@${o.model_version})`;
}

export function buildReportContent(src: ReportSource): ReportContent {
  const ev = new EvidenceIndex();
  const findings: Finding[] = [];
  const addFinding = (section: string, text: string, evidenceIds: string[]) =>
    findings.push({ id: `F${findings.length + 1}`, section, text, evidence_ids: [...new Set(evidenceIds)] });
  const gen = src.report.generatedAt;
  const has = (s: ReportSectionKey) => src.sections.includes(s);

  // AOI
  let aoi: ReportContent["aoi"] = null;
  if (src.aoi) {
    const a = src.aoi;
    const eid = ev.add("aoi", "aois", [a.id], `AOI "${a.name}"`);
    aoi = {
      id: a.id,
      name: a.name,
      kind: a.kind,
      status: a.status,
      area_m2: a.area_m2,
      area_text: formatArea(a.area_m2),
      centroid: a.lon != null && a.lat != null ? [a.lon, a.lat] : null,
      bbox: a.bbox,
      geometry: a.geometry,
      boundary_source: a.boundary_source ?? {},
      is_synthetic: a.is_synthetic,
      created_at: a.created_at.toISOString(),
      evidence_id: eid,
    };
    const method = typeof a.boundary_source?.method === "string" ? ` Boundary source: ${a.boundary_source.method}.` : "";
    addFinding(
      "aoi",
      `${a.name} covers ${formatArea(a.area_m2)}.${method}${a.is_synthetic ? " The boundary is a development placeholder, not a surveyed boundary." : ""}`,
      [eid],
    );
  }

  // Observations
  const obsEntry = (o: ObservationSourceRow): ObservationEntry => ({
    evidence_id: ev.add("observation", "observations", [o.id], obsLabel(o)),
    observation_id: o.id,
    kind: o.kind,
    model_id: o.model_id,
    model_version: o.model_version,
    result_class: o.result_class,
    provider_id: o.provider_id,
    collection: o.collection,
    platform: o.platform,
    asset_id: o.asset_id,
    observed_at: o.observed_at.toISOString(),
    processed_at: o.processed_at.toISOString(),
    status: o.status,
    unusable_reason: o.status === "unusable" ? (o.quality?.unusable_reason ?? "reason not recorded") : null,
    is_current: o.is_current,
    metrics: scalarMetrics(o.metrics),
    quality: {
      coverage_fraction: o.quality?.coverage_fraction ?? null,
      masked_fraction: o.quality?.masked_fraction ?? null,
      scene_cloud_cover: o.quality?.scene_cloud_cover ?? null,
      flags: o.quality?.flags ?? [],
    },
    raster: rasterSummary(o.raster),
  });

  const latestValid = src.latestValid;
  const ageDays = latestValid ? Math.floor((gen.getTime() - latestValid.observed_at.getTime()) / DAY_MS) : null;
  let currencyStatus: DataStatus = "ok";
  let currency: string;
  if (!src.aoi) {
    currency = `Organization-wide report generated ${gen.toISOString().slice(0, 16).replace("T", " ")} UTC from data stored at that time.`;
  } else if (!latestValid) {
    currencyStatus = "missing";
    currency = "No usable imagery has been processed for this AOI; no imagery-derived values are reported.";
  } else if (ageDays! > STALE_IMAGERY_DAYS) {
    currencyStatus = "stale";
    currency = `Latest usable imagery is ${ageDays} days old (acquired ${dayOf(latestValid.observed_at)}); conditions may have changed since.`;
  } else {
    currency = `Latest usable imagery was acquired ${dayOf(latestValid.observed_at)} (${ageDays} day${ageDays === 1 ? "" : "s"} before this report).`;
  }

  let observations: ReportContent["observations"] = null;
  if (has("observations")) {
    const series = src.observations.map(obsEntry);
    const latestEntry = latestValid ? (series.find((s) => s.observation_id === latestValid.id) ?? obsEntry(latestValid)) : null;
    const unusable = series.filter((s) => s.status === "unusable");
    const kinds = [...new Set(series.map((s) => s.kind))];
    const statement: SectionStatement =
      series.length === 0
        ? {
            status: "missing",
            text: `No observations were recorded between ${dayOf(src.report.from)} and ${dayOf(src.report.to)}.${latestValid && src.aoi ? ` ${currency}` : ""}`,
          }
        : { status: currencyStatus === "stale" ? "stale" : "ok", text: `${series.length} observation(s) in the period (${unusable.length} unusable). ${src.aoi ? currency : ""}`.trim() };
    if (src.aoi && !latestValid && series.length > 0) statement.status = "missing";
    observations = {
      statement,
      series,
      latest: latestEntry,
      unusable_count: unusable.length,
      by_kind: kinds.map((k) => {
        const ofKind = series.filter((s) => s.kind === k);
        const valid = ofKind.filter((s) => s.status === "valid");
        return { kind: k, valid: valid.length, unusable: ofKind.length - valid.length, latest_valid_at: valid[valid.length - 1]?.observed_at ?? null };
      }),
    };

    if (src.aoi) addFinding("data_currency", currency, latestEntry ? [latestEntry.evidence_id] : aoi ? [aoi.evidence_id] : []);
    if (latestEntry && typeof latestEntry.metrics.mean === "number" && latestEntry.kind === "ndvi") {
      const m = latestEntry.metrics;
      const spread = typeof m.p10 === "number" && typeof m.p90 === "number" ? ` (10th–90th percentile ${round(m.p10)}–${round(m.p90)})` : "";
      const usable = typeof m.valid_fraction === "number" ? `; ${Math.round(m.valid_fraction * 100)}% of AOI pixels usable` : "";
      addFinding("observations", `Latest usable NDVI (${latestEntry.collection}, acquired ${latestEntry.observed_at.slice(0, 10)}): mean ${round(m.mean!)}${spread}${usable}.`, [latestEntry.evidence_id]);
    }
    const ndviValid = series.filter((s) => s.kind === "ndvi" && s.status === "valid" && typeof s.metrics.mean === "number");
    if (ndviValid.length >= 2) {
      // Range, not first-vs-last: over a growing season the two ends can both be bare soil.
      const last = ndviValid[ndviValid.length - 1]!;
      const sameFamily = ndviValid.filter((s) => s.collection === last.collection);
      if (sameFamily.length >= 2) {
        const low = sameFamily.reduce((a, b) => (b.metrics.mean! < a.metrics.mean! ? b : a));
        const high = sameFamily.reduce((a, b) => (b.metrics.mean! > a.metrics.mean! ? b : a));
        addFinding(
          "observations",
          `Mean NDVI (${last.collection}) across ${sameFamily.length} usable observations: lowest ${round(low.metrics.mean!)} on ${low.observed_at.slice(0, 10)}, ` +
            `highest ${round(high.metrics.mean!)} on ${high.observed_at.slice(0, 10)}, latest ${round(last.metrics.mean!)} on ${last.observed_at.slice(0, 10)}.`,
          [...new Set([low.evidence_id, high.evidence_id, last.evidence_id])],
        );
      }
    }
    const water = series.filter((s) => (s.kind === "ndwi" || s.kind === "s1_water") && s.status === "valid" && typeof s.metrics.water_area_m2 === "number");
    const lastWater = water[water.length - 1];
    if (lastWater) {
      addFinding("observations", `Latest open-water candidate area (${lastWater.kind}, ${lastWater.observed_at.slice(0, 10)}): ${formatArea(lastWater.metrics.water_area_m2!)}.`, [lastWater.evidence_id]);
    }
    // Images, not observations: one image yields several analyses (NDVI, NDMI, …), and derived
    // scores (e.g. an anomaly without enough history) say nothing about the image itself.
    const IMAGE_KINDS = new Set(["ndvi", "ndmi", "ndwi", "s1_water", "landcover"]);
    const images = new Map<string, typeof series>();
    for (const e of series.filter((x) => IMAGE_KINDS.has(x.kind))) images.set(e.asset_id, [...(images.get(e.asset_id) ?? []), e]);
    const unusableImages = [...images.values()].filter((es) => es.every((e) => e.status !== "valid")).map((es) => es[0]!);
    if (unusableImages.length) {
      const reasons = [...new Set(unusableImages.map((u) => u.unusable_reason).filter(Boolean))].slice(0, 3).join("; ");
      addFinding(
        "observations",
        `${unusableImages.length} of ${images.size} images in the period were unusable for analysis (${reasons}).`,
        unusableImages.slice(0, 6).map((u) => u.evidence_id),
      );
    }
  } else if (src.aoi) {
    addFinding("data_currency", currency, aoi ? [aoi.evidence_id] : []);
  }

  // Detections
  let detections: ReportContent["detections"] = null;
  if (has("detections")) {
    const items: DetectionEntry[] = src.detections.map((d) => ({
      evidence_id: ev.add("detection", "detections", [d.id], `Detection "${d.title}" (${d.type}, evidence ${d.evidence_grade}, ${d.verification_status})`),
      detection_id: d.id,
      type: d.type,
      title: d.title,
      result_class: d.result_class,
      area_m2: d.area_m2,
      model_id: d.model_id,
      model_version: d.model_version,
      baseline_observed_at: iso(d.baseline_observed_at),
      comparison_observed_at: iso(d.comparison_observed_at),
      created_at: d.created_at.toISOString(),
      evidence_grade: d.evidence_grade,
      evidence_reasons: d.evidence_reasons ?? [],
      verification_status: d.verification_status,
      direction: typeof d.metrics?.direction === "string" ? d.metrics.direction : null,
      mean_delta: typeof d.metrics?.mean_delta === "number" ? d.metrics.mean_delta : null,
    }));
    detections = {
      items,
      statement: items.length
        ? { status: "ok", text: `${items.length} detection(s) recorded for observations acquired in the period. Candidate changes are not confirmed unless verified.` }
        : { status: currencyStatus === "missing" ? "missing" : "ok", text: `No detections were recorded for observations acquired in the period${currencyStatus === "missing" ? " (no usable imagery was available to compare)" : ""}.` },
    };
    const gradeText = (xs: DetectionEntry[]) =>
      ["strong", "moderate", "weak", "insufficient"]
        .map((g) => [g, xs.filter((i) => i.evidence_grade === g).length] as const)
        .filter(([, n]) => n > 0)
        .map(([g, n]) => `${n} ${g}`)
        .join(", ");
    const reviewText = (xs: DetectionEntry[]) =>
      `${xs.filter((i) => i.verification_status === "confirmed").length} confirmed and ${xs.filter((i) => i.verification_status === "dismissed").length} dismissed by reviewers, the rest unverified`;
    // Within-field zones are single-date findings, not changes: reported separately.
    const zones = items.filter((i) => i.type === "low_vigor_zone");
    const changes = items.filter((i) => i.type !== "low_vigor_zone");
    if (changes.length) {
      addFinding(
        "detections",
        `${changes.length} candidate change(s) recorded (${gradeText(changes)} evidence); ${reviewText(changes)}.`,
        changes.slice(0, 8).map((i) => i.evidence_id),
      );
    }
    if (zones.length) {
      const metricsOf = (id: string) => src.detections.find((d) => d.id === id)?.metrics ?? {};
      const persistent = zones.filter((z) => (metricsOf(z.detection_id).persistence as { state?: string } | undefined)?.state === "persistent").length;
      const top = [...zones].sort((a, b) => Number(metricsOf(b.detection_id).score ?? 0) - Number(metricsOf(a.detection_id).score ?? 0)).slice(0, 5);
      addFinding(
        "detections",
        `${zones.length} within-field low-vigour zone(s) recorded (${gradeText(zones)} evidence), ${persistent} of them also low in the previous usable image; ${reviewText(zones)}. ` +
          `Largest by area × NDVI deficit: ${top.map((z) => `"${z.title}" (${z.comparison_observed_at ? z.comparison_observed_at.slice(0, 10) : "date unknown"})`).join("; ")}. ` +
          "A zone marks NDVI that is low relative to the rest of the area on that date; it calls for a field check and is not a diagnosis.",
        top.map((z) => z.evidence_id),
      );
    }
  }

  // Weather
  let weather: ReportContent["weather"] = null;
  if (has("weather")) {
    const kinds: WeatherKind[] = ["observation", "model_estimate", "forecast"];
    const summaries = kinds.map((k) => summarizeWeatherKind(k, src, ev));
    const any = summaries.some((s) => s.variables.length > 0);
    weather = {
      kinds: summaries,
      // Per-kind statements carry missing/stale status; this one only frames the section.
      statement: any
        ? { status: "ok", text: "Observations, model estimates, and forecasts are summarized separately and are not interchangeable." }
        : { status: "missing", text: "No weather records are stored for this AOI and period." },
    };
    for (const s of summaries) {
      for (const v of s.variables.filter((x) => x.variable === "precipitation_mm" || x.variable === "temperature_max_c")) {
        const what = v.variable === "precipitation_mm" ? `total ${v.total} ${v.unit}` : `daily maximum ranged ${v.min}–${v.max} ${v.unit}`;
        const issued = s.record_kind === "forecast" ? ` (issued ${v.issued_at ? `${v.issued_at.slice(0, 16).replace("T", " ")} UTC` : "at an unknown time"})` : "";
        addFinding("weather", `${s.label} ${v.label.toLowerCase()} for ${v.from} to ${v.to}${issued}: ${what} over ${v.days} day(s) (${v.providers.join(", ")}).`, [v.evidence_id]);
      }
      if (s.statement.status !== "ok" && s.variables.length) addFinding("weather", s.statement.text, s.variables.map((v) => v.evidence_id));
    }
  }

  // Warnings
  let warnings: ReportContent["warnings"] = null;
  if (has("warnings")) {
    const items: WarningEntry[] = src.warnings.map((w) => ({
      evidence_id: ev.add("warning", "external_events", [w.id], `Official warning: ${w.title} (${w.provider_id})`),
      warning_id: w.id,
      provider_id: w.provider_id,
      title: w.title,
      severity: w.severity,
      certainty: w.certainty,
      urgency: w.urgency,
      event_start: iso(w.event_start),
      event_end: iso(w.event_end),
      published_at: iso(w.published_at),
      source_url: w.source_url,
      claim_status: w.claim_status,
    }));
    warnings = {
      items,
      statement: items.length
        ? { status: "ok", text: `${items.length} official warning(s) issued by agencies, relayed as issued.` }
        : { status: "ok", text: "No official warnings are stored for this AOI in the period." },
    };
    if (items.length) {
      addFinding("warnings", `${items.length} official warning(s): ${items.slice(0, 4).map((w) => `${w.title} (${w.severity ?? "severity not stated"})`).join("; ")}.`, items.slice(0, 8).map((w) => w.evidence_id));
    }
  }

  // News (claims)
  let news: ReportContent["news"] = null;
  if (has("news")) {
    const byStory = new Map<string, ReportSource["news"]>();
    for (const n of src.news) byStory.set(n.story_key, [...(byStory.get(n.story_key) ?? []), n]);
    const stories: NewsStory[] = [...byStory.entries()].map(([key, arts]) => {
      const domains = new Set(arts.map((a) => (a.domain ?? a.url).toLowerCase()));
      const first = [...arts].sort((a, b) => (a.published_at?.getTime() ?? Infinity) - (b.published_at?.getTime() ?? Infinity))[0]!;
      return {
        evidence_id: ev.add("news", "news_articles", arts.map((a) => a.article_id), `News story "${first.title}" (${domains.size} source domain(s))`),
        story_key: key,
        title: first.title,
        category: first.category,
        first_published_at: iso(first.published_at),
        articles: arts.map((a) => ({ article_id: a.article_id, title: a.title, domain: a.domain, url: a.url, published_at: iso(a.published_at), location_match: a.location_match })),
        independent_sources: domains.size,
      };
    });
    stories.sort((a, b) => b.independent_sources - a.independent_sources || a.story_key.localeCompare(b.story_key));
    const reported: ReportedEventEntry[] = src.reportedEvents.map((e) => ({
      evidence_id: ev.add("news", "external_events", [e.id], `Reported event: ${e.title} (${e.claim_status})`),
      event_id: e.id,
      provider_id: e.provider_id,
      title: e.title,
      published_at: iso(e.published_at),
      source_url: e.source_url,
      claim_status: e.claim_status,
    }));
    news = {
      note: NEWS_NOTE,
      stories,
      reported_events: reported,
      statement: stories.length || reported.length
        ? { status: "ok", text: `${stories.length} news stor${stories.length === 1 ? "y" : "ies"} matched this AOI. These are claims, not verified facts.` }
        : { status: "ok", text: "No news reports matched this AOI in the period." },
    };
    if (stories.length) {
      const top = stories[0]!;
      addFinding(
        "news",
        `${stories.length} news stor${stories.length === 1 ? "y" : "ies"} matched this AOI (claims, not verified); the most widely reported, "${top.title}", appeared on ${top.independent_sources} independent source domain(s).`,
        stories.slice(0, 5).map((s) => s.evidence_id),
      );
    }
  }

  // Alerts
  let alerts: ReportContent["alerts"] = null;
  if (has("alerts")) {
    const open: AlertEntry[] = src.alerts.map((a) => ({
      evidence_id: ev.add("alert", "alerts", [a.id], `Alert: ${a.title}`),
      alert_id: a.id,
      title: a.title,
      severity: a.severity,
      status: a.status,
      basis: a.basis,
      observed_at: iso(a.observed_at),
      created_at: a.created_at.toISOString(),
      from_reprocessing: a.from_reprocessing,
    }));
    alerts = {
      open,
      statement: { status: "ok", text: open.length ? `${open.length} alert(s) are open or acknowledged and not yet resolved.` : "No unresolved alerts at generation time." },
    };
    if (open.length) {
      const high = open.filter((a) => a.severity === "high" || a.severity === "critical").length;
      addFinding("alerts", `${open.length} unresolved alert(s), ${high} of high or critical severity: ${open.slice(0, 3).map((a) => a.title).join("; ")}.`, open.slice(0, 8).map((a) => a.evidence_id));
    }
  }

  // Processing runs
  let processing: ReportContent["processing"] = null;
  if (has("processing")) {
    const runs: ProcessingRunEntry[] = src.runs.map((r) => ({
      evidence_id: ev.add("processing_run", "processing_runs", [r.id], `Processing run ${r.model_id}@${r.model_version} (${r.status})`),
      run_id: r.id,
      aoi_id: r.aoi_id,
      model_id: r.model_id,
      model_version: r.model_version,
      status: r.status,
      started_at: r.started_at.toISOString(),
      finished_at: iso(r.finished_at),
      input_asset_ids: r.input_asset_ids ?? [],
      messages: r.messages ?? [],
      error: r.error,
      software_version: r.software_version,
    }));
    const byStatus = runs.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    processing = {
      runs,
      statement: runs.length
        ? { status: byStatus.failed ? "partial" : "ok", text: `${runs.length} processing run(s): ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(", ")}.` }
        : { status: "missing", text: "No processing runs were recorded in the period." },
    };
    if (runs.length) addFinding("processing", processing.statement.text, runs.filter((r) => r.status !== "succeeded").slice(0, 8).map((r) => r.evidence_id).concat(runs.slice(-1).map((r) => r.evidence_id)));
  }

  // Audit
  let audit: ReportContent["audit"] = null;
  if (has("audit")) {
    const events: AuditEntry[] = src.audit.map((a) => ({
      id: a.id,
      created_at: a.created_at.toISOString(),
      actor_type: a.actor_type,
      actor_label: a.actor_label,
      action: a.action,
      target_type: a.target_type,
      target_id: a.target_id,
    }));
    const byAction = events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.action]: (acc[e.action] ?? 0) + 1 }), {});
    const eid = events.length ? ev.add("audit", "audit_events", events.map((e) => e.id), `${events.length} audit events`) : null;
    audit = {
      events,
      by_action: byAction,
      statement: events.length
        ? { status: events.length >= 2000 ? "partial" : "ok", text: `${events.length} audit event(s) in the period${events.length >= 2000 ? " (truncated to the first 2,000)" : ""}.` }
        : { status: "missing", text: "No audit events are stored for the period (events older than the retention period are purged)." },
    };
    if (eid) {
      const top = Object.entries(byAction).sort((a, b) => b[1] - a[1]).slice(0, 5);
      addFinding("audit", `${events.length} audit event(s) between ${dayOf(src.report.from)} and ${dayOf(src.report.to)}; most frequent actions: ${top.map(([a, n]) => `${a} (${n})`).join(", ")}.`, [eid]);
    }
  }

  // Sources & licences
  const assets: SourceAssetEntry[] = src.assets.map((a) => ({
    evidence_id: ev.add("source_asset", "source_assets", [a.id], `Source scene ${a.collection} ${a.external_id}`),
    asset_id: a.id,
    provider_id: a.provider_id,
    collection: a.collection,
    external_id: a.external_id,
    platform: a.platform,
    acquired_at: a.acquired_at.toISOString(),
    cloud_cover: a.cloud_cover,
    license: a.license,
    license_url: a.license_url,
    attribution: a.attribution,
    stac_url: a.stac_url,
  }));
  const attributions = [...new Set(src.assets.map((a) => a.attribution).filter((x): x is string => Boolean(x)))];

  // Limitations
  const models: ModelLimitation[] = src.models.map((m) => ({
    model_id: m.id,
    model_version: m.version,
    name: m.name,
    result_class: m.result_class,
    limitations: (m.limitations ?? []).map((text) => ({ id: ev.add("limitation", "analytic_models", [`${m.id}@${m.version}`], text), text })),
  }));
  const generalTexts = [
    "This report is a snapshot of the data stored in ORYN at generation time; it is not updated afterwards.",
    "Observations, model estimates, forecasts, official warnings, candidate changes, and news claims are different kinds of information and are reported separately.",
    ...(aoi?.is_synthetic ? ["The AOI boundary is a development placeholder, not a surveyed boundary."] : []),
    ...(src.org.is_synthetic ? ["This organization holds synthetic sample data for development; values are not real-world measurements."] : []),
    ...(news ? [NEWS_NOTE] : []),
    ...(weather ? weather.kinds.filter((k) => k.variables.length).map((k) => k.caveat) : []),
  ];
  const general = generalTexts.map((text) => ({ id: ev.add("limitation", null, [], text), text }));

  return {
    schema_version: 1,
    report: {
      id: src.report.id,
      type: src.report.type,
      title: src.report.title,
      generated_at: gen.toISOString(),
      period: { from: src.report.from.toISOString(), to: src.report.to.toISOString() },
      params: src.report.params,
    },
    org: src.org,
    aoi,
    data_currency: {
      status: currencyStatus,
      statement: currency,
      latest_usable_observation_at: iso(latestValid?.observed_at),
      latest_usable_age_days: ageDays,
      latest_processed_at: iso(maxDate(src.observations.map((o) => o.processed_at))),
      latest_weather_retrieved_at: iso(maxDate(src.weather.map((w) => w.retrieved_at))),
    },
    sections: src.sections,
    observations,
    detections,
    weather,
    warnings,
    news,
    alerts,
    processing,
    audit,
    sources: {
      assets,
      weather_providers: [...new Set(src.weather.map((w) => w.provider_id))].sort(),
      news_providers: [...new Set([...src.news.map((n) => n.provider_id), ...src.reportedEvents.map((e) => e.provider_id)])].sort(),
      attributions,
    },
    limitations: { models, general },
    findings,
    evidence: ev.entries,
    summary: null,
  };
}

function maxDate(ds: Date[]): Date | null {
  return ds.reduce<Date | null>((m, d) => (!m || d > m ? d : m), null);
}

const KIND_LABEL: Record<WeatherKind, string> = {
  observation: "Observed",
  model_estimate: "Model-estimated",
  forecast: "Forecast",
};

function summarizeWeatherKind(kind: WeatherKind, src: ReportSource, ev: EvidenceIndex): WeatherKindSummary {
  const records = src.weather.filter((w) => w.record_kind === kind);
  const gen = src.report.generatedAt;
  const asEval: EvalWeather[] = records.map((w) => ({
    id: w.id,
    providerId: w.provider_id,
    recordKind: w.record_kind,
    variable: w.variable,
    value: w.value,
    unit: w.unit,
    validFrom: w.valid_from,
    validTo: w.valid_to,
    issuedAt: w.issued_at,
    retrievedAt: w.retrieved_at,
    stationId: w.station_id,
    stationDistanceKm: w.station_distance_km,
  }));
  const variables: WeatherVariableSummary[] = [];
  for (const variable of [...new Set(records.map((r) => r.variable))].sort()) {
    const known = (WEATHER_VARIABLES as Record<string, { unit: string; label: string }>)[variable];
    const ofVar = records.filter((r) => r.variable === variable && r.value != null && Number.isFinite(r.value));
    if (!ofVar.length) continue;
    const summed = variable === "precipitation_mm" || variable === "et0_mm";
    const dailyMax = variable === "temperature_max_c" || variable === "wind_speed_max_ms";
    let values: number[];
    let rowIds: string[];
    let days: string[];
    if (summed || dailyMax) {
      const series = dailySeries(asEval, variable, [kind], summed ? "sum" : "max");
      values = series.map((d) => d.value);
      rowIds = series.flatMap((d) => d.recordIds);
      days = series.map((d) => d.day);
    } else {
      values = ofVar.map((r) => r.value as number);
      rowIds = ofVar.map((r) => r.id);
      days = [...new Set(ofVar.map((r) => dayOf(r.valid_from)))].sort();
    }
    if (!values.length) continue;
    const label = known?.label ?? variable;
    const unit = known?.unit ?? ofVar[0]!.unit;
    const used = records.filter((r) => rowIds.includes(r.id));
    variables.push({
      evidence_id: ev.add("weather", "weather_records", rowIds, `${KIND_LABEL[kind]} ${label.toLowerCase()} (${rowIds.length} record(s))`),
      variable,
      label,
      unit,
      records: rowIds.length,
      days: days.length,
      from: days[0]!,
      to: days[days.length - 1]!,
      providers: [...new Set(used.map((r) => r.provider_id))].sort(),
      total: summed ? round(values.reduce((a, b) => a + b, 0), 1) : null,
      min: round(Math.min(...values), 1),
      max: round(Math.max(...values), 1),
      mean: round(values.reduce((a, b) => a + b, 0) / values.length, 1),
      issued_at: iso(maxDate(used.map((r) => r.issued_at).filter((d): d is Date => d != null))),
      latest_retrieved_at: maxDate(used.map((r) => r.retrieved_at))!.toISOString(),
    });
  }
  const latestRetrieved = maxDate(records.map((r) => r.retrieved_at));
  let statement: SectionStatement;
  if (!variables.length) {
    statement = { status: "missing", text: `No ${KIND_LABEL[kind].toLowerCase()} weather records are stored for ${kind === "forecast" ? "the coming days" : "this period"}.` };
  } else if (kind === "forecast" && latestRetrieved && gen.getTime() - latestRetrieved.getTime() > STALE_FORECAST_DAYS * DAY_MS) {
    const d = Math.floor((gen.getTime() - latestRetrieved.getTime()) / DAY_MS);
    statement = { status: "stale", text: `The newest forecast was retrieved ${d} days before this report and may be outdated.` };
  } else if (kind !== "forecast") {
    const lastDay = variables.reduce((m, v) => (v.to > m ? v.to : m), "");
    const gap = Math.floor((src.report.to.getTime() - Date.parse(`${lastDay}T00:00:00Z`)) / DAY_MS);
    statement =
      gap > 3
        ? { status: "stale", text: `${KIND_LABEL[kind]} weather records end on ${lastDay}, ${gap} days before the end of the report period.` }
        : { status: "ok", text: `${KIND_LABEL[kind]} weather records through ${lastDay}.` };
  } else {
    statement = { status: "ok", text: `Forecast retrieved ${latestRetrieved?.toISOString().slice(0, 16).replace("T", " ")} UTC.` };
  }
  return { record_kind: kind, label: KIND_LABEL[kind], caveat: WEATHER_KIND_CAVEAT[kind], statement, variables };
}
