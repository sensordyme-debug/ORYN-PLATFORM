import { z } from "zod";
import { orgApi } from "@/server/authz/next";
import { notFoundError } from "@/server/errors";
import { ok, searchParam } from "@/server/http";
import { publicEvents } from "@/server/public-events/service";

export const runtime = "nodejs";

const query = z.object({
  bbox: z
    .string()
    .transform((s) => s.split(",").map(Number))
    .pipe(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]))
    .refine(([, s, , n]) => s <= n, "south must not exceed north"),
  days: z.coerce.number().int().pipe(z.union([z.literal(1), z.literal(7), z.literal(30)])).optional(),
});

/**
 * Public hazard records in view (USGS earthquakes, NIFC wildfire perimeters).
 * Members only: ORYN does not run an open proxy, even for public data.
 */
export const GET = orgApi<{ org: string; layer: string }>(
  "results.read",
  async (req, _ctx, { layer }) => {
    const q = query.parse({ bbox: searchParam(req, "bbox") ?? "-180,-90,180,90", days: searchParam(req, "days") });
    const r = await publicEvents(layer, { bbox: q.bbox as [number, number, number, number], days: q.days });
    if (!r) throw notFoundError("Layer");
    return ok(r, { headers: { "Cache-Control": "private, max-age=60" } });
  },
  { rateLimit: { limit: 120, windowMs: 60_000 } },
);
