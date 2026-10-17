/**
 * Export generation job.
 *
 *   JOB.exportGenerate  org job  { exportId }
 *
 * Builds the file for a queued export (GeoJSON, CSV, GeoTIFF, or report
 * PDF), stores it under orgs/<org>/exports/<id>/<filename>, and marks the
 * export ready with its content type, size, licence notes, and expiry
 * (org retention.exportsDays, default 7).
 *
 * Guarantees
 *  - Every query runs in the org's tenant context AND filters by org_id and
 *    the AOI scope frozen at request time: no other org's rows can appear.
 *  - Licence notes are collected from the source assets / providers whose
 *    data the file contains.
 *  - On failure the export is marked 'failed' and the error is rethrown.
 */
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import { withTenant, type Tx } from "@/server/db/client";
import { PermanentJobError } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobHandler } from "@/server/jobs/worker";
import { orgKey, storage } from "@/server/storage";
import type { RasterRef } from "@/server/analytics/types";
import { parsePayload, requireOrg } from "@/server/alerts/job-payload";
import { CSV_CONTENT_TYPE, toCsv, type CsvColumn } from "@/server/exports/csv";
import {
  aoiFeature,
  detectionFeature,
  featureCollection,
  GEOJSON_CONTENT_TYPE,
  observationFeature,
  type AoiExportRow,
  type DetectionExportRow,
  type Feature,
  type ObservationExportRow,
} from "@/server/exports/geojson";
import { float32FromLittleEndian, GEOTIFF_CONTENT_TYPE, writeFloat32GeoTiff } from "@/server/exports/geotiff";
import { collectLicenseNotes, type LicenseAsset } from "@/server/exports/licenses";
import { exportParamsSchema, type ExportSubject, type ExportType } from "@/server/exports/service";
import { loadRasterPng } from "@/server/reports/handlers";
import { renderReportPdf } from "@/server/reports/pdf";
import type { ReportContent } from "@/server/reports/types";

export const exportGeneratePayload = z.object({ exportId: uuidSchema });

const DEFAULT_EXPORT_DAYS = 7;
const MAX_ROWS = 50_000;

type Built = { body: Buffer; filename: string; contentType: string; licenseNotes: string[] };

type Ctx = { tx: Tx; orgId: string; exportId: string; params: z.infer<typeof exportParamsSchema>; scope: string[] | null; generatedAt: Date };

function scopeFilter(c: Ctx, q: Tx, column: "x.aoi_id" | "x.id") {
  const ids = c.params.aoiId ? [c.params.aoiId] : c.scope;
  if (!ids) return q``;
  return column === "x.id" ? q`and x.id = any(${ids}::uuid[])` : q`and x.aoi_id = any(${ids}::uuid[])`;
}

function period(c: Ctx, q: Tx, column: "obs" | "det" | "wx") {
  const from = c.params.from ? new Date(c.params.from) : null;
  const to = c.params.to ? new Date(c.params.to) : null;
  const col =
    column === "obs" ? q`x.observed_at` : column === "det" ? q`coalesce(x.comparison_observed_at, x.last_observed_at)` : q`x.valid_from`;
  return q`${from ? q`and ${col} >= ${from}` : q``} ${to ? q`and ${col} <= ${to}` : q``}`;
}

async function assetsFor(tx: Tx, ids: string[]): Promise<LicenseAsset[]> {
  if (!ids.length) return [];
  return tx<LicenseAsset[]>`
    select provider_id, collection, acquired_at, license, license_url, attribution
      from source_assets where id = any(${[...new Set(ids)]}::uuid[])`;
}

const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

function meta(c: Ctx, subject: string, licenseNotes: string[], notes: string[]) {
  return { export_id: c.exportId, org_id: c.orgId, subject, generated_at: c.generatedAt.toISOString(), license_notes: licenseNotes, notes };
}

// ── Subjects ───────────────────────────────────────────────────

async function detectionRows(c: Ctx): Promise<(DetectionExportRow & { lon: number | null; lat: number | null })[]> {
  const q = c.tx;
  return q<(DetectionExportRow & { lon: number | null; lat: number | null })[]>`
    select x.id, x.aoi_id, a.name as aoi_name, x.type, x.result_class, x.title, ST_AsGeoJSON(x.geom, 7)::jsonb as geometry,
           x.area_m2, x.model_id, x.model_version, x.run_id, x.baseline_observation_id, x.comparison_observation_id,
           x.baseline_observed_at, x.comparison_observed_at, x.first_observed_at, x.last_observed_at, x.created_at,
           x.evidence_grade, x.evidence_reasons, x.verification_status, x.verified_at, x.source_asset_ids, x.metrics,
           x.thresholds, x.limitations, ST_X(ST_PointOnSurface(x.geom)) as lon, ST_Y(ST_PointOnSurface(x.geom)) as lat
      from detections x join aois a on a.id = x.aoi_id and a.org_id = x.org_id
     where x.org_id = ${c.orgId} ${scopeFilter(c, q, "x.aoi_id")} ${period(c, q, "det")}
       ${c.params.includeDismissed ? q`` : q`and x.verification_status <> 'dismissed'`}
     order by x.created_at, x.id
     limit ${MAX_ROWS}`;
}

async function aoiRows(c: Ctx): Promise<(AoiExportRow & { lon: number | null; lat: number | null })[]> {
  const q = c.tx;
  return q<(AoiExportRow & { lon: number | null; lat: number | null })[]>`
    select x.id, x.name, x.kind::text as kind, x.status::text as status, ST_AsGeoJSON(x.geom, 7)::jsonb as geometry, x.area_m2,
           x.boundary_source, x.is_synthetic, x.tags, x.created_at, x.updated_at,
           ST_X(x.label_point) as lon, ST_Y(x.label_point) as lat
      from aois x
     where x.org_id = ${c.orgId} ${scopeFilter(c, q, "x.id")}
     order by x.created_at, x.id
     limit ${MAX_ROWS}`;
}

async function observationRows(c: Ctx, withGeometry: boolean): Promise<ObservationExportRow[]> {
  const q = c.tx;
  return q<ObservationExportRow[]>`
    select x.id, x.aoi_id, a.name as aoi_name, ${withGeometry ? q`ST_AsGeoJSON(a.geom, 7)::jsonb` : q`null::jsonb`} as geometry,
           x.kind, x.model_id, x.model_version, x.result_class, x.status, x.observed_at, x.processed_at, x.is_current, x.run_id,
           x.asset_id, s.provider_id, s.collection, s.external_id, x.metrics, x.quality, x.limitations
      from observations x
      join aois a on a.id = x.aoi_id and a.org_id = x.org_id
      join source_assets s on s.id = x.asset_id
     where x.org_id = ${c.orgId} and x.is_current ${scopeFilter(c, q, "x.aoi_id")} ${period(c, q, "obs")}
       ${c.params.includeUnusable === false ? q`and x.status = 'valid'` : q``}
     order by x.observed_at, x.id
     limit ${MAX_ROWS}`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function buildGeoJson(c: Ctx, subject: ExportSubject): Promise<Built> {
  let features: Feature[];
  let licenseNotes: string[];
  const notes = ["Coordinates are WGS 84 longitude/latitude (RFC 7946)."];
  if (subject === "detections") {
    const rows = await detectionRows(c);
    features = rows.map(detectionFeature);
    licenseNotes = collectLicenseNotes({ assets: await assetsFor(c.tx, rows.flatMap((r) => r.source_asset_ids)), derived: rows.length > 0 });
    notes.push("Detections are candidate changes unless verification_status is 'confirmed'.");
  } else if (subject === "aois") {
    const rows = await aoiRows(c);
    features = rows.map(aoiFeature);
    licenseNotes = collectLicenseNotes({ boundarySources: rows.map((r) => r.boundary_source) });
    if (rows.some((r) => r.is_synthetic)) notes.push("Features with is_synthetic = true are development placeholders, not real boundaries.");
  } else {
    const rows = await observationRows(c, true);
    features = rows.map(observationFeature);
    licenseNotes = collectLicenseNotes({ assets: await assetsFor(c.tx, rows.map((r) => r.asset_id)), derived: rows.length > 0 });
    notes.push("Observation geometry is the AOI summarized; unusable observations carry their reason.");
  }
  const fc = featureCollection(features, meta(c, subject, licenseNotes, notes));
  return { body: Buffer.from(JSON.stringify(fc)), filename: `oryn-${subject}-${stamp(c.generatedAt)}.geojson`, contentType: GEOJSON_CONTENT_TYPE, licenseNotes };
}

async function buildCsv(c: Ctx, subject: ExportSubject): Promise<Built> {
  let csv: string;
  let licenseNotes: string[];
  if (subject === "detections") {
    const rows = await detectionRows(c);
    type R = (typeof rows)[number];
    const cols: CsvColumn<R>[] = [
      { header: "detection_id", value: (r) => r.id },
      { header: "aoi_id", value: (r) => r.aoi_id },
      { header: "aoi_name", value: (r) => r.aoi_name },
      { header: "type", value: (r) => r.type },
      { header: "title", value: (r) => r.title },
      { header: "result_class", value: (r) => r.result_class },
      { header: "area_m2", value: (r) => r.area_m2 },
      { header: "centroid_lon", value: (r) => r.lon },
      { header: "centroid_lat", value: (r) => r.lat },
      { header: "baseline_observed_at", value: (r) => r.baseline_observed_at },
      { header: "observed_at", value: (r) => r.comparison_observed_at ?? r.last_observed_at },
      { header: "processed_at", value: (r) => r.created_at },
      { header: "model_id", value: (r) => r.model_id },
      { header: "model_version", value: (r) => r.model_version },
      { header: "evidence_grade", value: (r) => r.evidence_grade },
      { header: "evidence_reasons", value: (r) => r.evidence_reasons.join("; ") },
      { header: "verification_status", value: (r) => r.verification_status },
      { header: "mean_delta", value: (r) => num(r.metrics.mean_delta) },
      { header: "direction", value: (r) => (typeof r.metrics.direction === "string" ? r.metrics.direction : null) },
      { header: "source_asset_ids", value: (r) => r.source_asset_ids.join(" ") },
    ];
    csv = toCsv(cols, rows);
    licenseNotes = collectLicenseNotes({ assets: await assetsFor(c.tx, rows.flatMap((r) => r.source_asset_ids)), derived: rows.length > 0 });
  } else if (subject === "aois") {
    const rows = await aoiRows(c);
    type R = (typeof rows)[number];
    const cols: CsvColumn<R>[] = [
      { header: "aoi_id", value: (r) => r.id },
      { header: "name", value: (r) => r.name },
      { header: "kind", value: (r) => r.kind },
      { header: "status", value: (r) => r.status },
      { header: "area_m2", value: (r) => r.area_m2 },
      { header: "label_lon", value: (r) => r.lon },
      { header: "label_lat", value: (r) => r.lat },
      { header: "boundary_method", value: (r) => (typeof r.boundary_source.method === "string" ? r.boundary_source.method : null) },
      { header: "boundary_provider", value: (r) => (typeof r.boundary_source.provider === "string" ? r.boundary_source.provider : null) },
      { header: "is_synthetic", value: (r) => r.is_synthetic },
      { header: "created_at", value: (r) => r.created_at },
    ];
    csv = toCsv(cols, rows);
    licenseNotes = collectLicenseNotes({ boundarySources: rows.map((r) => r.boundary_source) });
  } else if (subject === "observations") {
    const rows = await observationRows(c, false);
    type R = (typeof rows)[number];
    const m = (k: string) => (r: R) => num(r.metrics[k]);
    const qn = (k: string) => (r: R) => num(r.quality[k]);
    const cols: CsvColumn<R>[] = [
      { header: "observation_id", value: (r) => r.id },
      { header: "aoi_id", value: (r) => r.aoi_id },
      { header: "aoi_name", value: (r) => r.aoi_name },
      { header: "kind", value: (r) => r.kind },
      { header: "model_id", value: (r) => r.model_id },
      { header: "model_version", value: (r) => r.model_version },
      { header: "result_class", value: (r) => r.result_class },
      { header: "status", value: (r) => r.status },
      { header: "unusable_reason", value: (r) => (typeof r.quality.unusable_reason === "string" ? r.quality.unusable_reason : null) },
      { header: "observed_at", value: (r) => r.observed_at },
      { header: "processed_at", value: (r) => r.processed_at },
      { header: "source_provider", value: (r) => r.provider_id },
      { header: "source_collection", value: (r) => r.collection },
      { header: "source_external_id", value: (r) => r.external_id },
      { header: "mean", value: m("mean") },
      { header: "median", value: m("median") },
      { header: "p10", value: m("p10") },
      { header: "p90", value: m("p90") },
      { header: "std", value: m("std") },
      { header: "valid_fraction", value: m("valid_fraction") },
      { header: "water_area_m2", value: m("water_area_m2") },
      { header: "water_fraction", value: m("water_fraction") },
      { header: "coverage_fraction", value: qn("coverage_fraction") },
      { header: "masked_fraction", value: qn("masked_fraction") },
      { header: "scene_cloud_cover", value: qn("scene_cloud_cover") },
      { header: "quality_flags", value: (r) => (Array.isArray(r.quality.flags) ? (r.quality.flags as string[]).join("; ") : null) },
    ];
    csv = toCsv(cols, rows);
    licenseNotes = collectLicenseNotes({ assets: await assetsFor(c.tx, rows.map((r) => r.asset_id)), derived: rows.length > 0 });
  } else {
    const q = c.tx;
    const kinds = c.params.kinds ?? ["observation", "model_estimate", "forecast"];
    const rows = await q<
      { id: string; aoi_id: string; aoi_name: string; provider_id: string; record_kind: string; variable: string; value: number | null; unit: string; valid_from: Date; valid_to: Date; issued_at: Date | null; retrieved_at: Date; station_id: string | null; station_distance_km: number | null; source_url: string | null }[]
    >`
      select x.id::text as id, x.aoi_id, a.name as aoi_name, x.provider_id, x.record_kind, x.variable, x.value, x.unit,
             x.valid_from, x.valid_to, x.issued_at, x.retrieved_at, x.station_id, x.station_distance_km, x.source_url
        from weather_records x join aois a on a.id = x.aoi_id and a.org_id = x.org_id
       where x.org_id = ${c.orgId} ${scopeFilter(c, q, "x.aoi_id")} ${period(c, q, "wx")}
         and x.record_kind = any(${kinds})
         ${c.params.variables?.length ? q`and x.variable = any(${c.params.variables})` : q``}
       order by x.aoi_id, x.record_kind, x.variable, x.valid_from
       limit ${MAX_ROWS}`;
    type R = (typeof rows)[number];
    const cols: CsvColumn<R>[] = [
      { header: "record_id", value: (r) => r.id },
      { header: "aoi_id", value: (r) => r.aoi_id },
      { header: "aoi_name", value: (r) => r.aoi_name },
      { header: "record_kind", value: (r) => r.record_kind },
      { header: "variable", value: (r) => r.variable },
      { header: "value", value: (r) => r.value },
      { header: "unit", value: (r) => r.unit },
      { header: "valid_from", value: (r) => r.valid_from },
      { header: "valid_to", value: (r) => r.valid_to },
      { header: "issued_at", value: (r) => r.issued_at },
      { header: "retrieved_at", value: (r) => r.retrieved_at },
      { header: "provider_id", value: (r) => r.provider_id },
      { header: "station_id", value: (r) => r.station_id },
      { header: "station_distance_km", value: (r) => r.station_distance_km },
      { header: "source_url", value: (r) => r.source_url },
    ];
    csv = toCsv(cols, rows);
    licenseNotes = collectLicenseNotes({ weatherProviders: rows.map((r) => r.provider_id) });
  }
  return { body: Buffer.from(csv, "utf8"), filename: `oryn-${subject}-${stamp(c.generatedAt)}.csv`, contentType: CSV_CONTENT_TYPE, licenseNotes };
}

async function buildGeoTiff(c: Ctx): Promise<Built> {
  const [o] = await c.tx<{ id: string; aoi_id: string; kind: string; observed_at: Date; raster: Partial<RasterRef> | null; asset_id: string }[]>`
    select x.id, x.aoi_id, x.kind, x.observed_at, x.raster, x.asset_id
      from observations x
     where x.org_id = ${c.orgId} and x.id = ${c.params.observationId ?? null} ${scopeFilter(c, c.tx, "x.aoi_id")}`;
  if (!o) throw new PermanentJobError("Observation not found for raster export.");
  const r = o.raster;
  if (!r?.data_key || !r.width || !r.height || !r.transform || !r.epsg) throw new PermanentJobError("The observation has no complete raster reference.");
  if (!r.data_key.startsWith(`orgs/${c.orgId}/`)) throw new PermanentJobError("Raster data is outside this organization's storage.");
  const obj = await storage().get(r.data_key);
  if (!obj) throw new PermanentJobError("Raster data is no longer available in storage.");
  const body = writeFloat32GeoTiff({ width: r.width, height: r.height, data: float32FromLittleEndian(obj.body), transform: r.transform, epsg: r.epsg });
  const licenseNotes = collectLicenseNotes({ assets: await assetsFor(c.tx, [o.asset_id]), derived: true });
  return { body, filename: `oryn-${o.kind}-${stamp(o.observed_at)}-${o.id.slice(0, 8)}.tif`, contentType: GEOTIFF_CONTENT_TYPE, licenseNotes };
}

async function buildPdf(c: Ctx): Promise<Built> {
  const [r] = await c.tx<{ id: string; aoi_id: string | null; status: string; content: ReportContent | null; title: string }[]>`
    select id, aoi_id, status, content, title from reports where id = ${c.params.reportId ?? null} and org_id = ${c.orgId}`;
  if (!r || r.status !== "ready" || !r.content) throw new PermanentJobError("The report is not ready.");
  if (c.scope && r.aoi_id && !c.scope.includes(r.aoi_id)) throw new PermanentJobError("Report is outside the export scope.");
  const body = await renderReportPdf(r.content, { rasterPng: await loadRasterPng(c.orgId, r.content) });
  const licenseNotes = [
    ...new Set([
      ...collectLicenseNotes({
        assets: r.content.sources.assets.map((a) => ({ ...a, acquired_at: new Date(a.acquired_at) })),
        weatherProviders: r.content.sources.weather_providers,
        derived: r.content.sources.assets.length > 0,
      }),
      ...r.content.sources.attributions,
    ]),
  ];
  return { body, filename: `oryn-report-${stamp(new Date(r.content.report.generated_at))}-${r.id.slice(0, 8)}.pdf`, contentType: "application/pdf", licenseNotes };
}

// ── Job ────────────────────────────────────────────────────────

export async function generateExport(orgId: string, exportId: string): Promise<{ status: "ready" | "already_ready"; exportId: string; sizeBytes?: number }> {
  const row = await withTenant({ orgId }, async (tx) => {
    const [e] = await tx<{ id: string; export_type: ExportType; subject: ExportSubject; params: Record<string, unknown>; status: string }[]>`
      select id, export_type, subject, params, status from exports where id = ${exportId} and org_id = ${orgId} for update`;
    if (!e) return null;
    if (e.status === "queued" || e.status === "failed" || e.status === "running") {
      await tx`update exports set status = 'running', error = null where id = ${e.id} and org_id = ${orgId}`;
    }
    return e;
  });
  if (!row) throw new PermanentJobError(`Export ${exportId} not found.`);
  if (row.status === "ready") return { status: "already_ready", exportId };
  if (row.status === "expired") throw new PermanentJobError("Export has expired.");

  try {
    const scope = Array.isArray(row.params.scope_aoi_ids) ? (row.params.scope_aoi_ids as string[]) : null;
    const params = exportParamsSchema.parse(Object.fromEntries(Object.entries(row.params).filter(([k]) => k !== "scope_aoi_ids")));
    const built = await withTenant({ orgId }, async (tx) => {
      const [clock] = await tx<{ now: Date }[]>`select now() as now`;
      const c: Ctx = { tx, orgId, exportId, params, scope, generatedAt: clock!.now };
      switch (row.export_type) {
        case "geojson":
          return buildGeoJson(c, row.subject);
        case "csv":
          return buildCsv(c, row.subject);
        case "geotiff":
          return buildGeoTiff(c);
        case "pdf":
          return buildPdf(c);
      }
    });
    const key = orgKey(orgId, "exports", exportId, built.filename);
    const { size } = await storage().put(key, built.body, built.contentType);
    await withTenant({ orgId }, async (tx) => {
      const [org] = await tx<{ days: number | null }[]>`
        select (settings #>> '{retention,exportsDays}')::numeric::int as days from organizations where id = ${orgId}`;
      const days = Math.min(Math.max(org?.days ?? DEFAULT_EXPORT_DAYS, 1), 365);
      await tx`
        update exports set status = 'ready', storage_key = ${key}, filename = ${built.filename}, content_type = ${built.contentType},
                           size_bytes = ${size}, license_notes = ${built.licenseNotes}, completed_at = now(),
                           expires_at = now() + make_interval(days => ${days}), error = null
         where id = ${exportId} and org_id = ${orgId}`;
      await recordAudit(tx, {
        orgId,
        actor: { type: "system", label: "export.generate" },
        action: "export.generate",
        targetType: "export",
        targetId: exportId,
        metadata: { type: row.export_type, subject: row.subject, size_bytes: size, expires_in_days: days },
      });
    });
    return { status: "ready", exportId, sizeBytes: size };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await withTenant({ orgId }, (tx) => tx`update exports set status = 'failed', error = ${message} where id = ${exportId} and org_id = ${orgId}`).catch(() => {});
    throw err instanceof z.ZodError ? new PermanentJobError(`Invalid stored export parameters: ${err.message}`) : err;
  }
}

export const exportGenerateHandler: JobHandler = {
  type: JOB.exportGenerate,
  describe: "Generate an export file",
  async run(ctx) {
    const orgId = requireOrg(ctx);
    const { exportId } = parsePayload(exportGeneratePayload, ctx);
    return generateExport(orgId, exportId);
  },
};

export const EXPORT_HANDLERS: JobHandler[] = [exportGenerateHandler];
