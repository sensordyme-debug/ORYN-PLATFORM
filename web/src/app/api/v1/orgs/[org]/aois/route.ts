import { aoiFeatureCollection, createAoi } from "@/server/aois/service";
import { orgApi } from "@/server/authz/next";
import { ok, readJson, searchParam } from "@/server/http";

export const runtime = "nodejs";

/** GeoJSON FeatureCollection of visible AOIs (?status=active|archived|all). */
export const GET = orgApi("aoi.read", async (req, { access }) => {
  const status = searchParam(req, "status");
  return ok(await aoiFeatureCollection(access, status === "archived" || status === "all" ? status : "active"));
});

/** Create an AOI. Body: see aoiCreateSchema. */
export const POST = orgApi("aoi.write", async (req, { access }) => ok(await createAoi(access, (await readJson(req)) as never), { status: 201 }), {
  rateLimit: { limit: 60, windowMs: 60_000 },
});
