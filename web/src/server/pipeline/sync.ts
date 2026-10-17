/**
 * Imagery catalog synchronization (Workflow C, steps 1–4).
 *
 *  aoi.catalog_sync      one AOI: backfill history when an AOI is created or
 *                        its geometry/sources change, or on request.
 *  provider.catalog_sync one spatial cluster of due AOIs (from the
 *                        scheduler): a single catalog search whose new items
 *                        are matched against every subscribed AOI they
 *                        intersect, across tenants.
 *
 * Providers are polled — none of them push notifications. Searches use the
 * AOI/cluster bounding box and a date window; items already known are
 * deduplicated by (provider, collection, item id).
 */
import { bboxToPolygon, type BBox } from "@/lib/geo";
import { jsonb, withSystem, withTenant, type Tx } from "@/server/db/client";
import { PermanentJobError } from "@/server/jobs/queue";
import type { JobContext } from "@/server/jobs/worker";
import { linkAndQueue, matchAssets, upsertSourceAssets } from "@/server/pipeline/assets";
import { isProviderError } from "@/server/providers/http";
import { getImageryProduct } from "@/server/providers/imagery";
import { recordProviderFailure, recordProviderSuccess } from "@/server/providers/status";
import { isImageryProduct } from "@/server/jobs/scheduler";

const ANNUAL_PRODUCTS = new Set(["planetary-computer:esa-worldcover", "planetary-computer:io-lulc-annual-v02"]);
const OPTICAL = new Set(["earth-search:sentinel-2-l2a", "planetary-computer:landsat-c2-l2", "copernicus-dataspace:sentinel-2-l2a", "nasa-cmr:hls"]);

type SyncOutcome = { productId: string; found: number; new: number; queued: number; skipped: number; error?: string };

async function searchProduct(ctx: JobContext, productId: string, bbox: BBox, lookbackDays: number, maxCloudCover: number | undefined) {
  const found = getImageryProduct(productId);
  if (!found) throw new PermanentJobError(`Unknown imagery product "${productId}".`);
  const av = found.provider.availability();
  if (av.state !== "available") {
    const e = new Error(`${found.provider.descriptor.name}: ${av.reason}`);
    (e as Error & { availability: string }).availability = av.state;
    throw e;
  }
  const end = new Date();
  const start = ANNUAL_PRODUCTS.has(productId) ? new Date("2017-01-01T00:00:00Z") : new Date(end.getTime() - lookbackDays * 86_400_000);
  const assets = await found.provider.search({
    productId,
    intersects: bboxToPolygon(bbox),
    start,
    end,
    maxCloudCover: OPTICAL.has(productId) ? maxCloudCover : undefined,
    limit: 250,
    signal: ctx.signal,
  });
  return { provider: found.provider, assets };
}

async function recordSyncRun(tx: Tx, r: { providerId: string; orgId: string | null; aoiId: string | null; product: string; status: string; found: number; isNew: number; error?: string; details?: Record<string, unknown> }) {
  await tx`
    insert into provider_sync_runs (provider_id, org_id, aoi_id, product, finished_at, status, items_found, items_new, error, details)
    values (${r.providerId}, ${r.orgId}, ${r.aoiId}, ${r.product}, now(), ${r.status}, ${r.found}, ${r.isNew}, ${r.error ?? null}, ${jsonb(r.details ?? {})}::jsonb)`;
}

function failureState(err: unknown): "degraded" | "unconfigured" | "disabled" {
  const a = (err as { availability?: string }).availability;
  if (a === "unconfigured" || a === "disabled") return a;
  if (isProviderError(err) && err.code === "unconfigured") return "unconfigured";
  return "degraded";
}

export async function aoiCatalogSyncHandler(ctx: JobContext): Promise<unknown> {
  const p = ctx.job.payload as { aoiId: string; lookbackDays?: number; mode?: string };
  const orgId = ctx.job.org_id;
  if (!orgId) throw new PermanentJobError("aoi.catalog_sync requires an organization.");
  const aoi = await withTenant({ orgId }, async (tx) => {
    const [a] = await tx<{ status: string; data_sources: string[]; max_cloud_cover: string; bbox: BBox }[]>`
      select status, data_sources, max_cloud_cover,
             array[ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)]::float8[] as bbox
        from aois where id = ${p.aoiId} and org_id = ${orgId}`;
    return a;
  });
  if (!aoi) throw new PermanentJobError("The area no longer exists.");
  if (aoi.status !== "active") return { skipped: "archived" };

  const outcomes: SyncOutcome[] = [];
  let transientFailures = 0;
  const products = aoi.data_sources.filter(isImageryProduct);
  for (const productId of products) {
    ctx.checkpoint();
    await ctx.progress({ step: "searching", productId, done: outcomes.length, of: products.length });
    const providerId = productId.split(":")[0]!;
    try {
      const { assets } = await searchProduct(ctx, productId, aoi.bbox, p.lookbackDays ?? 180, Number(aoi.max_cloud_cover));
      const r = await withTenant({ orgId }, async (tx) => {
        const up = await upsertSourceAssets(tx, assets);
        const matches = await matchAssets(tx, up.map((u) => u.id), productId, [p.aoiId]);
        const q = await linkAndQueue(tx, matches, { productId, reason: p.mode ?? "backfill", createdBy: ctx.job.created_by });
        await recordSyncRun(tx, { providerId, orgId, aoiId: p.aoiId, product: productId, status: "succeeded", found: assets.length, isNew: up.filter((u) => u.inserted).length, details: q });
        return { found: assets.length, new: up.filter((u) => u.inserted).length, ...q };
      });
      outcomes.push({ productId, found: r.found, new: r.new, queued: r.queued, skipped: r.skipped });
      await recordProviderSuccess(providerId, { last_product: productId });
    } catch (err) {
      if (err instanceof PermanentJobError) throw err;
      const state = failureState(err);
      if (state === "degraded") transientFailures++;
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ productId, found: 0, new: 0, queued: 0, skipped: 0, error: message });
      await recordProviderFailure(providerId, err, state);
      await withTenant({ orgId }, (tx) => recordSyncRun(tx, { providerId, orgId, aoiId: p.aoiId, product: productId, status: "failed", found: 0, isNew: 0, error: message.slice(0, 1000) }));
    }
  }
  await withTenant({ orgId }, (tx) => tx`update aois set last_checked_at = now() where id = ${p.aoiId}`);
  // Retry only if every product failed transiently; otherwise the partial result stands and failures are recorded.
  if (products.length > 0 && transientFailures === products.length) {
    throw new Error(`All imagery searches failed: ${outcomes.map((o) => `${o.productId}: ${o.error}`).join("; ")}`);
  }
  return { outcomes };
}

export async function providerCatalogSyncHandler(ctx: JobContext): Promise<unknown> {
  const p = ctx.job.payload as { productId: string; bbox: BBox; lookbackDays?: number; triggeredBy?: string[] };
  const providerId = p.productId.split(":")[0]!;
  try {
    const { assets } = await searchProduct(ctx, p.productId, p.bbox, p.lookbackDays ?? 10, 100);
    const r = await withSystem("provider.catalog_sync.match", async (tx) => {
      const up = await upsertSourceAssets(tx, assets);
      const fresh = up.filter((u) => u.inserted || u.metadataChanged);
      // Match every asset in the window: new items, and known items not yet linked to a newly added AOI.
      const matches = await matchAssets(tx, up.map((u) => u.id), p.productId);
      const q = await linkAndQueue(tx, matches, { productId: p.productId, reason: "scheduled" });
      await recordSyncRun(tx, {
        providerId,
        orgId: null,
        aoiId: null,
        product: p.productId,
        status: "succeeded",
        found: assets.length,
        isNew: fresh.length,
        details: { ...q, clustered_aois: p.triggeredBy?.length ?? 0, republished: up.filter((u) => u.metadataChanged).length },
      });
      return { found: assets.length, new: fresh.length, ...q };
    });
    await recordProviderSuccess(providerId, { last_product: p.productId });
    return r;
  } catch (err) {
    if (err instanceof PermanentJobError) throw err;
    await recordProviderFailure(providerId, err, failureState(err));
    await withSystem("provider.catalog_sync.fail", (tx) =>
      recordSyncRun(tx, { providerId, orgId: null, aoiId: null, product: p.productId, status: "failed", found: 0, isNew: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) }),
    );
    if (failureState(err) !== "degraded") throw new PermanentJobError(err instanceof Error ? err.message : String(err));
    throw err;
  }
}
