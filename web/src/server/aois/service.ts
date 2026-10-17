/**
 * Areas of interest — persistent, monitored geographies.
 *
 * - Geometry is validated in PostGIS (ST_IsValid) and stored as MultiPolygon
 *   in EPSG:4326; area is geodesic (geography). Points and lines are buffered
 *   by a user-supplied distance and the original shape is kept in input_geom.
 * - Every mutation is audited in the same transaction.
 * - Members with aoi_restricted see only AOIs granted to them; the filter is
 *   applied in every read path here (RLS handles the tenant boundary).
 * - Creating an AOI, or changing its geometry or data sources, queues an
 *   imagery backfill so its history fills in without user action.
 */
import { z } from "zod";
import { ANALYTIC_IDS, AOI_KINDS, DATA_SOURCE_IDS, defaultsForOrgKind, type AoiKind } from "@/lib/aoi-config";
import { aoiInputGeometrySchema, type Geometry } from "@/lib/geo";
import { currentModelKeys } from "@/server/analytics/registry";
import { recordAudit } from "@/server/audit";
import type { OrgAccess } from "@/server/authz/access";
import { env } from "@/server/config/env";
import { jsonb, type Tx } from "@/server/db/client";
import { createHash } from "node:crypto";
import { DomainError, notFoundError } from "@/server/errors";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { contextProvidersFor, enqueueContextSync } from "@/server/pipeline/context";

const metadataSchema = z
  .record(z.string().max(60), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 40, { message: "Too many metadata fields (max 40)." })
  .default({});

const termsSchema = z.array(z.string().trim().min(2).max(80)).max(20);

export const aoiCreateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(160),
    description: z.string().trim().max(4000).default(""),
    kind: z.enum(AOI_KINDS),
    parentId: z.uuid().nullable().default(null),
    geometry: aoiInputGeometrySchema,
    bufferM: z.number().positive().max(50_000).optional(),
    metadata: metadataSchema,
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    monitoringEnabled: z.boolean().default(true),
    monitoringIntervalHours: z.number().int().min(1).max(8760).optional(),
    dataSources: z.array(z.enum(DATA_SOURCE_IDS)).max(20).optional(),
    enabledAnalytics: z.array(z.enum(ANALYTIC_IDS)).max(20).optional(),
    maxCloudCover: z.number().min(0).max(100).optional(),
    newsTerms: termsSchema.default([]),
  })
  .refine((v) => (v.geometry.type === "Point" || v.geometry.type === "LineString" ? v.bufferM !== undefined : true), {
    message: "Points and lines need a buffer distance in metres.",
    path: ["bufferM"],
  });
export type AoiCreateInput = z.input<typeof aoiCreateSchema>;

export const aoiUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000),
    kind: z.enum(AOI_KINDS),
    parentId: z.uuid().nullable(),
    geometry: aoiInputGeometrySchema,
    bufferM: z.number().positive().max(50_000),
    metadata: metadataSchema,
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    monitoringEnabled: z.boolean(),
    monitoringIntervalHours: z.number().int().min(1).max(8760),
    dataSources: z.array(z.enum(DATA_SOURCE_IDS)).max(20),
    enabledAnalytics: z.array(z.enum(ANALYTIC_IDS)).max(20),
    maxCloudCover: z.number().min(0).max(100),
    newsTerms: termsSchema,
  })
  .partial();
export type AoiUpdateInput = z.input<typeof aoiUpdateSchema>;

export type BoundarySource = {
  method: "drawn" | "uploaded" | "imported" | "synthetic";
  provider?: string;
  external_id?: string;
  retrieved_at?: string;
  license?: string;
  upload_id?: string;
  note?: string;
};

export type AoiSummary = {
  id: string;
  name: string;
  kind: AoiKind;
  status: "active" | "archived";
  parentId: string | null;
  areaM2: number;
  labelPoint: [number, number];
  bbox: [number, number, number, number];
  isSynthetic: boolean;
  monitoringEnabled: boolean;
  lastCheckedAt: Date | null;
  nextCheckAt: Date | null;
  createdAt: Date;
  tags: string[];
};

export type AoiDetail = AoiSummary & {
  description: string;
  geometry: Geometry;
  inputGeometry: Geometry | null;
  inputBufferM: number | null;
  boundarySource: BoundarySource;
  metadata: Record<string, string | number | boolean | null>;
  monitoringIntervalHours: number;
  dataSources: string[];
  enabledAnalytics: string[];
  maxCloudCover: number;
  newsTerms: string[];
  createdBy: string | null;
  updatedAt: Date;
  archivedAt: Date | null;
};

type AoiRow = {
  id: string;
  name: string;
  kind: AoiKind;
  status: "active" | "archived";
  parent_id: string | null;
  area_m2: number;
  label: { coordinates: [number, number] };
  bbox: [number, number, number, number];
  is_synthetic: boolean;
  monitoring_enabled: boolean;
  last_checked_at: Date | null;
  next_check_at: Date | null;
  created_at: Date;
  tags: string[];
};

function toSummary(r: AoiRow): AoiSummary {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    parentId: r.parent_id,
    areaM2: r.area_m2,
    labelPoint: r.label.coordinates,
    bbox: r.bbox,
    isSynthetic: r.is_synthetic,
    monitoringEnabled: r.monitoring_enabled,
    lastCheckedAt: r.last_checked_at,
    nextCheckAt: r.next_check_at,
    createdAt: r.created_at,
    tags: r.tags,
  };
}

/** SQL fragment limiting rows of alias `a` to AOIs the member may see. */
export function aoiVisibleTo(tx: Tx, access: OrgAccess) {
  if (!access.aoiRestricted || !access.membershipId) return tx``;
  return tx`and exists (select 1 from aoi_grants g where g.aoi_id = a.id and g.membership_id = ${access.membershipId})`;
}

const SUMMARY_COLUMNS = (tx: Tx) => tx`
  a.id, a.name, a.kind, a.status, a.parent_id, a.area_m2,
  ST_AsGeoJSON(a.label_point, 7)::json as label,
  array[ST_XMin(a.geom), ST_YMin(a.geom), ST_XMax(a.geom), ST_YMax(a.geom)]::float8[] as bbox,
  a.is_synthetic, a.monitoring_enabled, a.last_checked_at, a.next_check_at, a.created_at, a.tags`;

export async function listAois(
  access: OrgAccess,
  opts: { status?: "active" | "archived" | "all"; kind?: AoiKind; parentId?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: AoiSummary[]; total: number }> {
  access.assert("aoi.read");
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  return access.tx(async (tx) => {
    const status = opts.status ?? "active";
    const where = tx`
      where a.org_id = ${access.org.id}
      ${status === "all" ? tx`` : tx`and a.status = ${status}`}
      ${opts.kind ? tx`and a.kind = ${opts.kind}` : tx``}
      ${opts.parentId ? tx`and a.parent_id = ${opts.parentId}` : tx``}
      ${opts.q ? tx`and a.name ilike ${"%" + opts.q.replace(/[%_\\]/g, "\\$&") + "%"}` : tx``}
      ${aoiVisibleTo(tx, access)}`;
    const rows = await tx<AoiRow[]>`select ${SUMMARY_COLUMNS(tx)} from aois a ${where} order by a.name limit ${limit} offset ${offset}`;
    const [count] = await tx<{ n: number }[]>`select count(*)::int as n from aois a ${where}`;
    return { items: rows.map(toSummary), total: count?.n ?? 0 };
  });
}

export async function getAoi(access: OrgAccess, id: string, tx?: Tx): Promise<AoiDetail> {
  access.assert("aoi.read");
  if (!z.uuid().safeParse(id).success) throw notFoundError("Area of interest");
  const run = async (t: Tx) => {
    const [r] = await t<
      (AoiRow & {
        description: string;
        geometry: Geometry;
        input_geometry: Geometry | null;
        input_buffer_m: number | null;
        boundary_source: BoundarySource;
        metadata: Record<string, string | number | boolean | null>;
        monitoring_interval_hours: number;
        data_sources: string[];
        enabled_analytics: string[];
        max_cloud_cover: string;
        news_terms: string[];
        created_by: string | null;
        updated_at: Date;
        archived_at: Date | null;
      })[]
    >`
      select ${SUMMARY_COLUMNS(t)}, a.description,
             ST_AsGeoJSON(a.geom, 7)::json as geometry,
             ST_AsGeoJSON(a.input_geom, 7)::json as input_geometry,
             a.input_buffer_m, a.boundary_source, a.metadata, a.monitoring_interval_hours,
             a.data_sources, a.enabled_analytics, a.max_cloud_cover, a.news_terms,
             a.created_by, a.updated_at, a.archived_at
        from aois a
       where a.id = ${id} and a.org_id = ${access.org.id} ${aoiVisibleTo(t, access)}`;
    if (!r) throw notFoundError("Area of interest");
    return {
      ...toSummary(r),
      description: r.description,
      geometry: r.geometry,
      inputGeometry: r.input_geometry,
      inputBufferM: r.input_buffer_m,
      boundarySource: r.boundary_source,
      metadata: r.metadata,
      monitoringIntervalHours: r.monitoring_interval_hours,
      dataSources: r.data_sources,
      enabledAnalytics: r.enabled_analytics,
      maxCloudCover: Number(r.max_cloud_cover),
      newsTerms: r.news_terms,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
    } satisfies AoiDetail;
  };
  return tx ? run(tx) : access.tx(run);
}

/** Build the analysis geometry expression (MultiPolygon, EPSG:4326) for a validated input. */
function geometrySql(tx: Tx, geometry: Geometry, bufferM: number | undefined) {
  const gj = JSON.stringify(geometry);
  if (geometry.type === "Point" || geometry.type === "LineString") {
    return tx`ST_Multi(ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON(${gj}), 4326)::geography, ${bufferM ?? 0}, 'quad_segs=16')::geometry)`;
  }
  return tx`ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${gj}), 4326))`;
}

async function checkGeometry(tx: Tx, geometry: Geometry, bufferM: number | undefined) {
  const [g] = await tx<{ valid: boolean; reason: string; area: number }[]>`
    with g as (select ${geometrySql(tx, geometry, bufferM)} as geom)
    select ST_IsValid(geom) as valid, ST_IsValidReason(geom) as reason, ST_Area(geom::geography) as area from g`;
  if (!g) throw new DomainError("invalid_geometry", "The geometry could not be read.");
  if (!g.valid) {
    throw new DomainError(
      "invalid_geometry",
      /Self-intersection|Ring Self-intersection/i.test(g.reason)
        ? "The boundary crosses itself. Redraw it so edges do not intersect."
        : `The boundary is not a valid polygon (${g.reason}).`,
      422,
      { geometry: "Invalid boundary" },
    );
  }
  if (g.area < 100) throw new DomainError("invalid_geometry", "The area is smaller than 100 m², below the resolution of any monitored source.", 422);
  const maxKm2 = env.maxAoiAreaKm2();
  if (g.area > maxKm2 * 1_000_000) {
    throw new DomainError("too_large", `The area is ${(g.area / 1e6).toFixed(0)} km²; the limit is ${maxKm2} km². Split it into smaller areas.`, 422);
  }
  return g.area;
}

async function assertParent(tx: Tx, access: OrgAccess, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw new DomainError("invalid", "An area cannot be its own parent.");
  const [p] = await tx`select id from aois where id = ${parentId} and org_id = ${access.org.id}`;
  if (!p) throw new DomainError("invalid", "The parent area does not exist.", 422, { parentId: "Unknown parent" });
}

/** Queue a historical imagery search and a context refresh for an AOI. */
/** Follow-up analyses that read stored results of earlier images rather than imagery. */
const FOLLOW_UP_ANALYTICS = new Set(["ndvi-zones", "ndvi-change", "ndvi-anomaly", "water-change"]);
export const BACKFILL_DAYS = 180;
export const BACKFILL_MAX_ITEMS = 200;

/**
 * Analytics enabled after images were already processed would otherwise only
 * apply to new imagery: images already linked to the area are never queued
 * again. Queue them (most recent first, at most BACKFILL_MAX_ITEMS within
 * BACKFILL_DAYS): per-image processing computes only the method versions an
 * image lacks, and follow-up analyses run only for what was just enabled.
 */
export async function queueAnalyticsBackfill(
  tx: Tx,
  p: { orgId: string; aoiId: string; enabled: string[]; added: string[]; createdBy: string | null },
): Promise<{ processing: number; followUps: number }> {
  const stamp = createHash("sha1").update([...p.enabled].sort().join(",")).digest("hex").slice(0, 12);
  const assets = await tx<{ asset_id: string }[]>`
    select l.asset_id from aoi_assets l join source_assets s on s.id = l.asset_id
     where l.aoi_id = ${p.aoiId} and l.org_id = ${p.orgId} and l.status in ('processed', 'unusable')
       and s.acquired_at > now() - make_interval(days => ${BACKFILL_DAYS})
     order by s.acquired_at desc limit ${BACKFILL_MAX_ITEMS}`;
  for (const a of assets) {
    await enqueueTx(tx, {
      orgId: p.orgId,
      type: JOB.aoiProcessAsset,
      payload: { aoiId: p.aoiId, assetId: a.asset_id, reason: "analytics_enabled", reprocess: true },
      priority: 65,
      timeoutSeconds: 900,
      idempotencyKey: `process:${p.aoiId}:${a.asset_id}:analytics:${stamp}`,
      createdBy: p.createdBy,
    });
  }
  const followUps = p.added.filter((a) => FOLLOW_UP_ANALYTICS.has(a));
  let followUpJobs = 0;
  if (followUps.length) {
    const kinds = [
      ...(followUps.some((f) => f !== "water-change") ? ["ndvi"] : []),
      ...(followUps.includes("water-change") ? ["ndwi", "s1_water"] : []),
    ];
    const observations = await tx<{ id: string }[]>`
      select o.id from observations o
       where o.aoi_id = ${p.aoiId} and o.org_id = ${p.orgId} and o.status = 'valid' and o.is_current and o.kind = any(${kinds}::text[])
         and o.observed_at > now() - make_interval(days => ${BACKFILL_DAYS})
       order by o.observed_at desc limit ${BACKFILL_MAX_ITEMS}`;
    for (const o of observations) {
      await enqueueTx(tx, {
        orgId: p.orgId,
        type: JOB.aoiChangeDetection,
        payload: { aoiId: p.aoiId, observationId: o.id, reprocess: true, historical: true, followUps },
        priority: 70,
        timeoutSeconds: 600,
        idempotencyKey: `change:${o.id}:followups:${stamp}`,
        createdBy: p.createdBy,
      });
    }
    followUpJobs = observations.length;
  }
  return { processing: assets.length, followUps: followUpJobs };
}

export async function queueAoiRefresh(tx: Tx, access: OrgAccess | { org: { id: string }; actorId: string | null }, aoiId: string, reason: string) {
  const orgId = access.org.id;
  const createdBy = "principal" in access ? (access.principal.type === "user" ? access.principal.userId : null) : access.actorId;
  const stamp = Date.now();
  await enqueueTx(tx, {
    orgId,
    type: JOB.aoiCatalogSync,
    payload: { aoiId, mode: "backfill", lookbackDays: 180, reason },
    priority: 50,
    idempotencyKey: `aoi:${aoiId}:backfill:${stamp}`,
    createdBy,
    timeoutSeconds: 600,
  });
  // Context (weather, warnings, news): one job per provider, never a second
  // one while the first is still waiting — an area created and immediately
  // edited used to queue two simultaneous syncs.
  const [aoi] = await tx<{ data_sources: string[]; news_terms: string[] }[]>`
    select data_sources, news_terms from aois where id = ${aoiId} and org_id = ${orgId}`;
  if (aoi) {
    await enqueueContextSync(tx, {
      orgId,
      aoiId,
      providers: contextProvidersFor(aoi),
      reason,
      priority: 60,
      key: `refresh:${Math.floor(stamp / 600_000)}`,
      createdBy,
    });
  }
}

export async function createAoi(
  access: OrgAccess,
  raw: AoiCreateInput,
  opts: { boundarySource?: BoundarySource; isSynthetic?: boolean; tx?: Tx } = {},
): Promise<AoiDetail> {
  access.assert("aoi.write");
  const input = aoiCreateSchema.parse(raw);
  const defaults = defaultsForOrgKind(access.org.kind);
  const source: BoundarySource = opts.boundarySource ?? { method: "drawn", retrieved_at: new Date().toISOString() };
  const createdBy = access.principal.type === "user" ? access.principal.userId : access.principal.type === "api_key" ? access.principal.createdBy : null;

  const run = async (tx: Tx) => {
    await assertParent(tx, access, input.parentId);
    const area = await checkGeometry(tx, input.geometry, input.bufferM);
    const [row] = await tx<{ id: string }[]>`
      insert into aois (
        org_id, parent_id, name, description, kind, geom, input_geom, input_buffer_m, boundary_source, is_synthetic,
        metadata, tags, monitoring_enabled, monitoring_interval_hours, next_check_at,
        data_sources, enabled_analytics, max_cloud_cover, news_terms, created_by
      ) values (
        ${access.org.id}, ${input.parentId}, ${input.name}, ${input.description}, ${input.kind},
        ${geometrySql(tx, input.geometry, input.bufferM)},
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)}), 4326),
        ${input.bufferM ?? null}, ${jsonb(source)}::jsonb, ${opts.isSynthetic ?? false},
        ${jsonb(input.metadata)}::jsonb, ${input.tags}, ${input.monitoringEnabled},
        ${input.monitoringIntervalHours ?? defaults.intervalHours},
        now() + make_interval(hours => ${input.monitoringIntervalHours ?? defaults.intervalHours}),
        ${input.dataSources ?? defaults.dataSources}, ${input.enabledAnalytics ?? defaults.analytics},
        ${input.maxCloudCover ?? defaults.maxCloudCover}, ${input.newsTerms}, ${createdBy}
      ) returning id`;
    const id = row!.id;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "aoi.create",
      targetType: "aoi",
      targetId: id,
      metadata: { name: input.name, kind: input.kind, area_m2: Math.round(area), boundary: source.method, synthetic: opts.isSynthetic ?? false },
      ...access.meta,
    });
    if (input.monitoringEnabled) await queueAoiRefresh(tx, access, id, "created");
    return getAoi(access, id, tx);
  };
  return opts.tx ? run(opts.tx) : access.tx(run);
}

export async function updateAoi(access: OrgAccess, id: string, raw: AoiUpdateInput): Promise<AoiDetail> {
  access.assert("aoi.write");
  const input = aoiUpdateSchema.parse(raw);
  return access.tx(async (tx) => {
    const before = await getAoi(access, id, tx);
    if (before.status === "archived") throw new DomainError("archived", "Archived areas cannot be edited. Restore it first.", 409);
    await assertParent(tx, access, input.parentId, id);
    const geometryChanged = input.geometry !== undefined;
    let area: number | undefined;
    if (geometryChanged) {
      const g = input.geometry!;
      if ((g.type === "Point" || g.type === "LineString") && input.bufferM === undefined) {
        throw new DomainError("invalid", "Points and lines need a buffer distance in metres.", 422, { bufferM: "Required" });
      }
      area = await checkGeometry(tx, g, input.bufferM);
    }
    await tx`
      update aois set
        name = coalesce(${input.name ?? null}, name),
        description = coalesce(${input.description ?? null}, description),
        kind = coalesce(${input.kind ?? null}::aoi_kind, kind),
        parent_id = ${input.parentId === undefined ? tx`parent_id` : tx`${input.parentId}`},
        metadata = coalesce(${input.metadata === undefined ? null : jsonb(input.metadata)}::jsonb, metadata),
        tags = coalesce(${input.tags ?? null}::text[], tags),
        monitoring_enabled = coalesce(${input.monitoringEnabled ?? null}, monitoring_enabled),
        monitoring_interval_hours = coalesce(${input.monitoringIntervalHours ?? null}, monitoring_interval_hours),
        data_sources = coalesce(${input.dataSources ?? null}::text[], data_sources),
        enabled_analytics = coalesce(${input.enabledAnalytics ?? null}::text[], enabled_analytics),
        max_cloud_cover = coalesce(${input.maxCloudCover ?? null}, max_cloud_cover),
        news_terms = coalesce(${input.newsTerms ?? null}::text[], news_terms)
      where id = ${id} and org_id = ${access.org.id}`;
    if (geometryChanged) {
      await tx`
        update aois set
          geom = ${geometrySql(tx, input.geometry!, input.bufferM)},
          input_geom = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)}), 4326),
          input_buffer_m = ${input.bufferM ?? null},
          boundary_source = ${jsonb({ method: "drawn", retrieved_at: new Date().toISOString(), note: "Boundary edited" })}::jsonb,
          is_synthetic = false
        where id = ${id} and org_id = ${access.org.id}`;
    }
    const changed = Object.keys(input);
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "aoi.update",
      targetType: "aoi",
      targetId: id,
      metadata: {
        fields: changed,
        ...(geometryChanged ? { area_m2_before: Math.round(before.areaM2), area_m2_after: Math.round(area ?? 0) } : {}),
      },
      ...access.meta,
    });
    const after = await getAoi(access, id, tx);
    const sourcesAdded = input.dataSources?.some((s) => !before.dataSources.includes(s)) ?? false;
    if (after.monitoringEnabled && (geometryChanged || sourcesAdded || (input.monitoringEnabled && !before.monitoringEnabled))) {
      await queueAoiRefresh(tx, access, id, geometryChanged ? "geometry_changed" : "sources_changed");
    }
    const analyticsAdded = (input.enabledAnalytics ?? []).filter((a) => !before.enabledAnalytics.includes(a));
    if (analyticsAdded.length && after.status === "active") {
      await queueAnalyticsBackfill(tx, {
        orgId: access.org.id,
        aoiId: id,
        enabled: after.enabledAnalytics,
        added: analyticsAdded,
        createdBy: access.principal.type === "user" ? access.principal.userId : null,
      });
    }
    return after;
  });
}

export async function setAoiArchived(access: OrgAccess, id: string, archived: boolean): Promise<AoiDetail> {
  access.assert("aoi.write");
  return access.tx(async (tx) => {
    await getAoi(access, id, tx);
    await tx`
      update aois set
        status = ${archived ? "archived" : "active"}::aoi_status,
        archived_at = ${archived ? tx`now()` : tx`null`},
        monitoring_enabled = case when ${archived} then false else monitoring_enabled end
      where id = ${id} and org_id = ${access.org.id}`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: archived ? "aoi.archive" : "aoi.restore",
      targetType: "aoi",
      targetId: id,
      ...access.meta,
    });
    return getAoi(access, id, tx);
  });
}

/** Lightweight GeoJSON of every visible AOI for the map. */
export async function aoiFeatureCollection(access: OrgAccess, status: "active" | "archived" | "all" = "active") {
  access.assert("aoi.read");
  return access.tx(async (tx) => {
    const rows = await tx<{ feature: GeoJSON.Feature }[]>`
      select json_build_object(
        'type', 'Feature',
        'id', a.id,
        'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(a.geom, 0.000005), 7)::json,
        'properties', json_build_object(
          'id', a.id, 'name', a.name, 'kind', a.kind, 'status', a.status, 'area_m2', a.area_m2,
          'parent_id', a.parent_id, 'is_synthetic', a.is_synthetic, 'monitoring', a.monitoring_enabled,
          'last_checked_at', a.last_checked_at,
          'open_alerts', (select count(*) from alerts al where al.aoi_id = a.id and al.status in ('open','acknowledged')),
          'unreviewed_detections', (select count(*) from detections d where d.aoi_id = a.id and d.verification_status = 'unverified'
                                      and d.evidence_grade in ('moderate', 'strong') and d.model_id || '@' || d.model_version = any(${currentModelKeys()}))
        )
      ) as feature
      from aois a
      where a.org_id = ${access.org.id} ${status === "all" ? tx`` : tx`and a.status = ${status}`} ${aoiVisibleTo(tx, access)}
      order by a.area_m2 desc`;
    return { type: "FeatureCollection" as const, features: rows.map((r) => r.feature) };
  });
}
