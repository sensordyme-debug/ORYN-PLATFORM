/**
 * aoi.change_detection — compare an observation with the most recent earlier
 * usable observation of the same kind and collection (Workflow C step 10).
 *
 * Results are candidate changes. Each carries an evidence grade derived from
 * explicit, listed criteria (magnitude vs threshold, overlap of valid pixels,
 * grid alignment, time between images, residual masking, size) — not a
 * numeric confidence. The comparison is skipped, with the reason recorded,
 * when the images cannot be meaningfully compared.
 */
import { createHash } from "node:crypto";
import { alignToGrid, detectNdviChange, newWaterCandidates, type ChangeCandidate } from "@/server/analytics/change";
import { NDWI_WATER_THRESHOLD, S1_WATER_THRESHOLD_DB } from "@/server/analytics/indices";
import { sameGrid, type Grid } from "@/server/analytics/raster/grid";
import { ANALYTICS } from "@/server/analytics/registry";
import { renderContinuous } from "@/server/analytics/render";
import type { ObservationQuality, RasterRef } from "@/server/analytics/types";
import { env } from "@/server/config/env";
import { jsonb, withTenant, type Tx } from "@/server/db/client";
import { enqueueTx, PermanentJobError } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobContext } from "@/server/jobs/worker";
import { computeNdviAnomaly } from "@/server/pipeline/anomaly";
import { computeLowVigorZones } from "@/server/pipeline/zones";
import { orgKey, storage } from "@/server/storage";

export const NDVI_THRESHOLD = 0.2;
export const MIN_AREA_M2 = 2_000;
const MIN_OVERLAP = 0.3;
const MAX_BASELINE_DAYS = 400;

type ObsRow = {
  id: string;
  kind: string;
  status: string;
  observed_at: Date;
  raster: RasterRef | null;
  quality: ObservationQuality;
  asset_id: string;
  collection: string;
  grid_code: string | null;
  platform: string | null;
};

export type Grade = "strong" | "moderate" | "weak";
const ORDER: Grade[] = ["weak", "moderate", "strong"];
const minGrade = (a: Grade, b: Grade): Grade => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

/** Evidence grade with the reasons that produced it. Pure; unit-tested. */
export function gradeEvidence(input: {
  kind: "ndvi" | "water";
  meanDelta?: number | null;
  threshold?: number;
  pixelCount: number;
  overlap: number;
  sameGrid: boolean;
  daysBetween: number;
  maskedBefore: number;
  maskedAfter: number;
}): { grade: Grade; reasons: string[] } {
  const reasons: string[] = [];
  let grade: Grade = "strong";
  if (input.kind === "ndvi" && input.meanDelta !== undefined && input.meanDelta !== null && input.threshold) {
    const ratio = Math.abs(input.meanDelta) / input.threshold;
    const g: Grade = ratio >= 2 ? "strong" : ratio >= 1.5 ? "moderate" : "weak";
    grade = minGrade(grade, g);
    reasons.push(`Mean NDVI change ${input.meanDelta.toFixed(2)} is ${ratio.toFixed(1)}× the ${input.threshold} detection threshold.`);
  }
  const og: Grade = input.overlap >= 0.7 ? "strong" : input.overlap >= 0.5 ? "moderate" : "weak";
  grade = minGrade(grade, og);
  reasons.push(`${Math.round(input.overlap * 100)}% of the area was clear in both images.`);
  if (input.sameGrid) reasons.push("Both images share the same pixel grid (no resampling).");
  else {
    grade = minGrade(grade, "moderate");
    reasons.push("The images were on different pixel grids and one was resampled; edges may be offset by up to one pixel.");
  }
  if (input.daysBetween > 180) {
    grade = minGrade(grade, "weak");
    reasons.push(`${input.daysBetween} days separate the images; seasonal change likely contributes.`);
  } else if (input.daysBetween > 60) {
    grade = minGrade(grade, "moderate");
    reasons.push(`${input.daysBetween} days separate the images; some seasonal change is possible.`);
  } else reasons.push(`${input.daysBetween} days separate the images.`);
  const masked = Math.max(input.maskedBefore, input.maskedAfter);
  if (masked > 0.5) {
    grade = minGrade(grade, "weak");
    reasons.push(`One image had ${Math.round(masked * 100)}% of the area masked; residual cloud or shadow may remain at mask edges.`);
  } else if (masked > 0.2) {
    grade = minGrade(grade, "moderate");
    reasons.push(`One image had ${Math.round(masked * 100)}% of the area masked.`);
  }
  if (input.pixelCount < 30) {
    grade = minGrade(grade, "weak");
    reasons.push(`Small region (${input.pixelCount} pixels); a few misclassified pixels could account for it.`);
  }
  return { grade, reasons };
}

function readF32(buf: Buffer): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

function toGrid(r: RasterRef): Grid {
  return { width: r.width, height: r.height, epsg: r.epsg, transform: r.transform };
}

async function loadGrid(r: RasterRef) {
  const [data, mask] = await Promise.all([storage().get(r.data_key), r.mask_key ? storage().get(r.mask_key) : Promise.resolve(null)]);
  if (!data) throw new Error(`Stored grid missing: ${r.data_key}`);
  return { values: readF32(data.body), inside: mask ? new Uint8Array(mask.body) : null };
}

function titleFor(kind: "ndvi" | "water", c: ChangeCandidate, orgKind: string): { type: string; title: string } {
  const ha = (c.metrics.area_m2 / 10_000).toFixed(c.metrics.area_m2 >= 100_000 ? 0 : 1);
  if (kind === "water") return { type: "new_water_candidate", title: `Possible new surface water, ${ha} ha` };
  const d = c.metrics.mean_delta ?? 0;
  if (c.metrics.direction === "decrease") {
    return {
      type: "vegetation_decline",
      title: orgKind === "agriculture" ? `Vegetation decline (NDVI ${d.toFixed(2)}) over ${ha} ha` : `Vegetation loss / possible land disturbance, ${ha} ha`,
    };
  }
  return { type: "vegetation_gain", title: `Vegetation increase (NDVI +${d.toFixed(2)}) over ${ha} ha` };
}

export async function changeDetectionHandler(ctx: JobContext): Promise<unknown> {
  // followUps: when set (analytics enabled later on an existing area), only these analyses run.
  const p = ctx.job.payload as { aoiId: string; observationId: string; reprocess?: boolean; historical?: boolean; followUps?: string[] };
  const wants = (id: string) => !p.followUps || p.followUps.includes(id);
  const orgId = ctx.job.org_id;
  if (!orgId) throw new PermanentJobError("Change detection requires an organization.");

  const loaded = await withTenant({ orgId }, async (tx) => {
    const [after] = await tx<ObsRow[]>`
      select o.id, o.kind, o.status, o.observed_at, o.raster, o.quality, o.asset_id, s.collection, s.grid_code, s.platform
        from observations o join source_assets s on s.id = o.asset_id
       where o.id = ${p.observationId} and o.org_id = ${orgId}`;
    if (!after) return null;
    const candidates = await tx<ObsRow[]>`
      select o.id, o.kind, o.status, o.observed_at, o.raster, o.quality, o.asset_id, s.collection, s.grid_code, s.platform
        from observations o join source_assets s on s.id = o.asset_id
       where o.aoi_id = ${p.aoiId} and o.org_id = ${orgId} and o.kind = ${after.kind} and o.status = 'valid' and o.is_current
         and s.collection = ${after.collection} and o.raster is not null
         ${after.collection === "sentinel-1-rtc" ? tx`and s.grid_code = ${after.grid_code ?? ""}` : tx``}
         and o.observed_at < ${after.observed_at}::timestamptz - interval '1 day'
         and o.observed_at > ${after.observed_at}::timestamptz - make_interval(days => ${MAX_BASELINE_DAYS})
       order by o.observed_at desc limit 5`;
    const [org] = await tx<{ kind: string }[]>`select kind from organizations where id = ${orgId}`;
    const [aoi] = await tx<{ enabled_analytics: string[] }[]>`select enabled_analytics from aois where id = ${p.aoiId} and org_id = ${orgId}`;
    const enabled = new Set(aoi?.enabled_analytics ?? []);
    // The anomaly score also compares against history, so it runs here, after the batch's images are processed.
    const anomaly = after.kind === "ndvi" && after.status === "valid" && enabled.has("ndvi-anomaly") && wants("ndvi-anomaly")
      ? await computeNdviAnomaly(tx, { orgId, aoiId: p.aoiId, observationId: after.id, jobId: ctx.job.id })
      : null;
    return { after, candidates, orgKind: org?.kind ?? "enterprise", enabled, anomaly };
  });
  if (!loaded) throw new PermanentJobError("The observation no longer exists.");
  const { after, orgKind } = loaded;
  // Within-field low-vigour zones need only this image (plus the previous one for persistence).
  const zones =
    after.kind === "ndvi" && loaded.enabled.has("ndvi-zones") && wants("ndvi-zones")
      ? await computeLowVigorZones({ orgId, aoiId: p.aoiId, observationId: after.id, jobId: ctx.job.id, attempt: ctx.job.attempts, reprocess: p.reprocess, historical: p.historical })
      : null;
  const kind: "ndvi" | "water" = after.kind === "ndvi" ? "ndvi" : "water";
  const changeId = kind === "ndvi" ? "ndvi-change" : "water-change";
  if (!loaded.enabled.has(changeId) || !wants(changeId)) return { anomaly: loaded.anomaly?.status ?? null, zones, change: "not_enabled" };
  const model = ANALYTICS[kind === "ndvi" ? "ndvi-change" : "water-change"];
  // Radar backscatter depends on viewing geometry, so Sentinel-1 is compared
  // only within one relative orbit (grid_code). Optical products prefer the
  // same tile (pixel-aligned) and otherwise use the most recent image.
  const sameGeometryRequired = after.collection === "sentinel-1-rtc";
  const before =
    loaded.candidates.find((c) => c.grid_code && c.grid_code === after.grid_code) ?? (sameGeometryRequired ? null : (loaded.candidates[0] ?? null));

  // The run and any detections it produces commit together (one transaction),
  // so a detection can never reference a run that does not exist.
  const finishRun = async (status: "succeeded" | "insufficient_data", messages: string[], outputs: Record<string, unknown>, extra?: (tx: Tx, runId: string) => Promise<string[]>) =>
    withTenant({ orgId }, async (tx) => {
      const [run] = await tx<{ id: string }[]>`
        insert into processing_runs (org_id, aoi_id, job_id, model_id, model_version, attempt, status, input_asset_ids, baseline_asset_ids,
                                     parameters, outputs, messages, software_version, finished_at)
        values (${orgId}, ${p.aoiId}, ${ctx.job.id}, ${model.id}, ${model.version}, ${ctx.job.attempts}, ${status}, ${[after.asset_id]}::uuid[],
                ${before ? [before.asset_id] : []}::uuid[],
                ${jsonb({ threshold: kind === "ndvi" ? NDVI_THRESHOLD : null, min_area_m2: MIN_AREA_M2, observation_id: after.id, baseline_observation_id: before?.id ?? null })}::jsonb,
                ${jsonb(outputs)}::jsonb, ${messages}, ${env.appVersion()}, now())
        returning id`;
      return extra ? extra(tx, run!.id) : [];
    });

  if (after.status !== "valid" || !after.raster) {
    await finishRun("insufficient_data", ["The observation is not usable, so it was not compared."], {});
    return { skipped: "unusable" };
  }
  if (!before?.raster) {
    await finishRun(
      "insufficient_data",
      [
        sameGeometryRequired
          ? `No earlier usable radar image from the same relative orbit (${after.grid_code ?? "unknown"}) within ${MAX_BASELINE_DAYS} days to compare with.`
          : `No earlier usable ${after.kind.toUpperCase()} observation from ${after.collection} within ${MAX_BASELINE_DAYS} days to compare with.`,
      ],
      {},
    );
    return { skipped: "no_baseline" };
  }
  const gA = toGrid(after.raster);
  const gB = toGrid(before.raster);
  if (gA.epsg !== gB.epsg) {
    await finishRun("insufficient_data", [`The baseline is in EPSG:${gB.epsg} and the new image in EPSG:${gA.epsg}; cross-projection comparison is not performed.`], {});
    return { skipped: "crs_mismatch" };
  }

  await ctx.progress({ step: "comparing", baseline: before.id });
  const [a, b] = await Promise.all([loadGrid(after.raster), loadGrid(before.raster)]);
  const aligned = sameGrid(gA, gB);
  const bValues = aligned ? b.values : alignToGrid(b.values, gB, gA);
  const bInside = b.inside ? (aligned ? b.inside : Uint8Array.from(alignToGrid(Float32Array.from(b.inside), gB, gA), (v) => (v >= 0.5 ? 1 : 0))) : null;
  const n = gA.width * gA.height;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = (a.inside ? a.inside[i]! : 1) && (bInside ? bInside[i]! : 1) ? 1 : 0;
  const daysBetween = Math.round((after.observed_at.getTime() - before.observed_at.getTime()) / 86_400_000);

  let candidates: ChangeCandidate[];
  let overlap: number;
  let extraOutputs: Record<string, unknown> = {};
  let deltaPng: Buffer | null = null;
  if (kind === "ndvi") {
    const r = detectNdviChange({ before: bValues, after: a.values, grid: gA, inside, threshold: NDVI_THRESHOLD, minAreaM2: MIN_AREA_M2, daysBetween, sameGrid: aligned });
    candidates = r.candidates;
    overlap = r.validOverlapFraction;
    extraOutputs = { omitted: r.omitted, below_min_area: r.belowMinArea };
    deltaPng = renderContinuous(r.delta, gA.width, gA.height, inside, "delta_ndvi").png;
  } else {
    const water = (v: Float32Array) => {
      const m = new Uint8Array(n);
      for (let i = 0; i < n; i++) m[i] = after.kind === "s1_water" ? (v[i]! < S1_WATER_THRESHOLD_DB ? 1 : 0) : v[i]! > NDWI_WATER_THRESHOLD ? 1 : 0;
      return m;
    };
    const validBoth = new Uint8Array(n);
    for (let i = 0; i < n; i++) validBoth[i] = inside[i] && Number.isFinite(a.values[i]!) && Number.isFinite(bValues[i]!) ? 1 : 0;
    const r = newWaterCandidates(water(bValues), water(a.values), validBoth, gA, MIN_AREA_M2, { inside, daysBetween, sameGrid: aligned });
    candidates = r.candidates;
    overlap = r.validOverlapFraction;
    extraOutputs = { omitted: r.omitted, below_min_area: r.belowMinArea };
  }

  if (overlap < MIN_OVERLAP) {
    await finishRun("insufficient_data", [`Only ${Math.round(overlap * 100)}% of the area was clear in both images (minimum ${MIN_OVERLAP * 100}%).`], { overlap });
    return { skipped: "low_overlap", overlap };
  }

  let deltaKey: string | null = null;
  if (deltaPng) {
    deltaKey = orgKey(orgId, "changes", `${before.id}_${after.id}`, "delta-ndvi.png");
    await storage().put(deltaKey, deltaPng, "image/png");
  }

  const created = await finishRun(
    "succeeded",
    candidates.length ? [] : ["No change exceeded the threshold and minimum area."],
    { candidates: candidates.length, overlap, delta_png_key: deltaKey, corners: after.raster.corners, ...extraOutputs },
    async (tx, runId) => {
        const ids: string[] = [];
        for (const c of candidates) {
          const { grade, reasons } = gradeEvidence({
            kind,
            meanDelta: c.metrics.mean_delta,
            threshold: NDVI_THRESHOLD,
            pixelCount: c.metrics.pixel_count,
            overlap,
            sameGrid: aligned,
            daysBetween,
            maskedBefore: before.quality.masked_fraction ?? 0,
            maskedAfter: after.quality.masked_fraction ?? 0,
          });
          const { type, title } = titleFor(kind, c, orgKind);
          const geomHash = createHash("sha1").update(JSON.stringify(c.geometry.coordinates)).digest("hex").slice(0, 16);
          const dedupe = `${model.id}@${model.version}:${before.id}:${after.id}:${geomHash}`;
          const [row] = await tx<{ id: string }[]>`
            insert into detections (org_id, aoi_id, type, result_class, title, geom, area_m2, baseline_observation_id, comparison_observation_id,
                                    baseline_observed_at, comparison_observed_at, first_observed_at, last_observed_at, source_asset_ids,
                                    run_id, model_id, model_version, metrics, thresholds, evidence_grade, evidence_reasons, limitations, dedupe_key)
            values (${orgId}, ${p.aoiId}, ${type}, ${model.resultClass}, ${title},
                    ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(c.geometry)}), 4326)), ${c.metrics.area_m2},
                    ${before.id}, ${after.id}, ${before.observed_at}, ${after.observed_at}, ${before.observed_at}, ${after.observed_at},
                    ${[before.asset_id, after.asset_id]}::uuid[], ${runId}, ${model.id}, ${model.version},
                    ${jsonb(c.metrics)}::jsonb, ${jsonb(kind === "ndvi" ? { ndvi_delta: NDVI_THRESHOLD, min_area_m2: MIN_AREA_M2 } : { min_area_m2: MIN_AREA_M2, water_rule: after.kind === "s1_water" ? `VV < ${S1_WATER_THRESHOLD_DB} dB` : `NDWI > ${NDWI_WATER_THRESHOLD}` })}::jsonb,
                    ${grade}, ${reasons}, ${model.limitations as unknown as string[]}, ${dedupe})
            on conflict (org_id, dedupe_key) do nothing
            returning id`;
          if (row) ids.push(row.id);
        }
        if (ids.length) {
          await enqueueTx(tx, {
            orgId,
            type: JOB.alertsEvaluate,
            payload: { aoiId: p.aoiId, trigger: { kind: "detection", ids }, reprocessing: Boolean(p.reprocess), historical: Boolean(p.historical) },
            priority: 75,
            idempotencyKey: `alerts:det:${createHash("sha1").update(ids.sort().join(",")).digest("hex")}`,
          });
        }
        return ids;
      },
  );
  return { detections: created.length, overlap, baseline: before.id, sameGrid: aligned, daysBetween };
}
