/**
 * ndvi-zones for one valid NDVI observation: within-field low-vigour zones
 * (src/server/analytics/zones.ts), each checked for persistence against the
 * previous usable image of the same sensor within 45 days, graded, and
 * stored as reviewable detections (type low_vigor_zone).
 *
 * The persistence check applies the same rule to the earlier image's own
 * stored NDVI on the same pixels, so it does not depend on the order in
 * which a backfill processes images.
 */
import { createHash } from "node:crypto";
import { alignToGrid } from "@/server/analytics/change";
import { sameGrid, type Grid } from "@/server/analytics/raster/grid";
import { ANALYTICS } from "@/server/analytics/registry";
import type { ObservationQuality, RasterRef } from "@/server/analytics/types";
import { detectLowVigorZones, gradeZone, robustFieldStats, zonePersistence, ZONE_DEFAULTS, type Persistence, type Zone } from "@/server/analytics/zones";
import { env } from "@/server/config/env";
import { jsonb, withTenant } from "@/server/db/client";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { storage } from "@/server/storage";

export const PERSISTENCE_WINDOW_DAYS = 45;

type Obs = {
  id: string;
  observed_at: Date;
  raster: RasterRef | null;
  quality: ObservationQuality;
  asset_id: string;
  collection: string;
  grid_code: string | null;
};

const toGrid = (r: RasterRef): Grid => ({ width: r.width, height: r.height, epsg: r.epsg, transform: r.transform });

function readF32(buf: Buffer): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

async function loadGrid(r: RasterRef): Promise<{ values: Float32Array; inside: Uint8Array | null }> {
  const [data, mask] = await Promise.all([storage().get(r.data_key), r.mask_key ? storage().get(r.mask_key) : Promise.resolve(null)]);
  if (!data) throw new Error(`Stored grid missing: ${r.data_key}`);
  return { values: readF32(data.body), inside: mask ? new Uint8Array(mask.body) : null };
}

function titleFor(z: Zone, orgKind: string): string {
  const m = z.metrics;
  const ha = (m.area_m2 / 10_000).toFixed(m.area_m2 >= 100_000 ? 0 : 1);
  return orgKind === "agriculture"
    ? `Low-vigour zone #${m.rank}: NDVI ${m.mean_ndvi.toFixed(2)} vs field median ${m.field_median.toFixed(2)}, ${ha} ha`
    : `Below-median vegetation zone #${m.rank}: NDVI ${m.mean_ndvi.toFixed(2)} vs area median ${m.field_median.toFixed(2)}, ${ha} ha`;
}

export async function computeLowVigorZones(p: {
  orgId: string;
  aoiId: string;
  observationId: string;
  jobId: string;
  attempt: number;
  reprocess?: boolean;
  historical?: boolean;
}): Promise<{ status: string; zones: number; reason?: string }> {
  const model = ANALYTICS["ndvi-zones"];
  const { orgId, aoiId } = p;
  const loaded = await withTenant({ orgId }, async (tx) => {
    const [obs] = await tx<(Obs & { status: string; kind: string })[]>`
      select o.id, o.kind, o.status, o.observed_at, o.raster, o.quality, o.asset_id, s.collection, s.grid_code
        from observations o join source_assets s on s.id = o.asset_id
       where o.id = ${p.observationId} and o.org_id = ${orgId}`;
    if (!obs) return null;
    const priors = await tx<Obs[]>`
      select o.id, o.observed_at, o.raster, o.quality, o.asset_id, s.collection, s.grid_code
        from observations o join source_assets s on s.id = o.asset_id
       where o.aoi_id = ${aoiId} and o.org_id = ${orgId} and o.kind = 'ndvi' and o.status = 'valid' and o.is_current
         and s.collection = ${obs.collection} and o.raster is not null
         and o.observed_at < ${obs.observed_at}::timestamptz - interval '1 day'
         and o.observed_at > ${obs.observed_at}::timestamptz - make_interval(days => ${PERSISTENCE_WINDOW_DAYS})
       order by o.observed_at desc limit 5`;
    const [org] = await tx<{ kind: string }[]>`select kind from organizations where id = ${orgId}`;
    return { obs, priors, orgKind: org?.kind ?? "enterprise" };
  });
  if (!loaded) return { status: "skipped", zones: 0, reason: "The observation no longer exists." };
  const { obs, orgKind } = loaded;

  const record = (status: "succeeded" | "insufficient_data", messages: string[], outputs: Record<string, unknown>, priorAssetId: string | null) =>
    withTenant({ orgId }, async (tx) => {
      const [run] = await tx<{ id: string }[]>`
        insert into processing_runs (org_id, aoi_id, job_id, model_id, model_version, attempt, status, input_asset_ids, baseline_asset_ids,
                                     parameters, outputs, messages, software_version, finished_at)
        values (${orgId}, ${aoiId}, ${p.jobId}, ${model.id}, ${model.version}, ${p.attempt}, ${status}, ${[obs.asset_id]}::uuid[],
                ${priorAssetId ? [priorAssetId] : []}::uuid[],
                ${jsonb({ ...ZONE_DEFAULTS, persistence_window_days: PERSISTENCE_WINDOW_DAYS, observation_id: obs.id })}::jsonb,
                ${jsonb(outputs)}::jsonb, ${messages}, ${env.appVersion()}, now())
        returning id`;
      return run!.id;
    });

  if (obs.kind !== "ndvi" || obs.status !== "valid" || !obs.raster) {
    await record("insufficient_data", ["The observation is not a usable NDVI image."], {}, null);
    return { status: "insufficient_data", zones: 0 };
  }
  const grid = toGrid(obs.raster);
  const current = await loadGrid(obs.raster);
  const result = detectLowVigorZones({ values: current.values, inside: current.inside, grid });
  if (result.status === "not_applicable") {
    await record("insufficient_data", [result.reason], { field: result.field }, null);
    return { status: "not_applicable", zones: 0, reason: result.reason };
  }

  // Persistence: the previous usable image of the same sensor (same tile preferred), same rule.
  const prior = loaded.priors.find((c) => c.grid_code && c.grid_code === obs.grid_code) ?? loaded.priors[0] ?? null;
  let priorGrid: { values: Float32Array; threshold: number; date: string } | null = null;
  let persistenceNote: string | null = null;
  if (!prior?.raster) {
    persistenceNote = `No earlier usable image within ${PERSISTENCE_WINDOW_DAYS} days to check persistence.`;
  } else if (prior.raster.epsg !== grid.epsg) {
    persistenceNote = `The earlier usable image (${prior.observed_at.toISOString().slice(0, 10)}) is in a different projection; persistence was not checked.`;
  } else {
    const b = await loadGrid(prior.raster);
    const gB = toGrid(prior.raster);
    const values = sameGrid(gB, grid) ? b.values : alignToGrid(b.values, gB, grid);
    const insideB = b.inside ? (sameGrid(gB, grid) ? b.inside : Uint8Array.from(alignToGrid(Float32Array.from(b.inside), gB, grid), (v) => (v >= 0.5 ? 1 : 0))) : null;
    const stats = robustFieldStats(values, current.inside ?? insideB, ZONE_DEFAULTS);
    if (stats) priorGrid = { values, threshold: stats.threshold, date: prior.observed_at.toISOString().slice(0, 10) };
    else persistenceNote = "The earlier usable image has no values over this area on the current grid.";
  }

  const runId = await record(
    "succeeded",
    result.zones.length ? [] : ["No zone fell below the threshold over at least the minimum area."],
    {
      zones: result.zones.length,
      omitted: result.omitted,
      below_min_area: result.belowMinArea,
      low_fraction: result.lowFraction,
      field: result.field,
      persistence_baseline_observation_id: priorGrid ? prior!.id : null,
    },
    priorGrid ? prior!.asset_id : null,
  );

  const ids = await withTenant({ orgId }, async (tx) => {
    const created: string[] = [];
    for (const z of result.zones) {
      const persistence: Persistence = priorGrid
        ? zonePersistence(result.labels.labels, z.label, z.pixelBBox, grid.width, priorGrid.values, priorGrid.threshold, priorGrid.date)
        : { state: "unknown", reason: persistenceNote! };
      const { grade, reasons } = gradeZone(z.metrics, { maskedFraction: obs.quality.masked_fraction ?? 0, persistence });
      const geomHash = createHash("sha1").update(JSON.stringify(z.geometry.coordinates)).digest("hex").slice(0, 16);
      const persistentSince = persistence.state === "persistent" ? prior!.observed_at : obs.observed_at;
      const [row] = await tx<{ id: string }[]>`
        insert into detections (org_id, aoi_id, type, result_class, title, geom, area_m2, baseline_observation_id, comparison_observation_id,
                                baseline_observed_at, comparison_observed_at, first_observed_at, last_observed_at, source_asset_ids,
                                run_id, model_id, model_version, metrics, thresholds, evidence_grade, evidence_reasons, limitations, dedupe_key)
        values (${orgId}, ${aoiId}, 'low_vigor_zone', ${model.resultClass}, ${titleFor(z, orgKind)},
                ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(z.geometry)}), 4326)), ${z.metrics.area_m2},
                ${priorGrid ? prior!.id : null}, ${obs.id}, ${priorGrid ? prior!.observed_at : null}, ${obs.observed_at},
                ${persistentSince}, ${obs.observed_at},
                ${priorGrid ? [prior!.asset_id, obs.asset_id] : [obs.asset_id]}::uuid[], ${runId}, ${model.id}, ${model.version},
                ${jsonb({ ...z.metrics, persistence })}::jsonb,
                ${jsonb({ k: ZONE_DEFAULTS.k, min_deficit: ZONE_DEFAULTS.minDeficit, min_area_m2: ZONE_DEFAULTS.minAreaM2, threshold_ndvi: result.field.threshold })}::jsonb,
                ${grade}, ${reasons}, ${model.limitations as unknown as string[]}, ${`${model.id}@${model.version}:${obs.id}:${geomHash}`})
        on conflict (org_id, dedupe_key) do nothing
        returning id`;
      if (row) created.push(row.id);
    }
    if (created.length) {
      await enqueueTx(tx, {
        orgId,
        type: JOB.alertsEvaluate,
        payload: { aoiId, trigger: { kind: "detection", ids: created }, reprocessing: Boolean(p.reprocess), historical: Boolean(p.historical) },
        priority: 75,
        idempotencyKey: `alerts:det:${createHash("sha1").update([...created].sort().join(",")).digest("hex")}`,
      });
    }
    return created;
  });
  return { status: "succeeded", zones: ids.length };
}
