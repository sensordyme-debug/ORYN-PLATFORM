/**
 * Reference layers: context data shown on the map and intersected with
 * candidate changes — OpenStreetMap infrastructure (imported by a job) and
 * organization-provided layers such as permits or parcels (from uploads).
 *
 * Intersections are context for a reviewer ("this candidate overlaps permit
 * 2026-114"), never a determination that something is or is not permitted.
 */
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import type { OrgAccess } from "@/server/authz/access";
import { getAoi } from "@/server/aois/service";
import { jsonb, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { OSM_CATEGORIES } from "@/server/providers/reference/overpass";
import { loadUploadFeatures } from "@/server/uploads/service";

export const REFERENCE_KINDS = ["permits", "parcels", "boundary", "roads", "buildings", "infrastructure", "hydrology", "land_use", "custom"] as const;

export type ReferenceLayerView = {
  id: string;
  aoiId: string | null;
  aoiName: string | null;
  name: string;
  kind: string;
  source: Record<string, unknown>;
  license: string | null;
  attribution: string | null;
  redistribution: string | null;
  featureCount: number;
  createdAt: Date;
};

export async function listReferenceLayers(access: OrgAccess, opts: { aoiId?: string } = {}): Promise<ReferenceLayerView[]> {
  access.assert("results.read");
  return access.tx(async (tx) => {
    const rows = await tx<{ id: string; aoi_id: string | null; aoi_name: string | null; name: string; kind: string; source: Record<string, unknown>; license: string | null; attribution: string | null; redistribution: string | null; feature_count: number; created_at: Date }[]>`
      select l.id, l.aoi_id, a.name as aoi_name, l.name, l.kind, l.source, l.license, l.attribution, l.redistribution, l.feature_count, l.created_at
        from reference_layers l left join aois a on a.id = l.aoi_id
       where l.org_id = ${access.org.id} ${opts.aoiId ? tx`and l.aoi_id = ${opts.aoiId}` : tx``}
       order by l.created_at desc`;
    return rows.map((r) => ({
      id: r.id,
      aoiId: r.aoi_id,
      aoiName: r.aoi_name,
      name: r.name,
      kind: r.kind,
      source: r.source,
      license: r.license,
      attribution: r.attribution,
      redistribution: r.redistribution,
      featureCount: r.feature_count,
      createdAt: r.created_at,
    }));
  });
}

export async function referenceLayerFeatures(access: OrgAccess, layerId: string, limit = 5000) {
  access.assert("results.read");
  if (!z.uuid().safeParse(layerId).success) throw notFoundError("Reference layer");
  return access.tx(async (tx) => {
    const [layer] = await tx<{ id: string; kind: string; attribution: string | null }[]>`
      select id, kind, attribution from reference_layers where id = ${layerId} and org_id = ${access.org.id}`;
    if (!layer) throw notFoundError("Reference layer");
    const rows = await tx<{ feature: GeoJSON.Feature }[]>`
      select json_build_object('type', 'Feature', 'id', f.id,
                               'geometry', ST_AsGeoJSON(f.geom, 7)::json,
                               'properties', f.properties || jsonb_build_object('external_id', f.external_id, 'layer_kind', ${layer.kind}::text)) as feature
        from reference_features f where f.layer_id = ${layerId} and f.org_id = ${access.org.id}
       limit ${Math.min(limit, 20000)}`;
    return { type: "FeatureCollection" as const, attribution: layer.attribution, features: rows.map((r) => r.feature) };
  });
}

export const osmImportSchema = z.object({ categories: z.array(z.enum(OSM_CATEGORIES)).min(1).max(OSM_CATEGORIES.length) });

/** Queue an OpenStreetMap context import for an AOI's bounding box. */
export async function requestOsmImport(access: OrgAccess, aoiId: string, raw: z.input<typeof osmImportSchema>) {
  access.assert("layers.manage");
  const input = osmImportSchema.parse(raw);
  return access.tx(async (tx) => {
    const aoi = await getAoi(access, aoiId, tx);
    const areaKm2 = (aoi.bbox[2] - aoi.bbox[0]) * (aoi.bbox[3] - aoi.bbox[1]) * 111 * 111 * Math.cos((aoi.labelPoint[1] * Math.PI) / 180);
    if (areaKm2 > 400) throw new DomainError("too_large", "OpenStreetMap imports are limited to areas whose bounding box is under 400 km².", 422);
    const job = await enqueueTx(tx, {
      orgId: access.org.id,
      type: JOB.referenceImport,
      payload: { aoiId, categories: [...input.categories].sort(), requestedBy: access.tenant.userId ?? null },
      priority: 90,
      timeoutSeconds: 300,
      idempotencyKey: `osm:${aoiId}:${[...input.categories].sort().join(",")}:${Math.floor(Date.now() / 600_000)}`,
      createdBy: access.tenant.userId ?? null,
    });
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "reference.osm_import_requested", targetType: "aoi", targetId: aoiId, metadata: input, ...access.meta });
    return job;
  });
}

export const uploadLayerSchema = z.object({
  uploadId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(REFERENCE_KINDS),
  aoiId: z.uuid().nullable().default(null),
});

/** Store an uploaded GeoJSON as an organization reference layer (e.g. permits, parcels). */
export async function importUploadAsLayer(access: OrgAccess, raw: z.input<typeof uploadLayerSchema>) {
  access.assert("layers.manage");
  const input = uploadLayerSchema.parse(raw);
  const { features, filename, sha256 } = await loadUploadFeatures(access, input.uploadId);
  if (features.length === 0) throw new DomainError("invalid", "The upload has no usable features.", 422);
  return access.tx(async (tx) => {
    if (input.aoiId) await getAoi(access, input.aoiId, tx);
    const [layer] = await tx<{ id: string }[]>`
      insert into reference_layers (org_id, aoi_id, name, kind, source, license, attribution, redistribution, feature_count, created_by)
      values (${access.org.id}, ${input.aoiId}, ${input.name}, ${input.kind},
              ${jsonb({ method: "upload", upload_id: input.uploadId, filename, sha256, imported_at: new Date().toISOString() })}::jsonb,
              'Provided by the organization', ${`${access.org.name} (uploaded file ${filename})`}, 'Organization data — follow your own data-sharing policy', ${features.length},
              ${access.tenant.userId ?? null})
      returning id`;
    for (const f of features) {
      await tx`
        insert into reference_features (org_id, layer_id, external_id, geom, properties)
        values (${access.org.id}, ${layer!.id}, ${`feature-${f.index}`}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326),
                ${jsonb({ ...f.properties, ...(f.name ? { name: f.name } : {}) })}::jsonb)`;
    }
    await tx`update uploads set status = 'imported', result = result || ${jsonb({ reference_layer_id: layer!.id })}::jsonb where id = ${input.uploadId} and org_id = ${access.org.id}`;
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "reference.layer_import", targetType: "reference_layer", targetId: layer!.id, metadata: { kind: input.kind, features: features.length, filename }, ...access.meta });
    return { id: layer!.id, features: features.length };
  });
}

export async function deleteReferenceLayer(access: OrgAccess, layerId: string) {
  access.assert("layers.manage");
  if (!z.uuid().safeParse(layerId).success) throw notFoundError("Reference layer");
  return access.tx(async (tx) => {
    const rows = await tx`delete from reference_layers where id = ${layerId} and org_id = ${access.org.id} returning name`;
    if (rows.length === 0) throw notFoundError("Reference layer");
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "reference.layer_delete", targetType: "reference_layer", targetId: layerId, ...access.meta });
  });
}

export type ReferenceMatch = { layerId: string; layerName: string; kind: string; count: number; samples: { externalId: string; name: string | null }[]; attribution: string | null };

/** Reference features of this org intersecting a geometry, grouped by layer. */
export async function referenceMatches(tx: Tx, orgId: string, geometry: unknown): Promise<ReferenceMatch[]> {
  const rows = await tx<{ layer_id: string; name: string; kind: string; attribution: string | null; n: number; samples: { externalId: string; name: string | null }[] }[]>`
    with g as (select ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326) as geom)
    select l.id as layer_id, l.name, l.kind, l.attribution, count(*)::int as n,
           (array_agg(json_build_object('externalId', f.external_id, 'name', f.properties->>'name')))[1:5] as samples
      from reference_features f join reference_layers l on l.id = f.layer_id, g
     where f.org_id = ${orgId} and f.geom && g.geom and ST_Intersects(f.geom, g.geom)
     group by l.id, l.name, l.kind, l.attribution
     order by l.kind`;
  return rows.map((r) => ({ layerId: r.layer_id, layerName: r.name, kind: r.kind, count: r.n, samples: r.samples, attribution: r.attribution }));
}
