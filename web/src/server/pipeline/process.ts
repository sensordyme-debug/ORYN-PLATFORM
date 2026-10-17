/**
 * aoi.process_asset — run the AOI's enabled analytics on one source asset
 * (Workflow C, steps 5–8).
 *
 *  - Idempotent: an analytic already stored for (aoi, asset, model, version)
 *    is not recomputed.
 *  - Raster work happens outside database transactions; each processing run
 *    is committed as 'running' first, so a crash leaves a visible trace.
 *  - Unusable imagery (clouds, partial coverage) is stored as an 'unusable'
 *    observation with its reason — never dropped, never filled in.
 *  - Permanent problems (missing bands, implausible scaling, unsupported
 *    product, unconfigured credentials) fail the job without retries and say
 *    why; transient read failures are retried by the queue.
 */
import { createHash } from "node:crypto";
import { analyzeLandcover, analyzeOptical, analyzeS1Water, type AnalysisOutput, type GridContext, type OpticalCollection } from "@/server/analytics/analyze";
import { isRetryable, RasterAnalyticsError } from "@/server/analytics/errors";
import { ANALYTICS, type AnalyticId } from "@/server/analytics/registry";
import type { RasterRef } from "@/server/analytics/types";
import { env } from "@/server/config/env";
import { jsonb, withTenant, type Tx } from "@/server/db/client";
import { enqueueTx, PermanentJobError } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobContext } from "@/server/jobs/worker";
import { isProviderError } from "@/server/providers/http";
import { getImageryProvider } from "@/server/providers/imagery";
import type { AssetFile } from "@/server/providers/types";
import { assertPublicHttpsUrl } from "@/server/net";
import { orgKey, storage } from "@/server/storage";
import type { MultiPolygonGeometry } from "@/lib/geo";

const HISTORICAL_AFTER_MS = 7 * 86_400_000;

type Payload = { aoiId: string; assetId: string; productId?: string; reason?: string; reprocess?: boolean };

type AssetRow = {
  id: string;
  provider_id: string;
  collection: string;
  external_id: string;
  acquired_at: Date;
  cloud_cover: string | null;
  gsd_m: string | null;
  grid_code: string | null;
  properties: Record<string, unknown>;
  assets: Record<string, AssetFile>;
};

type AoiRow = { id: string; status: string; geometry: MultiPolygonGeometry; enabled_analytics: string[] };

type Task = { model: AnalyticId; kind: string };

/** Which observations a collection can produce, filtered by the AOI's enabled analytics. */
export function tasksFor(collection: string, enabled: string[]): Task[] {
  const on = (...ids: string[]) => ids.some((i) => enabled.includes(i));
  switch (collection) {
    case "sentinel-2-l2a":
      return [
        ...(on("ndvi", "ndvi-change", "ndvi-anomaly", "ndvi-zones") ? [{ model: "ndvi" as const, kind: "ndvi" }] : []),
        ...(on("ndmi") ? [{ model: "ndmi" as const, kind: "ndmi" }] : []),
        ...(on("ndwi", "water-change") ? [{ model: "ndwi" as const, kind: "ndwi" }] : []),
      ];
    case "landsat-c2-l2":
      return [
        ...(on("ndvi", "ndvi-change", "ndvi-anomaly", "ndvi-zones") ? [{ model: "ndvi" as const, kind: "ndvi" }] : []),
        ...(on("ndmi") ? [{ model: "ndmi" as const, kind: "ndmi" }] : []),
      ];
    case "sentinel-1-rtc":
      return on("s1-water", "water-change") ? [{ model: "s1-water", kind: "s1_water" }] : [];
    case "esa-worldcover":
    case "io-lulc-annual-v02":
      return on("landcover-composition") ? [{ model: "landcover-composition", kind: "landcover" }] : [];
    default:
      return [];
  }
}

function f32(values: Float32Array): Buffer {
  // Stored little-endian (the byte order of every supported Node platform).
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

async function storeOutput(orgId: string, obsId: string, kind: string, out: AnalysisOutput<unknown>, ctx: GridContext, trueColorPng: Buffer | null): Promise<RasterRef> {
  const s = storage();
  const base = ["observations", obsId];
  const png_key = orgKey(orgId, ...base, `${kind}.png`);
  const data_key = orgKey(orgId, ...base, `${kind}.f32`);
  const mask_key = orgKey(orgId, ...base, "aoi-mask.u8");
  await s.put(png_key, out.png, "image/png");
  await s.put(data_key, f32(out.values), "application/octet-stream");
  await s.put(mask_key, Buffer.from(ctx.inside), "application/octet-stream");
  let true_color_key: string | undefined;
  if (trueColorPng) {
    true_color_key = orgKey(orgId, ...base, "true-color.png");
    await s.put(true_color_key, trueColorPng, "image/png");
  }
  return {
    png_key,
    data_key,
    mask_key,
    ...(true_color_key ? { true_color_key } : {}),
    width: ctx.grid.width,
    height: ctx.grid.height,
    epsg: ctx.grid.epsg,
    transform: ctx.grid.transform,
    corners: ctx.corners,
    legend: out.legend,
  };
}

export async function processAssetHandler(ctx: JobContext): Promise<unknown> {
  const p = ctx.job.payload as Payload;
  const orgId = ctx.job.org_id;
  if (!orgId) throw new PermanentJobError("aoi.process_asset requires an organization.");

  // 1. Load inputs and decide what to compute.
  const loaded = await withTenant({ orgId }, async (tx) => {
    const [aoi] = await tx<AoiRow[]>`
      select id, status, ST_AsGeoJSON(geom, 8)::json as geometry, enabled_analytics from aois where id = ${p.aoiId} and org_id = ${orgId}`;
    const [asset] = await tx<AssetRow[]>`
      select id, provider_id, collection, external_id, acquired_at, cloud_cover, gsd_m, grid_code, properties, assets
        from source_assets where id = ${p.assetId}`;
    if (!aoi || !asset) return null;
    const existing = await tx<{ model_id: string; model_version: string }[]>`
      select model_id, model_version from observations where aoi_id = ${p.aoiId} and asset_id = ${p.assetId}`;
    return { aoi, asset, existing: new Set(existing.map((e) => `${e.model_id}@${e.model_version}`)) };
  });
  if (!loaded) throw new PermanentJobError("The area or source asset no longer exists.");
  const { aoi, asset } = loaded;
  if (aoi.status !== "active") {
    await setLinkStatus(orgId, p.aoiId, p.assetId, "skipped", "The area was archived before processing.");
    return { skipped: "aoi_archived" };
  }
  // Deterministic analytics: the same (model, version) on the same asset is never recomputed.
  const tasks = tasksFor(asset.collection, aoi.enabled_analytics).filter((t) => !loaded.existing.has(`${ANALYTICS[t.model].id}@${ANALYTICS[t.model].version}`));
  if (tasks.length === 0) {
    await setLinkStatus(orgId, p.aoiId, p.assetId, "processed", null);
    return { skipped: "nothing_to_compute" };
  }

  const provider = getImageryProvider(asset.provider_id);
  if (!provider) throw new PermanentJobError(`No adapter for provider "${asset.provider_id}".`);
  const availability = provider.availability();
  if (availability.state !== "available") {
    await setLinkStatus(orgId, p.aoiId, p.assetId, "failed", availability.reason);
    throw new PermanentJobError(`${provider.descriptor.name} is ${availability.state}: ${availability.reason}`);
  }

  // 2. Open processing runs (committed before the heavy work).
  const runIds = await withTenant({ orgId }, async (tx) => {
    const ids: Record<string, string> = {};
    for (const t of tasks) {
      const a = ANALYTICS[t.model];
      const [r] = await tx<{ id: string }[]>`
        insert into processing_runs (org_id, aoi_id, job_id, model_id, model_version, attempt, input_asset_ids, parameters, software_version)
        values (${orgId}, ${p.aoiId}, ${ctx.job.id}, ${a.id}, ${a.version}, ${ctx.job.attempts}, ${[p.assetId]}::uuid[],
                ${jsonb({ collection: asset.collection, item: asset.external_id, reason: p.reason ?? null })}::jsonb, ${env.appVersion()})
        returning id`;
      ids[t.model] = r!.id;
    }
    return ids;
  });

  // Imagery loaded for the first time but acquired well before now (AOI
  // backfill or a manual search) is history, not news: alerts it produces are
  // recorded but never notified.
  const historical = p.reason !== "scheduled" && Date.now() - asset.acquired_at.getTime() > HISTORICAL_AFTER_MS;

  const resolve = async (key: string) => {
    const access = await provider.resolveAccess({ collection: asset.collection, assets: asset.assets }, key, ctx.signal);
    assertPublicHttpsUrl(access.url);
    return access;
  };
  const common = { assets: asset.assets, aoi: aoi.geometry, resolve, signal: ctx.signal };

  try {
    await ctx.progress({ step: "analyzing", collection: asset.collection, tasks: tasks.map((t) => t.model) });
    type Output = { task: Task; out: AnalysisOutput<unknown>; grid: GridContext; trueColor: Buffer | null; extraQuality?: Record<string, unknown> };
    const outputs: Output[] = [];

    if (asset.collection === "sentinel-2-l2a" || asset.collection === "landsat-c2-l2") {
      const optical = {
        ...common,
        collection: asset.collection as OpticalCollection,
        sceneCloudCover: asset.cloud_cover === null ? null : Number(asset.cloud_cover),
        boaOffsetApplied: asset.properties["earthsearch:boa_offset_applied"] === true,
      };
      const wantNdvi = tasks.some((t) => t.model === "ndvi");
      const wantNdwi = tasks.some((t) => t.model === "ndwi");
      if (wantNdvi || wantNdwi) {
        const r = await analyzeOptical({ ...optical, want: { ndvi: wantNdvi, ndwi: wantNdwi, trueColor: true } });
        const grid: GridContext = { grid: r.grid, corners: r.corners, inside: r.inside, insideCount: r.insideCount };
        const extraQuality = { mask_reasons: r.maskReasons };
        if (r.ndvi) outputs.push({ task: { model: "ndvi", kind: "ndvi" }, out: r.ndvi, grid, trueColor: r.trueColor?.png ?? null, extraQuality });
        if (r.ndwi) outputs.push({ task: { model: "ndwi", kind: "ndwi" }, out: r.ndwi, grid, trueColor: r.trueColor?.png ?? null, extraQuality });
      }
      // NDMI on the native grid of its own bands (Sentinel-2 20 m, Landsat 30 m), so a separate read.
      if (tasks.some((t) => t.model === "ndmi")) {
        const m = await analyzeOptical({ ...optical, want: { ndvi: false, ndwi: false, trueColor: false, ndmi: true } });
        const grid: GridContext = { grid: m.grid, corners: m.corners, inside: m.inside, insideCount: m.insideCount };
        if (m.ndmi) outputs.push({ task: { model: "ndmi", kind: "ndmi" }, out: m.ndmi, grid, trueColor: null, extraQuality: { mask_reasons: m.maskReasons } });
      }
    } else if (asset.collection === "sentinel-1-rtc") {
      const r = await analyzeS1Water(common);
      outputs.push({ task: tasks[0]!, out: r, grid: r, trueColor: null });
    } else if (asset.collection === "esa-worldcover" || asset.collection === "io-lulc-annual-v02") {
      const r = await analyzeLandcover({ ...common, collection: asset.collection });
      outputs.push({ task: tasks[0]!, out: r, grid: r, trueColor: null, extraQuality: r.unknownCodes.length ? { unknown_codes: r.unknownCodes } : undefined });
    }
    ctx.checkpoint();

    // 3. Persist rasters, then observations, in one transaction.
    const prepared: (Output & { obsId: string; raster: RasterRef })[] = [];
    for (const o of outputs) {
      const obsId = crypto.randomUUID();
      const raster = await storeOutput(orgId, obsId, o.task.kind, o.out, o.grid, o.trueColor);
      prepared.push({ ...o, obsId, raster });
    }

    const result = await withTenant({ orgId }, async (tx) => {
      const created: { id: string; kind: string; status: string }[] = [];
      for (const o of prepared) {
        const a = ANALYTICS[o.task.model];
        const quality = { ...o.out.quality, ...(o.extraQuality ?? {}) };
        const inserted = await tx<{ id: string }[]>`
          insert into observations (id, org_id, aoi_id, run_id, asset_id, model_id, model_version, kind, result_class, observed_at,
                                    status, metrics, quality, raster, limitations)
          values (${o.obsId}, ${orgId}, ${p.aoiId}, ${runIds[o.task.model]!}, ${p.assetId}, ${a.id}, ${a.version}, ${o.task.kind},
                  ${a.resultClass}, ${asset.acquired_at}, ${o.out.status}, ${jsonb(o.out.metrics ?? {})}::jsonb,
                  ${jsonb(quality)}::jsonb, ${jsonb(o.raster)}::jsonb, ${a.limitations as unknown as string[]})
          on conflict (aoi_id, asset_id, model_id, model_version) do nothing
          returning id`;
        if (inserted.length === 0) continue;
        // Older method versions for the same (aoi, asset) remain as history.
        await tx`update observations set is_current = false, superseded_by = ${o.obsId}
                  where aoi_id = ${p.aoiId} and asset_id = ${p.assetId} and model_id = ${a.id} and id <> ${o.obsId} and is_current`;
        await tx`
          update processing_runs set status = ${o.out.status === "valid" ? "succeeded" : "insufficient_data"},
                 finished_at = now(), quality = ${jsonb(quality)}::jsonb,
                 outputs = ${jsonb({ observation_id: o.obsId, status: o.out.status })}::jsonb,
                 messages = ${o.out.status === "valid" ? [] : [o.out.quality.unusable_reason ?? "Insufficient usable pixels."]}
           where id = ${runIds[o.task.model]!}`;
        created.push({ id: o.obsId, kind: o.task.kind, status: o.out.status });
      }
      const anyValid = created.some((c) => c.status === "valid");
      await tx`update aoi_assets set status = ${anyValid ? "processed" : "unusable"},
                 status_reason = ${anyValid ? null : prepared[0]?.out.quality.unusable_reason ?? "No usable pixels."}
               where aoi_id = ${p.aoiId} and asset_id = ${p.assetId}`;

      // 4. Follow-on work. Comparisons against history (change detection and
      // the anomaly score) run as a separate, lower-priority job so that,
      // during a backfill, they see every image processed in the same batch.
      const enabled = new Set(aoi.enabled_analytics);
      for (const c of created.filter((x) => x.status === "valid")) {
        const wantsFollowUp =
          (c.kind === "ndvi" && (enabled.has("ndvi-change") || enabled.has("ndvi-anomaly") || enabled.has("ndvi-zones"))) ||
          ((c.kind === "ndwi" || c.kind === "s1_water") && enabled.has("water-change"));
        if (wantsFollowUp) {
          await enqueueTx(tx, {
            orgId,
            type: JOB.aoiChangeDetection,
            payload: { aoiId: p.aoiId, observationId: c.id, reprocess: Boolean(p.reprocess), historical },
            priority: 70,
            idempotencyKey: `change:${c.id}:${ANALYTICS["ndvi-change"].version}:${ANALYTICS["water-change"].version}:${ANALYTICS["ndvi-zones"].version}`,
            timeoutSeconds: 600,
          });
        }
      }
      if (created.length) {
        await enqueueTx(tx, {
          orgId,
          type: JOB.alertsEvaluate,
          payload: { aoiId: p.aoiId, trigger: { kind: "observation", ids: created.map((c) => c.id) }, reprocessing: Boolean(p.reprocess), historical },
          priority: 75,
          idempotencyKey: `alerts:obs:${createHash("sha1").update(created.map((c) => c.id).sort().join(",")).digest("hex")}`,
        });
      }
      return created;
    });
    return { observations: result };
  } catch (err) {
    const permanent =
      err instanceof PermanentJobError ||
      (err instanceof RasterAnalyticsError && !isRetryable(err)) ||
      (isProviderError(err) && (err.code === "unconfigured" || err.code === "not_found"));
    const message = err instanceof Error ? err.message : String(err);
    await withTenant({ orgId }, async (tx) => {
      await tx`update processing_runs set status = 'failed', finished_at = now(), error = ${message.slice(0, 2000)}
                where id = any(${Object.values(runIds)}::uuid[]) and status = 'running'`;
      if (permanent) await tx`update aoi_assets set status = 'failed', status_reason = ${message.slice(0, 500)} where aoi_id = ${p.aoiId} and asset_id = ${p.assetId}`;
    });
    if (permanent && !(err instanceof PermanentJobError)) throw new PermanentJobError(message);
    throw err;
  }
}

async function setLinkStatus(orgId: string, aoiId: string, assetId: string, status: string, reason: string | null) {
  await withTenant({ orgId }, (tx: Tx) => tx`update aoi_assets set status = ${status}, status_reason = ${reason} where aoi_id = ${aoiId} and asset_id = ${assetId}`);
}
