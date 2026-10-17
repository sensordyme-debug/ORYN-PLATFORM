"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AOI_KINDS } from "@/lib/aoi-config";
import { createAoi, updateAoi } from "@/server/aois/service";
import { orgAction } from "@/server/authz/next";
import { DomainError } from "@/server/errors";
import { loadUploadFeatures, markUploadImported } from "@/server/uploads/service";

export async function importUploadAction(slug: string, input: { uploadId: string; indices: number[]; kind: string; parentId: string | null; bufferM?: number }) {
  const r = await orgAction(slug, "aoi.write", async (access) => {
    const kind = z.enum(AOI_KINDS).parse(input.kind);
    const { features, filename, sha256 } = await loadUploadFeatures(access, input.uploadId);
    const chosen = features.filter((f) => input.indices.includes(f.index));
    if (chosen.length === 0) throw new DomainError("invalid", "Select at least one feature to import.", 422);
    if (chosen.length > 200) throw new DomainError("invalid", "Import at most 200 areas at a time.", 422);
    const ids: string[] = [];
    for (const f of chosen) {
      const aoi = await createAoi(
        access,
        {
          name: f.name ?? `${filename.replace(/\.(geo)?json$/i, "")} #${f.index + 1}`,
          kind,
          geometry: f.geometry,
          bufferM: f.geometry.type === "Point" || f.geometry.type === "LineString" ? (input.bufferM ?? 50) : undefined,
          parentId: input.parentId,
          metadata: Object.fromEntries(
            Object.entries(f.properties)
              .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) || v === null)
              .slice(0, 30)
              .map(([k, v]) => [k.slice(0, 60), typeof v === "string" ? v.slice(0, 500) : (v as number | boolean | null)]),
          ),
        },
        { boundarySource: { method: "uploaded", upload_id: input.uploadId, note: `${filename} (sha256 ${sha256.slice(0, 12)}…), feature ${f.index + 1}`, retrieved_at: new Date().toISOString() } },
      );
      ids.push(aoi.id);
    }
    await markUploadImported(access, input.uploadId, ids);
    return { ids };
  });
  if (r.ok) revalidatePath(`/app/${slug}/areas`);
  return r;
}

export async function updateAoiSettingsAction(slug: string, aoiId: string, _: unknown, form: FormData) {
  const list = (k: string) => form.getAll(k).map(String);
  const r = await orgAction(slug, "aoi.write", (access) =>
    updateAoi(access, aoiId, {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
      kind: String(form.get("kind")) as never,
      monitoringEnabled: form.get("monitoringEnabled") === "on",
      monitoringIntervalHours: Number(form.get("monitoringIntervalHours")),
      maxCloudCover: Number(form.get("maxCloudCover")),
      dataSources: list("dataSources") as never,
      enabledAnalytics: list("enabledAnalytics") as never,
      newsTerms: String(form.get("newsTerms") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      tags: String(form.get("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    }).then(() => null),
  );
  if (r.ok) revalidatePath(`/app/${slug}/areas/${aoiId}`);
  return r;
}

export async function searchBoundariesAction(slug: string, q: { name: string; stateFips?: string; level: "place" | "county" }) {
  const { searchCensusBoundaries } = await import("@/server/aois/boundary-import");
  return orgAction(slug, "aoi.write", (access) => searchCensusBoundaries(access, q));
}

export async function importBoundaryAction(slug: string, input: { geoid: string; level: "place" | "county"; name: string; kind: string; newsTerms?: string[] }) {
  const { importCensusBoundary } = await import("@/server/aois/boundary-import");
  const r = await orgAction(slug, "aoi.write", async (access) => {
    const kind = z.enum(AOI_KINDS).parse(input.kind);
    const aoi = await importCensusBoundary(access, { ...input, kind });
    return { id: aoi.id };
  });
  if (r.ok) revalidatePath(`/app/${slug}/areas`);
  return r;
}
