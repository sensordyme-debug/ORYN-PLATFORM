/**
 * Geospatial file uploads (boundaries, permit polygons, reference layers).
 *
 * Accepted: GeoJSON (.geojson / .json) up to ORYN_MAX_UPLOAD_BYTES. The file
 * is parsed as data only — never executed or served back as-is — validated
 * against the geometry schema, and recorded in `uploads` with its SHA-256 so
 * imports are traceable. Other formats (Shapefile, KML, GeoPackage) are
 * rejected with an explicit message rather than half-supported.
 *
 * Malware scanning is not integrated: uploads are parsed as JSON text and
 * never stored or redistributed in their original form. See docs/SECURITY.md.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { aoiInputGeometrySchema, geometryArea, type Geometry } from "@/lib/geo";
import { recordAudit } from "@/server/audit";
import type { OrgAccess } from "@/server/authz/access";
import { env } from "@/server/config/env";
import { jsonb } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { orgKey, storage } from "@/server/storage";

export type ParsedFeature = { index: number; geometry: Geometry; properties: Record<string, unknown>; name: string | null; areaM2: number };

export type UploadResult = {
  uploadId: string;
  status: "validated" | "rejected";
  features: ParsedFeature[];
  errors: string[];
  skipped: number;
};

const ALLOWED_EXT = /\.(geo)?json$/i;

function nameOf(props: Record<string, unknown>): string | null {
  for (const k of ["name", "NAME", "Name", "title", "label", "FIELD_NAME", "field_name", "id"]) {
    const v = props[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 160);
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function parseGeoJson(text: string): { features: ParsedFeature[]; errors: string[]; skipped: number } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { features: [], errors: ["The file is not valid JSON."], skipped: 0 };
  }
  const o = doc as { type?: string; features?: unknown[]; geometry?: unknown; properties?: unknown; crs?: { properties?: { name?: string } } };
  const crs = o.crs?.properties?.name;
  if (crs && !/(CRS84|4326)/i.test(crs)) {
    return { features: [], errors: [`Coordinates use ${crs}. GeoJSON must be in WGS 84 longitude/latitude (EPSG:4326); reproject the file first.`], skipped: 0 };
  }
  const raw: { geometry: unknown; properties: unknown }[] =
    o.type === "FeatureCollection" && Array.isArray(o.features)
      ? (o.features as { geometry: unknown; properties: unknown }[])
      : o.type === "Feature"
        ? [{ geometry: o.geometry, properties: o.properties }]
        : o.type && ["Polygon", "MultiPolygon", "Point", "LineString"].includes(o.type)
          ? [{ geometry: doc, properties: {} }]
          : [];
  if (raw.length === 0) return { features: [], errors: ["No GeoJSON features were found."], skipped: 0 };
  if (raw.length > 5000) return { features: [], errors: ["The file has more than 5,000 features. Split it before uploading."], skipped: 0 };

  const features: ParsedFeature[] = [];
  const errors: string[] = [];
  let skipped = 0;
  raw.forEach((f, index) => {
    const g = aoiInputGeometrySchema.safeParse(f?.geometry);
    if (!g.success) {
      skipped++;
      if (errors.length < 10) errors.push(`Feature ${index + 1}: ${g.error.issues[0]?.message ?? "unsupported geometry"}`);
      return;
    }
    const properties = f.properties && typeof f.properties === "object" ? (f.properties as Record<string, unknown>) : {};
    features.push({ index, geometry: g.data as Geometry, properties, name: nameOf(properties), areaM2: geometryArea(g.data as Geometry) });
  });
  return { features, errors, skipped };
}

export async function receiveUpload(access: OrgAccess, file: { name: string; type: string; bytes: Uint8Array }): Promise<UploadResult> {
  access.assert("uploads.create");
  const max = env.maxUploadBytes();
  if (file.bytes.byteLength > max) throw new DomainError("too_large", `The file is ${(file.bytes.byteLength / 1e6).toFixed(1)} MB; the limit is ${(max / 1e6).toFixed(0)} MB.`, 422);
  if (!ALLOWED_EXT.test(file.name)) {
    throw new DomainError("unsupported_format", "Only GeoJSON files (.geojson or .json) are accepted. Convert Shapefile, KML, or GeoPackage to GeoJSON (EPSG:4326) first.", 422);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(file.bytes);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const parsed = parseGeoJson(text);
  const status = parsed.features.length > 0 ? "validated" : "rejected";
  const id = await access.tx(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into uploads (org_id, filename, content_type, size_bytes, sha256, status, validation_errors, result, created_by)
      values (${access.org.id}, ${file.name.slice(0, 200)}, ${file.type.slice(0, 100) || "application/geo+json"}, ${file.bytes.byteLength}, ${sha256},
              ${status}, ${parsed.errors}, ${jsonb({ features: parsed.features.length, skipped: parsed.skipped })}::jsonb, ${access.tenant.userId ?? null})
      returning id`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "upload.receive",
      targetType: "upload",
      targetId: row!.id,
      metadata: { filename: file.name, bytes: file.bytes.byteLength, sha256, status, features: parsed.features.length, skipped: parsed.skipped },
      ...access.meta,
    });
    return row!.id;
  });
  if (status === "validated") {
    // Keep the normalized features (not the original bytes) for the import step.
    await storage().put(orgKey(access.org.id, "uploads", id, "features.json"), Buffer.from(JSON.stringify(parsed.features)), "application/json");
  }
  return { uploadId: id, status, features: parsed.features, errors: parsed.errors, skipped: parsed.skipped };
}

export async function loadUploadFeatures(access: OrgAccess, uploadId: string): Promise<{ features: ParsedFeature[]; filename: string; sha256: string }> {
  access.assert("aoi.write");
  if (!z.uuid().safeParse(uploadId).success) throw notFoundError("Upload");
  const row = await access.tx(async (tx) => {
    const [r] = await tx<{ filename: string; sha256: string; status: string }[]>`
      select filename, sha256, status from uploads where id = ${uploadId} and org_id = ${access.org.id}`;
    return r;
  });
  if (!row || row.status === "rejected") throw notFoundError("Upload");
  const obj = await storage().get(orgKey(access.org.id, "uploads", uploadId, "features.json"));
  if (!obj) throw notFoundError("Upload data");
  return { features: JSON.parse(obj.body.toString("utf8")) as ParsedFeature[], filename: row.filename, sha256: row.sha256 };
}

export async function markUploadImported(access: OrgAccess, uploadId: string, aoiIds: string[]) {
  await access.tx(async (tx) => {
    await tx`update uploads set status = 'imported', result = result || ${jsonb({ aoi_ids: aoiIds })}::jsonb where id = ${uploadId} and org_id = ${access.org.id}`;
  });
}
