/**
 * Read models for analytical results — observations, available imagery,
 * detections (intelligence objects), analyst review, notes, and the weather /
 * warning / news context of an AOI.
 *
 * Every function filters by the caller's org explicitly (RLS is the second
 * wall) and respects AOI restrictions. Storage keys are always taken from
 * database rows the caller could see, never from request input.
 */
import { z } from "zod";
import type { Geometry } from "@/lib/geo";
import { currentModelKeys } from "@/server/analytics/registry";
import { DELTA_NDVI_STOPS, MASKED_STOP } from "@/server/analytics/render";
import type { ObservationQuality, RasterRef } from "@/server/analytics/types";
import { recordAudit } from "@/server/audit";
import type { OrgAccess } from "@/server/authz/access";
import { aoiVisibleTo, getAoi } from "@/server/aois/service";
import type { Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { referenceMatches, type ReferenceMatch } from "@/server/reference/service";
import { storage } from "@/server/storage";

const uuid = z.uuid();
function assertId(id: string, what: string) {
  if (!uuid.safeParse(id).success) throw notFoundError(what);
}

export type AssetMeta = {
  id: string;
  providerId: string;
  collection: string;
  externalId: string;
  platform: string | null;
  acquiredAt: Date;
  acquiredEndAt: Date | null;
  firstSeenAt: Date;
  gsdM: number | null;
  cloudCover: number | null;
  license: string | null;
  licenseUrl: string | null;
  attribution: string | null;
  stacUrl: string | null;
  gridCode: string | null;
};

const ASSET_SQL = (tx: Tx, alias: string) => tx.unsafe(`
  json_build_object(
    'id', ${alias}.id, 'providerId', ${alias}.provider_id, 'collection', ${alias}.collection, 'externalId', ${alias}.external_id,
    'platform', ${alias}.platform, 'acquiredAt', ${alias}.acquired_at, 'acquiredEndAt', ${alias}.acquired_end_at,
    'firstSeenAt', ${alias}.first_seen_at, 'gsdM', ${alias}.gsd_m, 'cloudCover', ${alias}.cloud_cover,
    'license', ${alias}.license, 'licenseUrl', ${alias}.license_url, 'attribution', ${alias}.attribution,
    'stacUrl', ${alias}.stac_url, 'gridCode', ${alias}.grid_code)`);

function reviveAsset(a: AssetMeta & { acquiredAt: Date | string; acquiredEndAt: Date | string | null; firstSeenAt: Date | string }): AssetMeta {
  return {
    ...a,
    acquiredAt: new Date(a.acquiredAt),
    acquiredEndAt: a.acquiredEndAt ? new Date(a.acquiredEndAt) : null,
    firstSeenAt: new Date(a.firstSeenAt),
    gsdM: a.gsdM === null ? null : Number(a.gsdM),
    cloudCover: a.cloudCover === null ? null : Number(a.cloudCover),
  };
}

// ── Observations ───────────────────────────────────────────────

export type ObservationView = {
  id: string;
  aoiId: string;
  kind: string;
  modelId: string;
  modelVersion: string;
  resultClass: string;
  status: "valid" | "unusable";
  observedAt: Date;
  processedAt: Date;
  metrics: Record<string, unknown>;
  quality: ObservationQuality;
  limitations: string[];
  hasRaster: boolean;
  hasTrueColor: boolean;
  corners: RasterRef["corners"] | null;
  legend: RasterRef["legend"] | null;
  runId: string;
  asset: AssetMeta;
};

type ObservationRow = {
  id: string;
  aoi_id: string;
  kind: string;
  model_id: string;
  model_version: string;
  result_class: string;
  status: "valid" | "unusable";
  observed_at: Date;
  processed_at: Date;
  metrics: Record<string, unknown>;
  quality: ObservationQuality;
  limitations: string[];
  raster: RasterRef | null;
  run_id: string;
  asset: AssetMeta;
};

function toObservation(r: ObservationRow): ObservationView {
  return {
    id: r.id,
    aoiId: r.aoi_id,
    kind: r.kind,
    modelId: r.model_id,
    modelVersion: r.model_version,
    resultClass: r.result_class,
    status: r.status,
    observedAt: r.observed_at,
    processedAt: r.processed_at,
    metrics: r.metrics,
    quality: r.quality,
    limitations: r.limitations,
    hasRaster: Boolean(r.raster?.png_key),
    hasTrueColor: Boolean(r.raster?.true_color_key),
    corners: r.raster?.corners ?? null,
    legend: r.raster?.legend ?? null,
    runId: r.run_id,
    asset: reviveAsset(r.asset),
  };
}

export async function listObservations(access: OrgAccess, aoiId: string, opts: { kind?: string; limit?: number; includeSuperseded?: boolean } = {}): Promise<ObservationView[]> {
  access.assert("results.read");
  assertId(aoiId, "Area of interest");
  return access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    const rows = await tx<ObservationRow[]>`
      select o.id, o.aoi_id, o.kind, o.model_id, o.model_version, o.result_class, o.status, o.observed_at, o.processed_at,
             o.metrics, o.quality, o.limitations, o.raster, o.run_id, ${ASSET_SQL(tx, "s")} as asset
        from observations o join source_assets s on s.id = o.asset_id
       where o.org_id = ${access.org.id} and o.aoi_id = ${aoiId}
         ${opts.includeSuperseded ? tx`` : tx`and o.is_current`}
         ${opts.kind ? tx`and o.kind = ${opts.kind}` : tx``}
       order by o.observed_at desc
       limit ${Math.min(opts.limit ?? 500, 2000)}`;
    return rows.map(toObservation);
  });
}

export async function getObservation(access: OrgAccess, id: string) {
  access.assert("results.read");
  assertId(id, "Observation");
  return access.tx(async (tx) => {
    const [r] = await tx<(ObservationRow & { run: Record<string, unknown> })[]>`
      select o.id, o.aoi_id, o.kind, o.model_id, o.model_version, o.result_class, o.status, o.observed_at, o.processed_at,
             o.metrics, o.quality, o.limitations, o.raster, o.run_id, ${ASSET_SQL(tx, "s")} as asset,
             json_build_object('id', r.id, 'status', r.status, 'parameters', r.parameters, 'messages', r.messages,
                               'software_version', r.software_version, 'started_at', r.started_at, 'finished_at', r.finished_at) as run
        from observations o
        join source_assets s on s.id = o.asset_id
        join processing_runs r on r.id = o.run_id
        join aois a on a.id = o.aoi_id
       where o.org_id = ${access.org.id} and o.id = ${id} ${aoiVisibleTo(tx, access)}`;
    if (!r) throw notFoundError("Observation");
    return { ...toObservation(r), run: r.run };
  });
}

/** PNG bytes for an observation layer. `layer` selects the derived index or the true-colour preview. */
export async function observationPng(access: OrgAccess, id: string, layer: "index" | "true_color"): Promise<Buffer> {
  access.assert("results.read");
  assertId(id, "Observation");
  const key = await access.tx(async (tx) => {
    const [r] = await tx<{ raster: RasterRef | null }[]>`
      select o.raster from observations o join aois a on a.id = o.aoi_id
       where o.org_id = ${access.org.id} and o.id = ${id} ${aoiVisibleTo(tx, access)}`;
    if (!r) throw notFoundError("Observation");
    return layer === "true_color" ? r.raster?.true_color_key : r.raster?.png_key;
  });
  if (!key) throw new DomainError("no_raster", "This observation has no rendered image for that layer.", 404);
  const obj = await storage().get(key);
  if (!obj) throw new DomainError("raster_missing", "The rendered image is missing from storage.", 404);
  return obj.body;
}

/** PNG of the ΔNDVI map from the comparison that produced a detection (storage key from the run, never from input). */
export async function detectionChangePng(access: OrgAccess, id: string): Promise<Buffer> {
  access.assert("results.read");
  assertId(id, "Detection");
  const key = await access.tx(async (tx) => {
    const [r] = await tx<{ key: string | null }[]>`
      select r.outputs->>'delta_png_key' as key
        from detections d join aois a on a.id = d.aoi_id left join processing_runs r on r.id = d.run_id and r.org_id = d.org_id
       where d.org_id = ${access.org.id} and d.id = ${id} ${aoiVisibleTo(tx, access)}`;
    if (!r) throw notFoundError("Detection");
    return r.key;
  });
  if (!key) throw new DomainError("no_raster", "This detection has no stored change map.", 404);
  const obj = await storage().get(key);
  if (!obj) throw new DomainError("raster_missing", "The change map is missing from storage.", 404);
  return obj.body;
}

// ── Imagery available for an AOI ───────────────────────────────

export type AoiAssetView = {
  asset: AssetMeta;
  coverageFraction: number;
  status: string;
  statusReason: string | null;
  discoveredAt: Date;
  observationKinds: string[];
};

export async function listAoiAssets(access: OrgAccess, aoiId: string, limit = 200): Promise<AoiAssetView[]> {
  access.assert("results.read");
  assertId(aoiId, "Area of interest");
  return access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    const rows = await tx<{ asset: AssetMeta; coverage_fraction: number; status: string; status_reason: string | null; discovered_at: Date; kinds: string[] | null }[]>`
      select ${ASSET_SQL(tx, "s")} as asset, l.coverage_fraction, l.status, l.status_reason, l.discovered_at,
             (select array_agg(distinct o.kind) from observations o where o.aoi_id = l.aoi_id and o.asset_id = l.asset_id and o.is_current) as kinds
        from aoi_assets l join source_assets s on s.id = l.asset_id
       where l.org_id = ${access.org.id} and l.aoi_id = ${aoiId}
       order by s.acquired_at desc
       limit ${Math.min(limit, 1000)}`;
    return rows.map((r) => ({
      asset: reviveAsset(r.asset),
      coverageFraction: r.coverage_fraction,
      status: r.status,
      statusReason: r.status_reason,
      discoveredAt: r.discovered_at,
      observationKinds: r.kinds ?? [],
    }));
  });
}

// ── Detections ─────────────────────────────────────────────────

export const detectionFilterSchema = z.object({
  aoiId: z.uuid().optional(),
  types: z.array(z.string().max(60)).max(20).optional(),
  verification: z.array(z.enum(["unverified", "needs_field_check", "confirmed", "dismissed"])).optional(),
  minGrade: z.enum(["weak", "moderate", "strong"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Include detections produced by superseded model versions (kept as history). */
  includeSuperseded: z.boolean().default(false),
  limit: z.number().int().min(1).max(2000).default(500),
});

const GRADE_RANK = { insufficient: 0, weak: 1, moderate: 2, strong: 3 } as const;

export async function detectionFeatures(access: OrgAccess, raw: z.input<typeof detectionFilterSchema>) {
  access.assert("results.read");
  const f = detectionFilterSchema.parse(raw);
  return access.tx(async (tx) => {
    const minRank = f.minGrade ? GRADE_RANK[f.minGrade] : 0;
    const rows = await tx<{ feature: GeoJSON.Feature }[]>`
      select json_build_object(
        'type', 'Feature', 'id', d.id,
        'geometry', ST_AsGeoJSON(d.geom, 7)::json,
        'properties', json_build_object(
          'id', d.id, 'aoi_id', d.aoi_id, 'aoi_name', a.name, 'type', d.type, 'title', d.title, 'result_class', d.result_class,
          'area_m2', d.area_m2, 'evidence_grade', d.evidence_grade, 'verification_status', d.verification_status,
          'baseline_observed_at', d.baseline_observed_at, 'comparison_observed_at', d.comparison_observed_at,
          'mean_delta', d.metrics->'mean_delta', 'model', d.model_id || '@' || d.model_version
        )) as feature
        from detections d join aois a on a.id = d.aoi_id
       where d.org_id = ${access.org.id} ${aoiVisibleTo(tx, access)}
         ${f.aoiId ? tx`and d.aoi_id = ${f.aoiId}` : tx``}
         ${f.types?.length ? tx`and d.type = any(${f.types})` : tx``}
         ${f.verification?.length ? tx`and d.verification_status = any(${f.verification})` : tx``}
         ${minRank ? tx`and case d.evidence_grade when 'strong' then 3 when 'moderate' then 2 when 'weak' then 1 else 0 end >= ${minRank}` : tx``}
         ${f.from ? tx`and d.comparison_observed_at >= ${f.from}` : tx``}
         ${f.to ? tx`and d.comparison_observed_at <= ${f.to}` : tx``}
         ${f.bbox ? tx`and d.geom && ST_MakeEnvelope(${f.bbox[0]}, ${f.bbox[1]}, ${f.bbox[2]}, ${f.bbox[3]}, 4326)` : tx``}
         ${f.includeSuperseded ? tx`` : tx`and (d.model_id is null or d.model_id || '@' || d.model_version = any(${currentModelKeys()}))`}
       order by d.comparison_observed_at desc nulls last, d.area_m2 desc
       limit ${f.limit}`;
    return { type: "FeatureCollection" as const, features: rows.map((r) => r.feature) };
  });
}

export type DetectionDetail = {
  id: string;
  aoiId: string;
  aoiName: string;
  type: string;
  resultClass: string;
  title: string;
  geometry: Geometry;
  bbox: [number, number, number, number];
  centroid: [number, number];
  areaM2: number | null;
  firstObservedAt: Date;
  lastObservedAt: Date;
  baseline: ObservationView | null;
  comparison: ObservationView | null;
  metrics: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  evidenceGrade: string;
  evidenceReasons: string[];
  limitations: string[];
  verificationStatus: string;
  verificationNote: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  model: string | null;
  run: { id: string; status: string; messages: string[]; parameters: Record<string, unknown>; outputs: Record<string, unknown>; software_version: string; started_at: Date } | null;
  createdAt: Date;
  relatedAlerts: { id: string; title: string; status: string; severity: string; created_at: Date }[];
  context: { warnings: { id: string; title: string; severity: string | null; event_start: Date | null; event_end: Date | null }[] };
  /** Organization reference features (permits, parcels, OSM infrastructure) intersecting the detection. */
  referenceMatches: ReferenceMatch[];
  /** The rendered ΔNDVI map of the comparison that produced this candidate, when one was stored. */
  changeMap: { corners: RasterRef["corners"]; legend: RasterRef["legend"] } | null;
};

export async function getDetection(access: OrgAccess, id: string): Promise<DetectionDetail> {
  access.assert("results.read");
  assertId(id, "Detection");
  return access.tx(async (tx) => {
    const [d] = await tx<
      {
        id: string; aoi_id: string; aoi_name: string; type: string; result_class: string; title: string; geometry: Geometry;
        bbox: [number, number, number, number]; centroid: { coordinates: [number, number] }; area_m2: number | null;
        first_observed_at: Date; last_observed_at: Date; baseline_observation_id: string | null; comparison_observation_id: string | null;
        metrics: Record<string, unknown>; thresholds: Record<string, unknown>; evidence_grade: string; evidence_reasons: string[];
        limitations: string[]; verification_status: string; verification_note: string | null; verifier: string | null; verified_at: Date | null;
        model_id: string | null; model_version: string | null; run_id: string | null; created_at: Date;
      }[]
    >`
      select d.id, d.aoi_id, a.name as aoi_name, d.type, d.result_class, d.title, ST_AsGeoJSON(d.geom, 7)::json as geometry,
             array[ST_XMin(d.geom), ST_YMin(d.geom), ST_XMax(d.geom), ST_YMax(d.geom)]::float8[] as bbox,
             ST_AsGeoJSON(ST_PointOnSurface(d.geom), 7)::json as centroid,
             d.area_m2, d.first_observed_at, d.last_observed_at, d.baseline_observation_id, d.comparison_observation_id,
             d.metrics, d.thresholds, d.evidence_grade, d.evidence_reasons, d.limitations, d.verification_status,
             d.verification_note, u.name as verifier, d.verified_at, d.model_id, d.model_version, d.run_id, d.created_at
        from detections d join aois a on a.id = d.aoi_id left join auth_user u on u.id = d.verified_by
       where d.org_id = ${access.org.id} and d.id = ${id} ${aoiVisibleTo(tx, access)}`;
    if (!d) throw notFoundError("Detection");

    const obsIds = [d.baseline_observation_id, d.comparison_observation_id].filter((x): x is string => Boolean(x));
    const obs = obsIds.length
      ? await tx<ObservationRow[]>`
          select o.id, o.aoi_id, o.kind, o.model_id, o.model_version, o.result_class, o.status, o.observed_at, o.processed_at,
                 o.metrics, o.quality, o.limitations, o.raster, o.run_id, ${ASSET_SQL(tx, "s")} as asset
            from observations o join source_assets s on s.id = o.asset_id
           where o.org_id = ${access.org.id} and o.id = any(${obsIds}::uuid[])`
      : [];
    const byId = new Map(obs.map((o) => [o.id, toObservation(o)]));
    const [run] = d.run_id
      ? await tx<NonNullable<DetectionDetail["run"]>[]>`
          select id, status, messages, parameters, outputs, software_version, started_at from processing_runs
           where id = ${d.run_id} and org_id = ${access.org.id}`
      : [];
    const relatedAlerts = await tx<DetectionDetail["relatedAlerts"]>`
      select id, title, status, severity, created_at from alerts where org_id = ${access.org.id} and detection_id = ${id} order by created_at desc`;
    const warnings = await tx<DetectionDetail["context"]["warnings"]>`
      select id, title, severity, event_start, event_end from external_events
       where org_id = ${access.org.id} and aoi_id = ${d.aoi_id} and event_kind = 'weather_warning'
         and coalesce(event_end, event_start, published_at) between ${d.first_observed_at}::timestamptz - interval '30 days' and ${d.last_observed_at}::timestamptz + interval '3 days'
       order by event_start desc nulls last limit 20`;
    const matches = await referenceMatches(tx, access.org.id, d.geometry);
    return {
      id: d.id,
      aoiId: d.aoi_id,
      aoiName: d.aoi_name,
      type: d.type,
      resultClass: d.result_class,
      title: d.title,
      geometry: d.geometry,
      bbox: d.bbox,
      centroid: d.centroid.coordinates,
      areaM2: d.area_m2,
      firstObservedAt: d.first_observed_at,
      lastObservedAt: d.last_observed_at,
      baseline: d.baseline_observation_id ? (byId.get(d.baseline_observation_id) ?? null) : null,
      comparison: d.comparison_observation_id ? (byId.get(d.comparison_observation_id) ?? null) : null,
      metrics: d.metrics,
      thresholds: d.thresholds,
      evidenceGrade: d.evidence_grade,
      evidenceReasons: d.evidence_reasons,
      limitations: d.limitations,
      verificationStatus: d.verification_status,
      verificationNote: d.verification_note,
      verifiedBy: d.verifier,
      verifiedAt: d.verified_at,
      model: d.model_id ? `${d.model_id}@${d.model_version}` : null,
      run: run ?? null,
      createdAt: d.created_at,
      relatedAlerts,
      context: { warnings },
      referenceMatches: matches,
      changeMap:
        run && typeof run.outputs.delta_png_key === "string" && Array.isArray(run.outputs.corners)
          ? {
              corners: run.outputs.corners as RasterRef["corners"],
              legend: { kind: "delta_ndvi", min: DELTA_NDVI_STOPS[0]!.value, max: DELTA_NDVI_STOPS.at(-1)!.value, stops: [...DELTA_NDVI_STOPS, MASKED_STOP] },
            }
          : null,
    };
  });
}

export const reviewSchema = z.object({
  status: z.enum(["needs_field_check", "confirmed", "dismissed", "unverified"]),
  note: z.string().trim().max(4000).optional(),
});

/** Record an analyst's verification decision. A detection becomes "confirmed" only through this. */
export async function reviewDetection(access: OrgAccess, id: string, raw: z.input<typeof reviewSchema>) {
  access.assert("detections.review");
  assertId(id, "Detection");
  const input = reviewSchema.parse(raw);
  if ((input.status === "confirmed" || input.status === "dismissed") && !input.note) {
    throw new DomainError("note_required", "Add a note explaining how this was confirmed or why it was dismissed.", 422, { note: "Required" });
  }
  return access.tx(async (tx) => {
    const [before] = await tx<{ verification_status: string }[]>`
      select d.verification_status from detections d join aois a on a.id = d.aoi_id
       where d.org_id = ${access.org.id} and d.id = ${id} ${aoiVisibleTo(tx, access)} for update of d`;
    if (!before) throw notFoundError("Detection");
    const userId = access.tenant.userId ?? null;
    await tx`
      update detections set verification_status = ${input.status}, verification_note = ${input.note ?? null},
             verified_by = ${input.status === "unverified" ? null : userId}, verified_at = ${input.status === "unverified" ? null : new Date()}
       where id = ${id} and org_id = ${access.org.id}`;
    if (input.note) {
      await tx`insert into notes (org_id, target_type, target_id, author_id, body)
               values (${access.org.id}, 'detection', ${id}, ${userId}, ${`[${input.status.replace(/_/g, " ")}] ${input.note}`})`;
    }
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "detection.review",
      targetType: "detection",
      targetId: id,
      metadata: { from: before.verification_status, to: input.status },
      ...access.meta,
    });
  });
}

// ── Notes ──────────────────────────────────────────────────────

export const NOTE_TARGETS = ["aoi", "detection", "alert", "observation", "report"] as const;
export type NoteTarget = (typeof NOTE_TARGETS)[number];

const NOTE_TABLE: Record<NoteTarget, string> = { aoi: "aois", detection: "detections", alert: "alerts", observation: "observations", report: "reports" };

async function assertNoteTarget(tx: Tx, access: OrgAccess, type: NoteTarget, id: string) {
  assertId(id, "Record");
  const rows = await tx`select 1 from ${tx(NOTE_TABLE[type])} where id = ${id} and org_id = ${access.org.id}`;
  if (rows.length === 0) throw notFoundError("Record");
}

export async function listNotes(access: OrgAccess, type: NoteTarget, id: string) {
  access.assert("results.read");
  return access.tx(async (tx) => {
    await assertNoteTarget(tx, access, type, id);
    return tx<{ id: string; body: string; author: string | null; created_at: Date }[]>`
      select n.id, n.body, u.name as author, n.created_at from notes n left join auth_user u on u.id = n.author_id
       where n.org_id = ${access.org.id} and n.target_type = ${type} and n.target_id = ${id} order by n.created_at`;
  });
}

export async function addNote(access: OrgAccess, type: NoteTarget, id: string, body: string) {
  access.assert("notes.write");
  const text = z.string().trim().min(1, "Write something first.").max(10_000).parse(body);
  return access.tx(async (tx) => {
    await assertNoteTarget(tx, access, type, id);
    const [n] = await tx<{ id: string }[]>`
      insert into notes (org_id, target_type, target_id, author_id, body) values (${access.org.id}, ${type}, ${id}, ${access.tenant.userId ?? null}, ${text})
      returning id`;
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "note.create", targetType: type, targetId: id, ...access.meta });
    return n!.id;
  });
}

// ── Environmental context ──────────────────────────────────────

export async function getAoiContext(access: OrgAccess, aoiId: string, days = 45) {
  access.assert("results.read");
  assertId(aoiId, "Area of interest");
  return access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    const weather = await tx<
      { provider_id: string; record_kind: string; variable: string; value: number | null; unit: string; valid_from: Date; valid_to: Date; issued_at: Date | null; retrieved_at: Date; station_id: string | null; station_distance_km: number | null }[]
    >`
      select provider_id, record_kind, variable, value, unit, valid_from, valid_to, issued_at, retrieved_at, station_id, station_distance_km
        from weather_records
       where org_id = ${access.org.id} and aoi_id = ${aoiId} and valid_from >= now() - make_interval(days => ${days})
       order by valid_from`;
    const warnings = await tx<
      { id: string; provider_id: string; title: string; description: string | null; severity: string | null; certainty: string | null; urgency: string | null; event_start: Date | null; event_end: Date | null; published_at: Date | null; source_url: string | null; claim_status: string; active: boolean }[]
    >`
      select id, provider_id, title, description, severity, certainty, urgency, event_start, event_end, published_at, source_url, claim_status,
             (event_end is null or event_end > now()) as active
        from external_events
       where org_id = ${access.org.id} and aoi_id = ${aoiId} and event_kind = 'weather_warning'
       order by coalesce(event_start, published_at) desc nulls last limit 50`;
    const news = await tx<
      { article_id: string; title: string; url: string; domain: string | null; published_at: Date | null; category: string; location_match: string; story_key: string; independent_sources: number }[]
    >`
      select n.id as article_id, n.title, n.url, n.domain, n.published_at, m.category, m.location_match, m.story_key,
             (select count(distinct n2.domain)::int from aoi_news_matches m2 join news_articles n2 on n2.id = m2.article_id
               where m2.aoi_id = m.aoi_id and m2.story_key = m.story_key) as independent_sources
        from aoi_news_matches m join news_articles n on n.id = m.article_id
       where m.org_id = ${access.org.id} and m.aoi_id = ${aoiId}
       order by n.published_at desc nulls last limit 100`;
    const [clock] = await tx<{ now: Date }[]>`select now() as now`;
    return { weather, warnings, news, now: clock!.now };
  });
}
