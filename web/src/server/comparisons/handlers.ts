/**
 * Season-comparison jobs.
 *
 *   comparison.prepare  search both periods in the Sentinel-2 L2A catalog,
 *                       link the clearest scenes (by catalog cloud cover) to
 *                       the area, and queue them for the normal analysis
 *                       pipeline (aoi.process_asset), ahead of background work.
 *   comparison.compare  wait (re-queuing itself) until those images are
 *                       analysed, choose the pair (select.ts), compare it with
 *                       the ndvi-period-change method, store the candidate
 *                       changes as detections linked to the comparison, and
 *                       record the outcome.
 *
 * Images are analysed by the same code as monitoring, so a comparison's
 * observations are ordinary history of the area (old ones are flagged
 * historical, so they never notify). Every "nothing to compare" case ends
 * with an explicit outcome (outcomes.ts), never a silent substitute.
 */
import { createHash } from "node:crypto";
import { bboxToPolygon, type BBox } from "@/lib/geo";
import { detectNdviChange } from "@/server/analytics/change";
import { ANALYTICS } from "@/server/analytics/registry";
import { renderContinuous } from "@/server/analytics/render";
import type { ObservationQuality, RasterRef } from "@/server/analytics/types";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/config/env";
import { jsonb, withTenant, type Tx } from "@/server/db/client";
import { enqueueTx, PermanentJobError } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobContext, JobHandler } from "@/server/jobs/worker";
import { linkAndQueue, matchAssets, PROCESSING_SET_VERSION, upsertSourceAssets } from "@/server/pipeline/assets";
import { gradeEvidence, loadAlignedPair, MIN_AREA_M2, NDVI_THRESHOLD, titleFor, type ObsRow } from "@/server/pipeline/change";
import { getImageryProduct } from "@/server/providers/imagery";
import { orgKey, storage } from "@/server/storage";
import { seasonalOffsetDays } from "./periods";
import { type Outcome } from "./outcomes";
import { selectPair, type Candidate, type Decision } from "./select";

export const COMPARISON_PRODUCT = "earth-search:sentinel-2-l2a";
export const COMPARISON_COLLECTION = "sentinel-2-l2a";
/** Scenes analysed per period, clearest (catalog cloud cover) first. */
export const SCENES_PER_WINDOW = 8;
/** Below this share of the area clear in both images, nothing is compared. */
export const MIN_OVERLAP = 0.3;
/** How long the compare step waits for the images to be analysed. */
export const MAX_WAIT_MS = 45 * 60_000;
const CHECK_INTERVAL_MS = 20_000;
const DAY_MS = 86_400_000;

type Window = "baseline" | "comparison";
type ComparisonRow = {
  id: string;
  org_id: string;
  aoi_id: string;
  baseline_from: string;
  baseline_to: string;
  comparison_from: string;
  comparison_to: string;
  status: string;
  selection: { windows?: Record<Window, { asset_ids: string[]; found: number; analysed: number; not_analysed: number }> } & Record<string, unknown>;
  created_by: string | null;
  started_at: Date | null;
};

const windowBounds = (c: ComparisonRow, w: Window) => {
  const from = new Date(`${w === "baseline" ? c.baseline_from : c.comparison_from}T00:00:00Z`);
  const to = new Date(new Date(`${w === "baseline" ? c.baseline_to : c.comparison_to}T00:00:00Z`).getTime() + DAY_MS);
  return { from, to };
};

async function loadComparison(orgId: string, id: string): Promise<ComparisonRow | null> {
  return withTenant({ orgId }, async (tx) => {
    const [c] = await tx<ComparisonRow[]>`
      select id, org_id, aoi_id, to_char(baseline_from, 'YYYY-MM-DD') as baseline_from, to_char(baseline_to, 'YYYY-MM-DD') as baseline_to,
             to_char(comparison_from, 'YYYY-MM-DD') as comparison_from, to_char(comparison_to, 'YYYY-MM-DD') as comparison_to,
             status, selection, created_by, started_at
        from comparisons where id = ${id} and org_id = ${orgId}`;
    return c ?? null;
  });
}

/** Record the final outcome (and audit it) in one transaction. */
async function finish(
  orgId: string,
  c: ComparisonRow,
  outcome: Outcome,
  detail: string,
  extra: { selection?: Record<string, unknown>; result?: Record<string, unknown>; baselineId?: string | null; comparisonId?: string | null; runId?: string | null; tx?: Tx } = {},
) {
  const run = async (tx: Tx) => {
    await tx`
      update comparisons set status = 'done', outcome = ${outcome}, outcome_detail = ${detail}, completed_at = now(),
             selection = ${jsonb({ ...c.selection, ...(extra.selection ?? {}) })}::jsonb,
             result = ${extra.result ? jsonb(extra.result) : null}::jsonb,
             baseline_observation_id = ${extra.baselineId ?? null}, comparison_observation_id = ${extra.comparisonId ?? null},
             run_id = ${extra.runId ?? null}
       where id = ${c.id} and org_id = ${orgId}`;
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", label: "comparison.compare" },
      action: "comparison.complete",
      targetType: "comparison",
      targetId: c.id,
      metadata: { outcome, aoi_id: c.aoi_id },
    });
  };
  return extra.tx ? run(extra.tx) : withTenant({ orgId }, run);
}

// ── comparison.prepare ─────────────────────────────────────────

export async function comparisonPrepareHandler(ctx: JobContext): Promise<unknown> {
  const p = ctx.job.payload as { comparisonId: string };
  const orgId = ctx.job.org_id;
  if (!orgId) throw new PermanentJobError("A comparison requires an organization.");
  const c = await loadComparison(orgId, p.comparisonId);
  if (!c) throw new PermanentJobError("The comparison no longer exists.");
  if (c.status === "done" || c.status === "failed") return { skipped: c.status };

  const aoi = await withTenant({ orgId }, async (tx) => {
    const [a] = await tx<{ status: string; data_sources: string[]; enabled_analytics: string[]; max_cloud_cover: string; bbox: BBox }[]>`
      select status, data_sources, enabled_analytics, max_cloud_cover,
             array[ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)]::float8[] as bbox
        from aois where id = ${c.aoi_id} and org_id = ${orgId}`;
    return a;
  });
  if (!aoi) throw new PermanentJobError("The area no longer exists.");
  const missing = [
    aoi.status !== "active" ? "the area is archived" : null,
    !aoi.data_sources.includes(COMPARISON_PRODUCT) ? "Sentinel-2 L2A (Earth Search) is not one of the area's data sources" : null,
    !aoi.enabled_analytics.includes("ndvi") ? "NDVI is not enabled for the area" : null,
  ].filter(Boolean);
  if (missing.length) {
    await finish(orgId, c, "not_configured", `Nothing was compared because ${missing.join(", and ")}. Change the area's settings, then run the comparison again.`);
    return { outcome: "not_configured" };
  }

  const found = getImageryProduct(COMPARISON_PRODUCT);
  if (!found) throw new PermanentJobError(`Unknown imagery product "${COMPARISON_PRODUCT}".`);
  const availability = found.provider.availability();
  if (availability.state !== "available") throw new PermanentJobError(`${found.provider.descriptor.name}: ${availability.reason}`);

  await withTenant({ orgId }, (tx) => tx`update comparisons set status = 'searching', started_at = coalesce(started_at, now()) where id = ${c.id} and org_id = ${orgId}`);
  const windows = {} as Record<Window, { asset_ids: string[]; found: number; analysed: number; not_analysed: number }>;
  const processKeys: string[] = [];
  for (const w of ["baseline", "comparison"] as const) {
    ctx.checkpoint();
    await ctx.progress({ step: "searching", window: w });
    const { from, to } = windowBounds(c, w);
    const assets = await found.provider.search({
      productId: COMPARISON_PRODUCT,
      intersects: bboxToPolygon(aoi.bbox),
      start: from,
      end: new Date(to.getTime() - 1),
      maxCloudCover: Number(aoi.max_cloud_cover),
      limit: 250,
      signal: ctx.signal,
    });
    const linked = await withTenant({ orgId }, async (tx) => {
      const up = await upsertSourceAssets(tx, assets);
      const matches = await matchAssets(tx, up.map((u) => u.id), COMPARISON_PRODUCT, [c.aoi_id]);
      // The clearest scenes by catalog cloud cover first; the rest are noted, not analysed.
      const ordered = [...matches].sort((a, b) => (a.cloud_cover ?? 100) - (b.cloud_cover ?? 100));
      const chosen = ordered.slice(0, SCENES_PER_WINDOW);
      await linkAndQueue(tx, chosen, { productId: COMPARISON_PRODUCT, reason: "comparison", createdBy: c.created_by });
      return { ids: chosen.map((m) => m.asset_id), found: matches.length, left: ordered.length - chosen.length };
    });
    windows[w] = { asset_ids: linked.ids, found: linked.found, analysed: linked.ids.length, not_analysed: linked.left };
    processKeys.push(...linked.ids.map((id) => `process:${c.aoi_id}:${id}:${PROCESSING_SET_VERSION}`));
  }

  await withTenant({ orgId }, async (tx) => {
    // A person is waiting: run these images ahead of background processing.
    if (processKeys.length) {
      await tx`update jobs set priority = least(priority, 35) where idempotency_key = any(${processKeys}) and status = 'queued'`;
    }
    await tx`update comparisons set status = 'processing', selection = ${jsonb({ ...c.selection, windows })}::jsonb where id = ${c.id} and org_id = ${orgId}`;
    await enqueueTx(tx, {
      orgId,
      type: JOB.comparisonCompare,
      payload: { comparisonId: c.id, check: 1 },
      priority: 35,
      runAfter: new Date(Date.now() + CHECK_INTERVAL_MS),
      idempotencyKey: `comparison.compare:${c.id}:1`,
      timeoutSeconds: 600,
    });
  });
  return { windows };
}

// ── comparison.compare ─────────────────────────────────────────

type CandidateRow = {
  asset_id: string;
  external_id: string;
  acquired_at: Date;
  grid_code: string | null;
  epsg: number | null;
  platform: string | null;
  cloud_cover: number | null;
  link_status: string | null;
  link_reason: string | null;
  observation_id: string | null;
  obs_status: string | null;
  metrics: Record<string, unknown> | null;
  quality: ObservationQuality | null;
};

function toCandidate(r: CandidateRow, pending: boolean): Candidate {
  const q = r.quality;
  const validFraction = typeof r.metrics?.valid_fraction === "number" ? (r.metrics.valid_fraction as number) : null;
  const clear = validFraction ?? (q ? (q.coverage_fraction ?? 0) * (1 - (q.masked_fraction ?? 1)) : null);
  const base = {
    assetId: r.asset_id,
    externalId: r.external_id,
    acquiredAt: r.acquired_at,
    gridCode: r.grid_code,
    epsg: r.epsg,
    platform: r.platform,
    coverageFraction: q?.coverage_fraction ?? null,
    sceneCloudCover: r.cloud_cover,
  };
  if (r.observation_id && (r.obs_status === "valid" || r.obs_status === "unusable")) {
    return {
      ...base,
      observationId: r.observation_id,
      status: r.obs_status,
      clearFraction: clear,
      reason: r.obs_status === "unusable" ? (q?.unusable_reason ?? "too few clear pixels over the area") : null,
    };
  }
  return {
    ...base,
    observationId: null,
    status: "not_processed",
    clearFraction: null,
    reason: pending
      ? "its analysis did not finish within the waiting time"
      : (r.link_reason ?? (r.link_status === "failed" ? "the image could not be read" : "it was not analysed")),
  };
}

async function loadCandidates(orgId: string, c: ComparisonRow, w: Window, assetIds: string[]): Promise<CandidateRow[]> {
  const { from, to } = windowBounds(c, w);
  return withTenant({ orgId }, (tx) => tx<CandidateRow[]>`
    with scenes as (
      select s.id from source_assets s
       where s.collection = ${COMPARISON_COLLECTION} and s.acquired_at >= ${from} and s.acquired_at < ${to}
         and (s.id = any(${assetIds}::uuid[])
              or exists (select 1 from observations o where o.asset_id = s.id and o.aoi_id = ${c.aoi_id} and o.org_id = ${orgId}))
    )
    select s.id as asset_id, s.external_id, s.acquired_at, s.grid_code, s.epsg, s.platform, s.cloud_cover::float8 as cloud_cover,
           l.status as link_status, l.status_reason as link_reason,
           o.id as observation_id, o.status as obs_status, o.metrics, o.quality
      from scenes x
      join source_assets s on s.id = x.id
      left join aoi_assets l on l.aoi_id = ${c.aoi_id} and l.asset_id = s.id
      left join lateral (
        select id, status, metrics, quality from observations
         where aoi_id = ${c.aoi_id} and org_id = ${orgId} and asset_id = s.id and kind = 'ndvi' and is_current
         order by processed_at desc limit 1) o on true
     order by s.acquired_at`);
}

export async function comparisonCompareHandler(ctx: JobContext): Promise<unknown> {
  const p = ctx.job.payload as { comparisonId: string; check?: number };
  const orgId = ctx.job.org_id;
  if (!orgId) throw new PermanentJobError("A comparison requires an organization.");
  const c = await loadComparison(orgId, p.comparisonId);
  if (!c) throw new PermanentJobError("The comparison no longer exists.");
  if (c.status === "done" || c.status === "failed") return { skipped: c.status };
  const windows = c.selection.windows;
  if (!windows) throw new PermanentJobError("The comparison has not been prepared.");

  // 1. Wait for the images to be analysed.
  const allIds = [...windows.baseline.asset_ids, ...windows.comparison.asset_ids];
  const pending = new Set(
    (
      await withTenant({ orgId }, (tx) => tx<{ asset_id: string }[]>`
        select asset_id from aoi_assets where aoi_id = ${c.aoi_id} and asset_id = any(${allIds}::uuid[]) and status = 'queued'`)
    ).map((r) => r.asset_id),
  );
  const waited = Date.now() - (c.started_at?.getTime() ?? Date.now());
  if (pending.size > 0 && waited < MAX_WAIT_MS) {
    const next = (p.check ?? 1) + 1;
    await withTenant({ orgId }, (tx) =>
      enqueueTx(tx, {
        orgId,
        type: JOB.comparisonCompare,
        payload: { comparisonId: c.id, check: next },
        priority: 35,
        runAfter: new Date(Date.now() + CHECK_INTERVAL_MS),
        idempotencyKey: `comparison.compare:${c.id}:${next}`,
        timeoutSeconds: 600,
      }),
    );
    return { waiting: pending.size };
  }

  // 2. Choose the pair.
  await withTenant({ orgId }, (tx) => tx`update comparisons set status = 'comparing' where id = ${c.id} and org_id = ${orgId}`);
  const [bRows, cRows] = await Promise.all([
    loadCandidates(orgId, c, "baseline", windows.baseline.asset_ids),
    loadCandidates(orgId, c, "comparison", windows.comparison.asset_ids),
  ]);
  const picked = selectPair(
    bRows.map((r) => toCandidate(r, pending.has(r.asset_id))),
    cRows.map((r) => toCandidate(r, pending.has(r.asset_id))),
  );
  const notAnalysedNote = (w: Window) =>
    windows[w].not_analysed > 0
      ? `${windows[w].not_analysed} further image(s) with more scene cloud were not analysed (at most ${SCENES_PER_WINDOW} per period).`
      : null;
  const selection = {
    decisions: picked.decisions,
    notes: { baseline: notAnalysedNote("baseline"), comparison: notAnalysedNote("comparison") },
  };
  if (!picked.ok) {
    await finish(orgId, c, picked.outcome, picked.detail, { selection });
    return { outcome: picked.outcome };
  }

  // 3. Compare.
  const obs = await withTenant({ orgId }, (tx) => tx<ObsRow[]>`
    select o.id, o.kind, o.status, o.observed_at, o.raster, o.quality, o.asset_id, s.collection, s.grid_code, s.platform
      from observations o join source_assets s on s.id = o.asset_id
     where o.org_id = ${orgId} and o.id = any(${[picked.baseline.observationId!, picked.comparison.observationId!]}::uuid[])`);
  const before = obs.find((o) => o.id === picked.baseline.observationId);
  const after = obs.find((o) => o.id === picked.comparison.observationId);
  if (!before?.raster || !after?.raster) throw new PermanentJobError("A chosen observation has no stored grid.");
  if (before.raster.epsg !== after.raster.epsg) throw new PermanentJobError("The chosen images are on different grids.");

  await ctx.progress({ step: "comparing", baseline: before.id, comparison: after.id });
  const pair = await loadAlignedPair({ ...after, raster: after.raster }, { ...before, raster: before.raster });
  const r = detectNdviChange({
    before: pair.before,
    after: pair.after,
    grid: pair.grid,
    inside: pair.inside,
    threshold: NDVI_THRESHOLD,
    minAreaM2: MIN_AREA_M2,
    daysBetween: pair.daysBetween,
    sameGrid: pair.aligned,
  });
  const offset = seasonalOffsetDays(before.observed_at, after.observed_at);
  const model = ANALYTICS["ndvi-period-change"];
  const result: Record<string, unknown> = {
    model_id: model.id,
    model_version: model.version,
    threshold: NDVI_THRESHOLD,
    min_area_m2: MIN_AREA_M2,
    min_overlap: MIN_OVERLAP,
    overlap: r.validOverlapFraction,
    same_grid: pair.aligned,
    days_between: pair.daysBetween,
    seasonal_offset_days: offset,
    years_apart: Math.round(pair.daysBetween / 365.25),
    candidates: r.candidates.length,
    omitted: r.omitted,
    below_min_area: r.belowMinArea,
    corners: after.raster.corners,
    coverage_fraction: after.quality.coverage_fraction ?? null,
    grid: picked.grid,
  };

  const openRun = async (tx: Tx, status: "succeeded" | "insufficient_data", messages: string[], outputs: Record<string, unknown>) => {
    const [run] = await tx<{ id: string }[]>`
      insert into processing_runs (org_id, aoi_id, job_id, model_id, model_version, attempt, status, input_asset_ids, baseline_asset_ids,
                                   parameters, outputs, messages, software_version, finished_at)
      values (${orgId}, ${c.aoi_id}, ${ctx.job.id}, ${model.id}, ${model.version}, ${ctx.job.attempts}, ${status}, ${[after.asset_id]}::uuid[],
              ${[before.asset_id]}::uuid[],
              ${jsonb({ comparison_id: c.id, threshold: NDVI_THRESHOLD, min_area_m2: MIN_AREA_M2, observation_id: after.id, baseline_observation_id: before.id, periods: { baseline: [c.baseline_from, c.baseline_to], comparison: [c.comparison_from, c.comparison_to] } })}::jsonb,
              ${jsonb(outputs)}::jsonb, ${messages}, ${env.appVersion()}, now())
      returning id`;
    return run!.id;
  };

  if (r.validOverlapFraction < MIN_OVERLAP) {
    const detail = `Only ${Math.round(r.validOverlapFraction * 100)}% of the area was clear in both chosen images (minimum ${MIN_OVERLAP * 100}%); no comparison was made.`;
    await withTenant({ orgId }, async (tx) => {
      const runId = await openRun(tx, "insufficient_data", [detail], result);
      await finish(orgId, c, "insufficient_overlap", detail, { selection, result, baselineId: before.id, comparisonId: after.id, runId, tx });
    });
    return { outcome: "insufficient_overlap" };
  }

  const deltaKey = orgKey(orgId, "comparisons", c.id, "delta-ndvi.png");
  await storage().put(deltaKey, renderContinuous(r.delta, pair.grid.width, pair.grid.height, pair.inside, "delta_ndvi").png, "image/png");
  result.delta_png_key = deltaKey;

  const orgKind = await withTenant({ orgId }, async (tx) => (await tx<{ kind: string }[]>`select kind from organizations where id = ${orgId}`)[0]?.kind ?? "enterprise");
  const outcome: Outcome = r.candidates.length ? "changes_found" : "no_change_above_threshold";
  const detail = r.candidates.length
    ? `${r.candidates.length} candidate change(s) of at least ${MIN_AREA_M2.toLocaleString("en-US")} m² where NDVI changed by ${NDVI_THRESHOLD} or more between the two images.`
    : `No region of at least ${MIN_AREA_M2.toLocaleString("en-US")} m² changed by ${NDVI_THRESHOLD} NDVI or more between the two images (${Math.round(r.validOverlapFraction * 100)}% of the area clear in both).`;
  await withTenant({ orgId }, async (tx) => {
    const runId = await openRun(tx, "succeeded", r.candidates.length ? [] : ["No change exceeded the threshold and minimum area."], result);
    for (const cand of r.candidates) {
      const { grade, reasons } = gradeEvidence({
        kind: "ndvi",
        meanDelta: cand.metrics.mean_delta,
        threshold: NDVI_THRESHOLD,
        pixelCount: cand.metrics.pixel_count,
        overlap: r.validOverlapFraction,
        sameGrid: pair.aligned,
        daysBetween: pair.daysBetween,
        seasonalOffsetDays: offset,
        maskedBefore: before.quality.masked_fraction ?? 0,
        maskedAfter: after.quality.masked_fraction ?? 0,
      });
      const { type, title } = titleFor("ndvi", cand, orgKind);
      const geomHash = createHash("sha1").update(JSON.stringify(cand.geometry.coordinates)).digest("hex").slice(0, 16);
      await tx`
        insert into detections (org_id, aoi_id, type, result_class, title, geom, area_m2, baseline_observation_id, comparison_observation_id,
                                baseline_observed_at, comparison_observed_at, first_observed_at, last_observed_at, source_asset_ids,
                                run_id, model_id, model_version, metrics, thresholds, evidence_grade, evidence_reasons, limitations, dedupe_key, comparison_id)
        values (${orgId}, ${c.aoi_id}, ${type}, ${model.resultClass}, ${title},
                ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(cand.geometry)}), 4326)), ${cand.metrics.area_m2},
                ${before.id}, ${after.id}, ${before.observed_at}, ${after.observed_at}, ${before.observed_at}, ${after.observed_at},
                ${[before.asset_id, after.asset_id]}::uuid[], ${runId}, ${model.id}, ${model.version},
                ${jsonb(cand.metrics)}::jsonb, ${jsonb({ ndvi_delta: NDVI_THRESHOLD, min_area_m2: MIN_AREA_M2 })}::jsonb,
                ${grade}, ${reasons}, ${model.limitations as unknown as string[]}, ${`${model.id}@${model.version}:cmp:${c.id}:${geomHash}`}, ${c.id})
        on conflict (org_id, dedupe_key) do nothing`;
    }
    await finish(orgId, c, outcome, detail, { selection, result, baselineId: before.id, comparisonId: after.id, runId, tx });
  });
  return { outcome, candidates: r.candidates.length, overlap: r.validOverlapFraction };
}

/** Mark a comparison failed when its job fails permanently. */
export async function markComparisonFailed(orgId: string, comparisonId: string, message: string) {
  await withTenant({ orgId }, (tx) => tx`
    update comparisons set status = 'failed', error = ${message.slice(0, 1000)}, completed_at = now()
     where id = ${comparisonId} and org_id = ${orgId} and status <> 'done'`);
}

const withFailure =
  (run: (ctx: JobContext) => Promise<unknown>) =>
  async (ctx: JobContext): Promise<unknown> => {
    try {
      return await run(ctx);
    } catch (err) {
      const id = (ctx.job.payload as { comparisonId?: string }).comparisonId;
      const finalAttempt = err instanceof PermanentJobError || ctx.job.attempts >= ctx.job.max_attempts;
      if (id && ctx.job.org_id && finalAttempt) await markComparisonFailed(ctx.job.org_id, id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

export const COMPARISON_HANDLERS: JobHandler[] = [
  { type: JOB.comparisonPrepare, describe: "Season comparison: search and queue images", run: withFailure(comparisonPrepareHandler) },
  { type: JOB.comparisonCompare, describe: "Season comparison: choose the image pair and compare", run: withFailure(comparisonCompareHandler) },
];

export type { Decision };
export type ComparisonResult = Record<string, unknown> & { corners?: RasterRef["corners"] };
