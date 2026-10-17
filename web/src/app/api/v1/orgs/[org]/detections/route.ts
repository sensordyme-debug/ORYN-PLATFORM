import { orgApi } from "@/server/authz/next";
import { ok, searchParam } from "@/server/http";
import { detectionFeatures } from "@/server/results/service";

export const runtime = "nodejs";

/** GeoJSON of detections. Filters: aoi, type (csv), verification (csv), minGrade, from, to, bbox (w,s,e,n). */
export const GET = orgApi("results.read", async (req, { access }) => {
  const csv = (k: string) => searchParam(req, k)?.split(",").filter(Boolean);
  const bbox = csv("bbox")?.map(Number);
  return ok(
    await detectionFeatures(access, {
      aoiId: searchParam(req, "aoi"),
      types: csv("type"),
      verification: csv("verification") as never,
      minGrade: searchParam(req, "minGrade") as never,
      from: (searchParam(req, "from") ?? (searchParam(req, "withinDays") ? new Date(Date.now() - Number(searchParam(req, "withinDays")) * 86_400_000).toISOString() : undefined)) as never,
      to: searchParam(req, "to") as never,
      bbox: bbox?.length === 4 ? (bbox as [number, number, number, number]) : undefined,
    }),
  );
});
