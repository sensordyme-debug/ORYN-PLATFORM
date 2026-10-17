import { z } from "zod";
import { orgApi } from "@/server/authz/next";
import { ok, searchParam } from "@/server/http";
import { cameras } from "@/server/intel/cameras";

export const runtime = "nodejs";

const bbox = z
  .string()
  .transform((s) => s.split(",").map(Number))
  .pipe(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]))
  .refine(([, s, , n]) => s <= n, "south must not exceed north");

/**
 * Public cameras in view (Caltrans CCTV), or matching `q` anywhere: locations
 * and media URLs only — ORYN never relays the video.
 */
export const GET = orgApi(
  "results.read",
  async (req) => {
    const b = bbox.parse(searchParam(req, "bbox") ?? "-180,-90,180,90") as [number, number, number, number];
    const q = z.string().trim().min(2).max(60).optional().parse(searchParam(req, "q") || undefined);
    return ok(await cameras(b, { q }), { headers: { "Cache-Control": "private, max-age=300" } });
  },
  { rateLimit: { limit: 60, windowMs: 60_000 } },
);
