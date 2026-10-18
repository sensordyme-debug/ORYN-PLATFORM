import { getAgronomy, saveAgronomy } from "@/server/agronomy/service";
import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";

export const runtime = "nodejs";

/** The field's agronomy inputs (crop, planting date, soil, rooting depth) and its irrigation log. */
export const GET = orgApi<{ org: string; id: string }>("aoi.read", async (_req, { access }, { id }) => ok(await getAgronomy(access, id)));

/**
 * Replace the field's agronomy inputs: { crop, plantingDate, stageDays, soilTexture,
 * availableWaterMmPerM, rootDepthM, notes } (see src/server/agronomy/service.ts).
 */
export const PUT = orgApi<{ org: string; id: string }>("aoi.write", async (req, { access }, { id }) => ok(await saveAgronomy(access, id, await readJson(req))), {
  rateLimit: { limit: 30, windowMs: 60_000 },
});
