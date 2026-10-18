/**
 * Season comparisons: request, list, and read.
 *
 *  - Requesting one needs analysis.run and an active AOI the caller can see;
 *    the periods must be season-matched (periods.ts). An identical request
 *    still in progress is returned instead of starting a second one.
 *  - Reading needs results.read and the AOI's visibility (404 otherwise, as
 *    for the AOI itself). Findings are the comparison's own detections.
 */
import { z } from "zod";
import type { OrgAccess } from "@/server/authz/access";
import { recordAudit } from "@/server/audit";
import { aoiVisibleTo, getAoi } from "@/server/aois/service";
import { jsonb, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { COMPARISON_COLLECTION, COMPARISON_PRODUCT } from "./handlers";
import type { Outcome } from "./outcomes";
import { validatePeriods, type Window } from "./periods";
import type { Decision } from "./select";

export type ComparisonStatus = "queued" | "searching" | "processing" | "comparing" | "done" | "failed";

export type ComparisonSummary = {
  id: string;
  aoiId: string;
  aoiName: string;
  collection: string;
  baseline: Window;
  comparison: Window;
  status: ComparisonStatus;
  outcome: Outcome | null;
  outcomeDetail: string | null;
  findings: number;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type ChosenImage = {
  observationId: string;
  assetId: string;
  externalId: string;
  platform: string | null;
  acquiredAt: Date;
  gridCode: string | null;
  epsg: number | null;
  clearFraction: number | null;
  coverageFraction: number | null;
  sceneCloudCover: number | null;
  license: string | null;
  attribution: string | null;
  stacUrl: string | null;
  trueColorKey: string | null;
  corners: [[number, number], [number, number], [number, number], [number, number]] | null;
};

export type ComparisonFinding = {
  id: string;
  type: string;
  title: string;
  areaM2: number | null;
  meanDelta: number | null;
  direction: string | null;
  pixelCount: number | null;
  evidenceGrade: string;
  evidenceReasons: string[];
  verificationStatus: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
  geometry: { type: string; coordinates: unknown };
};

export type ComparisonDetail = ComparisonSummary & {
  selection: {
    decisions?: { baseline: Decision[]; comparison: Decision[] };
    notes?: Record<string, string | null>;
    windows?: unknown;
  };
  result: Record<string, unknown> | null;
  images: { baseline: ChosenImage | null; comparison: ChosenImage | null };
  items: ComparisonFinding[];
};

type Row = {
  id: string;
  aoi_id: string;
  aoi_name: string;
  collection: string;
  baseline_from: string;
  baseline_to: string;
  comparison_from: string;
  comparison_to: string;
  status: ComparisonStatus;
  outcome: Outcome | null;
  outcome_detail: string | null;
  findings: number;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
};

const COLUMNS = (tx: Tx) => tx`
  c.id, c.aoi_id, a.name as aoi_name, c.collection,
  to_char(c.baseline_from, 'YYYY-MM-DD') as baseline_from, to_char(c.baseline_to, 'YYYY-MM-DD') as baseline_to,
  to_char(c.comparison_from, 'YYYY-MM-DD') as comparison_from, to_char(c.comparison_to, 'YYYY-MM-DD') as comparison_to,
  c.status, c.outcome, c.outcome_detail, c.error, c.created_at, c.completed_at,
  (select count(*)::int from detections d where d.comparison_id = c.id) as findings`;

const toSummary = (r: Row): ComparisonSummary => ({
  id: r.id,
  aoiId: r.aoi_id,
  aoiName: r.aoi_name,
  collection: r.collection,
  baseline: { from: r.baseline_from, to: r.baseline_to },
  comparison: { from: r.comparison_from, to: r.comparison_to },
  status: r.status,
  outcome: r.outcome,
  outcomeDetail: r.outcome_detail,
  findings: r.findings,
  error: r.error,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

const userId = (access: OrgAccess) => (access.principal.type === "user" ? access.principal.userId : null);

export async function createComparison(access: OrgAccess, aoiId: string, input: unknown, today: Date = new Date()): Promise<ComparisonSummary> {
  access.assert("analysis.run");
  const periods = validatePeriods(input, today);
  return access.tx(async (tx) => {
    const aoi = await getAoi(access, aoiId, tx);
    if (aoi.status !== "active") throw new DomainError("archived", "Archived areas are not analysed.", 409);
    const [running] = await tx<Row[]>`
      select ${COLUMNS(tx)} from comparisons c join aois a on a.id = c.aoi_id
       where c.org_id = ${access.org.id} and c.aoi_id = ${aoiId} and c.status not in ('done', 'failed')
         and c.baseline_from = ${periods.baseline.from} and c.baseline_to = ${periods.baseline.to}
         and c.comparison_from = ${periods.comparison.from} and c.comparison_to = ${periods.comparison.to}`;
    if (running) return toSummary(running);
    const [row] = await tx<{ id: string }[]>`
      insert into comparisons (org_id, aoi_id, product_id, collection, baseline_from, baseline_to, comparison_from, comparison_to,
                               selection, created_by)
      values (${access.org.id}, ${aoiId}, ${COMPARISON_PRODUCT}, ${COMPARISON_COLLECTION},
              ${periods.baseline.from}, ${periods.baseline.to}, ${periods.comparison.from}, ${periods.comparison.to},
              ${jsonb({ years_apart: periods.yearsApart, start_offset_days: periods.startOffsetDays })}::jsonb, ${userId(access)})
      returning id`;
    const id = row!.id;
    await enqueueTx(tx, {
      orgId: access.org.id,
      type: JOB.comparisonPrepare,
      payload: { comparisonId: id },
      // A person is waiting: ahead of background imagery work.
      priority: 30,
      idempotencyKey: `comparison.prepare:${id}`,
      createdBy: userId(access),
      timeoutSeconds: 600,
    });
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "comparison.create",
      targetType: "comparison",
      targetId: id,
      metadata: {
        aoi_id: aoiId,
        baseline: periods.baseline,
        comparison: periods.comparison,
      },
      ...access.meta,
    });
    const [created] = await tx<Row[]>`select ${COLUMNS(tx)} from comparisons c join aois a on a.id = c.aoi_id where c.id = ${id}`;
    return toSummary(created!);
  });
}

export async function listComparisons(access: OrgAccess, aoiId: string, limit = 20): Promise<ComparisonSummary[]> {
  access.assert("results.read");
  return access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    const rows = await tx<Row[]>`
      select ${COLUMNS(tx)} from comparisons c join aois a on a.id = c.aoi_id
       where c.org_id = ${access.org.id} and c.aoi_id = ${aoiId}
       order by c.created_at desc limit ${Math.min(Math.max(limit, 1), 100)}`;
    return rows.map(toSummary);
  });
}

/** One comparison with its chosen images and findings, or 404 when it does not exist or is out of scope. */
export async function getComparison(access: OrgAccess, id: string, tx?: Tx): Promise<ComparisonDetail> {
  access.assert("results.read");
  if (!z.uuid().safeParse(id).success) throw notFoundError("Comparison");
  const run = async (t: Tx) => {
    const detail = await readComparison(t, access.org.id, id, aoiVisibleTo(t, access));
    if (!detail) throw notFoundError("Comparison");
    return detail;
  };
  return tx ? run(tx) : access.tx(run);
}

/**
 * Read one comparison within an organization. `scope` narrows to the AOIs
 * a caller may see (aoiVisibleTo, alias a); report generation passes none,
 * because visibility was checked when the report was requested.
 */
export async function readComparison(t: Tx, orgId: string, id: string, scope: ReturnType<typeof aoiVisibleTo>): Promise<ComparisonDetail | null> {
  const [row] = await t<
    (Row & {
      selection: ComparisonDetail["selection"];
      result: Record<string, unknown> | null;
      baseline_observation_id: string | null;
      comparison_observation_id: string | null;
    })[]
  >`
      select ${COLUMNS(t)}, c.selection, c.result, c.baseline_observation_id, c.comparison_observation_id
        from comparisons c join aois a on a.id = c.aoi_id
       where c.id = ${id} and c.org_id = ${orgId} ${scope}`;
  if (!row) return null;
  const image = async (obsId: string | null): Promise<ChosenImage | null> => {
    if (!obsId) return null;
    const [o] = await t<
      {
        observation_id: string;
        asset_id: string;
        external_id: string;
        platform: string | null;
        acquired_at: Date;
        grid_code: string | null;
        epsg: number | null;
        metrics: Record<string, unknown>;
        quality: { coverage_fraction?: number; masked_fraction?: number };
        cloud_cover: number | null;
        license: string | null;
        attribution: string | null;
        stac_url: string | null;
        raster: {
          true_color_key?: string;
          corners?: ChosenImage["corners"];
        } | null;
      }[]
    >`
        select o.id as observation_id, s.id as asset_id, s.external_id, s.platform, s.acquired_at, s.grid_code, s.epsg,
               o.metrics, o.quality, s.cloud_cover::float8 as cloud_cover, s.license, s.attribution, s.stac_url, o.raster
          from observations o join source_assets s on s.id = o.asset_id
         where o.id = ${obsId} and o.org_id = ${orgId}`;
    if (!o) return null;
    return {
      observationId: o.observation_id,
      assetId: o.asset_id,
      externalId: o.external_id,
      platform: o.platform,
      acquiredAt: o.acquired_at,
      gridCode: o.grid_code,
      epsg: o.epsg,
      clearFraction: typeof o.metrics.valid_fraction === "number" ? (o.metrics.valid_fraction as number) : null,
      coverageFraction: o.quality.coverage_fraction ?? null,
      sceneCloudCover: o.cloud_cover,
      license: o.license,
      attribution: o.attribution,
      stacUrl: o.stac_url,
      trueColorKey: o.raster?.true_color_key ?? null,
      corners: o.raster?.corners ?? null,
    };
  };
  const items = await t<
    {
      id: string;
      type: string;
      title: string;
      area_m2: number | null;
      metrics: Record<string, unknown>;
      evidence_grade: string;
      evidence_reasons: string[];
      verification_status: string;
      centroid: [number, number];
      bbox: [number, number, number, number];
      geometry: { type: string; coordinates: unknown };
    }[]
  >`
      select d.id, d.type, d.title, d.area_m2, d.metrics, d.evidence_grade, d.evidence_reasons, d.verification_status,
             array[ST_X(ST_Centroid(d.geom)), ST_Y(ST_Centroid(d.geom))]::float8[] as centroid,
             array[ST_XMin(d.geom), ST_YMin(d.geom), ST_XMax(d.geom), ST_YMax(d.geom)]::float8[] as bbox,
             ST_AsGeoJSON(d.geom, 7)::json as geometry
        from detections d
       where d.comparison_id = ${id} and d.org_id = ${orgId}
       order by d.area_m2 desc nulls last, d.id`;
  return {
    ...toSummary(row),
    selection: row.selection,
    result: row.result,
    images: {
      baseline: await image(row.baseline_observation_id),
      comparison: await image(row.comparison_observation_id),
    },
    items: items.map((d) => ({
      id: d.id,
      type: d.type,
      title: d.title,
      areaM2: d.area_m2,
      meanDelta: typeof d.metrics.mean_delta === "number" ? (d.metrics.mean_delta as number) : null,
      direction: typeof d.metrics.direction === "string" ? (d.metrics.direction as string) : null,
      pixelCount: typeof d.metrics.pixel_count === "number" ? (d.metrics.pixel_count as number) : null,
      evidenceGrade: d.evidence_grade,
      evidenceReasons: d.evidence_reasons,
      verificationStatus: d.verification_status,
      centroid: d.centroid,
      bbox: d.bbox,
      geometry: d.geometry,
    })),
  };
}
