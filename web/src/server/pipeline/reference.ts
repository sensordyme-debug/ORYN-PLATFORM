/**
 * reference.import — OpenStreetMap infrastructure context for an AOI via
 * Overpass. Stored as a tenant reference layer with ODbL attribution and
 * share-alike terms recorded, replacing any previous OSM import of the same
 * categories for that AOI.
 */
import { jsonb, withTenant } from "@/server/db/client";
import { PermanentJobError } from "@/server/jobs/queue";
import type { JobContext } from "@/server/jobs/worker";
import { fetchOsmFeatures, OSM_CATEGORIES, type OsmCategory } from "@/server/providers/reference/overpass";
import { recordProviderFailure, recordProviderSuccess } from "@/server/providers/status";
import { z } from "zod";

const payloadSchema = z.object({ aoiId: z.uuid(), categories: z.array(z.enum(OSM_CATEGORIES)).min(1), requestedBy: z.string().nullable().optional() });

const KIND: Record<OsmCategory, string> = { roads: "roads", buildings: "buildings", bridges: "infrastructure", critical_facilities: "infrastructure", waterways: "hydrology" };

export async function referenceImportHandler(ctx: JobContext): Promise<unknown> {
  const parsed = payloadSchema.safeParse(ctx.job.payload);
  if (!parsed.success || !ctx.job.org_id) throw new PermanentJobError("Invalid reference import payload.");
  const { aoiId, categories } = parsed.data;
  const orgId = ctx.job.org_id;
  const aoi = await withTenant({ orgId }, async (tx) => {
    const [a] = await tx<{ name: string; bbox: [number, number, number, number] }[]>`
      select name, array[ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)]::float8[] as bbox from aois where id = ${aoiId} and org_id = ${orgId}`;
    return a;
  });
  if (!aoi) throw new PermanentJobError("The area no longer exists.");
  let result;
  try {
    result = await fetchOsmFeatures(aoi.bbox, categories, ctx.signal);
    await recordProviderSuccess("overpass");
  } catch (err) {
    await recordProviderFailure("overpass", err);
    throw err;
  }
  return withTenant({ orgId }, async (tx) => {
    const name = `OpenStreetMap: ${categories.join(", ")}`;
    await tx`delete from reference_layers where org_id = ${orgId} and aoi_id = ${aoiId} and name = ${name}`;
    const [layer] = await tx<{ id: string }[]>`
      insert into reference_layers (org_id, aoi_id, name, kind, source, license, attribution, redistribution, feature_count, created_by)
      values (${orgId}, ${aoiId}, ${name}, ${categories.length === 1 ? KIND[categories[0]!] : "infrastructure"},
              ${jsonb({ provider: "openstreetmap-overpass", query: result.query, url: result.sourceUrl, retrieved_at: result.retrievedAt, osm_base: result.osmBase, truncated: result.truncated })}::jsonb,
              ${result.license}, ${result.attribution}, ${result.shareAlike}, ${result.features.length}, ${parsed.data.requestedBy ?? null})
      returning id`;
    for (const f of result.features) {
      await tx`
        insert into reference_features (org_id, layer_id, external_id, geom, properties)
        values (${orgId}, ${layer!.id}, ${f.externalId}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326), ${jsonb(f.properties)}::jsonb)
        on conflict (layer_id, external_id) do nothing`;
    }
    return { layerId: layer!.id, features: result.features.length, truncated: result.truncated };
  });
}
