/**
 * Source-asset ingestion and AOI matching (Workflow C, steps 1–4).
 *
 *  - upsertSourceAssets: idempotent on (provider, collection, external id).
 *    Re-seeing an item only bumps last_seen_at; if the provider changed its
 *    metadata (hash differs), the stored metadata is replaced and the change
 *    is reported so it can be audited — first_seen_at never moves.
 *  - matchAssets: finds active AOIs (any tenant) subscribed to the product
 *    whose geometry intersects each footprint and whose cloud limit admits
 *    the scene, with the fraction of the AOI the footprint covers.
 *  - linkAndQueue: records the (aoi, asset) link and queues processing once;
 *    re-running is a no-op. Footprints covering too little of an AOI are
 *    linked as 'skipped' with the reason, so the history explains itself.
 *    So is a second item of the SAME acquisition: providers publish one item
 *    per granule and per tile, so one satellite pass can arrive as several
 *    items (Sentinel-2 "_0"/"_1" granules seconds apart, or neighbouring UTM
 *    tiles). When an item of the same satellite within ±2 minutes already
 *    covers the whole area, the other is not processed again. Preference
 *    within a batch: the tile in the area's own UTM zone (so later images
 *    stay comparable on one grid), then higher coverage, then the earliest
 *    item. Items covering only part of the area are all processed (there is
 *    no mosaicking).
 */
import { createHash } from "node:crypto";
import { jsonb, type Tx } from "@/server/db/client";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { NormalizedAsset } from "@/server/providers/types";

/** Bump when the set of analytics run per asset changes, so new work is queued for old assets. */
export const PROCESSING_SET_VERSION = "1";
export const MIN_COVERAGE_FRACTION = 0.05;
/** Items of one satellite this close in time are the same acquisition (granules / tiles of one pass). */
export const SAME_ACQUISITION_SECONDS = 120;
/** An item covering at least this much of the area can stand for the whole acquisition. */
export const FULL_COVERAGE_FRACTION = 0.98;

/** EPSG of the WGS 84 / UTM zone containing a point. */
export function utmEpsg(lon: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

export function assetMetadataHash(a: NormalizedAsset): string {
  const material = {
    assets: Object.fromEntries(Object.entries(a.assets).map(([k, f]) => [k, [f.href, f.bands ?? null]])),
    footprint: a.footprint,
    cloud: a.cloudCover,
    baseline: a.processingBaseline,
    acquired: a.acquiredAt.toISOString(),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

export type UpsertedAsset = { id: string; externalId: string; inserted: boolean; metadataChanged: boolean };

export async function upsertSourceAssets(tx: Tx, assets: NormalizedAsset[]): Promise<UpsertedAsset[]> {
  const out: UpsertedAsset[] = [];
  for (const a of assets) {
    const hash = assetMetadataHash(a);
    const [prior] = await tx<{ metadata_hash: string }[]>`
      select metadata_hash from source_assets
       where provider_id = ${a.providerId} and collection = ${a.collection} and external_id = ${a.externalId}`;
    const [row] = await tx<{ id: string; inserted: boolean }[]>`
      insert into source_assets (
        provider_id, collection, external_id, kind, platform, instruments, acquired_at, acquired_end_at,
        provider_published_at, footprint, cloud_cover, gsd_m, epsg, grid_code, processing_level, processing_baseline,
        properties, assets, license, license_url, attribution, stac_url, metadata_hash
      ) values (
        ${a.providerId}, ${a.collection}, ${a.externalId}, ${a.kind}, ${a.platform}, ${a.instruments},
        ${a.acquiredAt}, ${a.acquiredEndAt}, ${a.providerPublishedAt},
        ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(a.footprint)}), 4326)),
        ${a.cloudCover}, ${a.gsdM}, ${a.epsg}, ${a.gridCode}, ${a.processingLevel}, ${a.processingBaseline},
        ${jsonb(a.properties)}::jsonb, ${jsonb(a.assets)}::jsonb, ${a.license}, ${a.licenseUrl}, ${a.attribution}, ${a.stacUrl}, ${hash}
      )
      on conflict (provider_id, collection, external_id) do update set
        last_seen_at = now(),
        footprint = case when source_assets.metadata_hash <> excluded.metadata_hash then excluded.footprint else source_assets.footprint end,
        cloud_cover = case when source_assets.metadata_hash <> excluded.metadata_hash then excluded.cloud_cover else source_assets.cloud_cover end,
        assets = case when source_assets.metadata_hash <> excluded.metadata_hash then excluded.assets else source_assets.assets end,
        properties = case when source_assets.metadata_hash <> excluded.metadata_hash then excluded.properties else source_assets.properties end,
        provider_published_at = coalesce(excluded.provider_published_at, source_assets.provider_published_at),
        metadata_hash = excluded.metadata_hash
      returning id, (xmax = 0) as inserted`;
    out.push({ id: row!.id, externalId: a.externalId, inserted: row!.inserted, metadataChanged: Boolean(prior && prior.metadata_hash !== hash) });
  }
  return out;
}

export type AssetMatch = { org_id: string; aoi_id: string; asset_id: string; coverage: number; cloud_cover: number | null; max_cloud_cover: number };

/**
 * Intersect assets with subscribed active AOIs. Pass `onlyAoiIds` to restrict
 * matching (AOI backfill); omit it for provider-level syncs (all tenants —
 * call within a system context).
 */
export async function matchAssets(tx: Tx, assetIds: string[], productId: string, onlyAoiIds?: string[]): Promise<AssetMatch[]> {
  if (assetIds.length === 0) return [];
  return tx<AssetMatch[]>`
    select a.org_id, a.id as aoi_id, s.id as asset_id,
           least(1.0, ST_Area(ST_Intersection(a.geom, s.footprint)::geography) / nullif(a.area_m2, 0)) as coverage,
           s.cloud_cover::float8 as cloud_cover, a.max_cloud_cover::float8 as max_cloud_cover
      from source_assets s
      join aois a on a.geom && s.footprint and ST_Intersects(a.geom, s.footprint)
     where s.id = any(${assetIds}::uuid[])
       and a.status = 'active'
       and ${productId} = any(a.data_sources)
       ${onlyAoiIds ? tx`and a.id = any(${onlyAoiIds}::uuid[])` : tx``}`;
}

export async function linkAndQueue(
  tx: Tx,
  matches: AssetMatch[],
  opts: { productId: string; reason: string; createdBy?: string | null },
): Promise<{ queued: number; skipped: number; alreadyKnown: number }> {
  let queued = 0;
  let skipped = 0;
  let alreadyKnown = 0;
  if (matches.length === 0) return { queued, skipped, alreadyKnown };
  const meta = new Map(
    (
      await tx<{ id: string; collection: string; platform: string | null; acquired_at: Date; epsg: number | null; external_id: string }[]>`
        select id, collection, platform, acquired_at, epsg, external_id from source_assets where id = any(${[...new Set(matches.map((m) => m.asset_id))]}::uuid[])`
    ).map((r) => [r.id, r]),
  );
  const native = new Map(
    (
      await tx<{ id: string; lon: number; lat: number }[]>`
        select id, ST_X(ST_PointOnSurface(geom)) as lon, ST_Y(ST_PointOnSurface(geom)) as lat from aois where id = any(${[...new Set(matches.map((m) => m.aoi_id))]}::uuid[])`
    ).map((r) => [r.id, utmEpsg(r.lon, r.lat)]),
  );
  // Within a batch, the preferred item of an acquisition is linked first and stands for it.
  const ordered = [...matches].sort((a, b) => {
    const ma = meta.get(a.asset_id)!;
    const mb = meta.get(b.asset_id)!;
    const na = ma.epsg === native.get(a.aoi_id) ? 0 : 1;
    const nb = mb.epsg === native.get(b.aoi_id) ? 0 : 1;
    return a.aoi_id.localeCompare(b.aoi_id) || na - nb || b.coverage - a.coverage || ma.acquired_at.getTime() - mb.acquired_at.getTime() || ma.external_id.localeCompare(mb.external_id);
  });
  for (const m of ordered) {
    const cloudy = m.cloud_cover !== null && m.cloud_cover > m.max_cloud_cover;
    const tooSmall = m.coverage < MIN_COVERAGE_FRACTION;
    const a = meta.get(m.asset_id)!;
    const [same] =
      !cloudy && !tooSmall && a.platform
        ? await tx<{ external_id: string }[]>`
            select s.external_id from aoi_assets l join source_assets s on s.id = l.asset_id
             where l.aoi_id = ${m.aoi_id} and l.asset_id <> ${m.asset_id} and l.status in ('queued', 'processed', 'unusable')
               and l.coverage_fraction >= ${FULL_COVERAGE_FRACTION}
               and s.collection = ${a.collection} and s.platform = ${a.platform}
               and abs(extract(epoch from (s.acquired_at - ${a.acquired_at}::timestamptz))) <= ${SAME_ACQUISITION_SECONDS}
             order by s.acquired_at limit 1`
        : [];
    const status = cloudy || tooSmall || same ? "skipped" : "queued";
    const reason = cloudy
      ? `Scene cloud cover ${m.cloud_cover?.toFixed(0)}% exceeds this area's limit of ${m.max_cloud_cover.toFixed(0)}%.`
      : tooSmall
        ? `The image footprint covers only ${(m.coverage * 100).toFixed(1)}% of this area.`
        : same
          ? `Same acquisition as ${same.external_id} (${a.platform}, another granule or tile of the same pass), which already covers the whole area; not processed twice.`
          : null;
    const inserted = await tx`
      insert into aoi_assets (org_id, aoi_id, asset_id, coverage_fraction, status, status_reason)
      values (${m.org_id}, ${m.aoi_id}, ${m.asset_id}, ${Math.min(1, m.coverage)}, ${status}, ${reason})
      on conflict (aoi_id, asset_id) do nothing
      returning aoi_id`;
    if (inserted.length === 0) {
      alreadyKnown++;
      continue;
    }
    if (status === "skipped") {
      skipped++;
      continue;
    }
    await enqueueTx(tx, {
      orgId: m.org_id,
      type: JOB.aoiProcessAsset,
      payload: { aoiId: m.aoi_id, assetId: m.asset_id, productId: opts.productId, reason: opts.reason },
      priority: 60,
      timeoutSeconds: 900,
      idempotencyKey: `process:${m.aoi_id}:${m.asset_id}:${PROCESSING_SET_VERSION}`,
      createdBy: opts.createdBy ?? null,
    });
    queued++;
  }
  return { queued, skipped, alreadyKnown };
}
