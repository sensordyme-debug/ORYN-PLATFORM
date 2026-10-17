import { z } from "zod";
import { orgApi } from "@/server/authz/next";
import { aoiVisibleTo } from "@/server/aois/service";
import { notFoundError } from "@/server/errors";
import { ok, searchParam } from "@/server/http";
import { satelliteOverpasses } from "@/server/intel/satellites";

export const runtime = "nodejs";

const query = z.object({
  aoi: z.uuid().optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  days: z.coerce.number().int().min(1).max(5).default(3),
});

/**
 * Upcoming geometric overpasses of an area (its point on surface) or a place
 * by imaging satellites. Areas are checked against the caller's access.
 */
export const GET = orgApi(
  "results.read",
  async (req, { access }) => {
    const q = query.parse({ aoi: searchParam(req, "aoi"), lon: searchParam(req, "lon"), lat: searchParam(req, "lat"), days: searchParam(req, "days") });
    let place: { lon: number; lat: number };
    if (q.aoi) {
      const id = q.aoi;
      const [p] = await access.tx(async (tx) => {
        const rows = await tx<{ lon: number; lat: number }[]>`
          select ST_X(ST_PointOnSurface(a.geom)) as lon, ST_Y(ST_PointOnSurface(a.geom)) as lat
            from aois a where a.org_id = ${access.org.id} and a.id = ${id} ${aoiVisibleTo(tx, access)}`;
        return [...rows];
      });
      if (!p) throw notFoundError("Area");
      place = p;
    } else if (q.lon !== undefined && q.lat !== undefined) {
      place = { lon: q.lon, lat: q.lat };
    } else {
      throw notFoundError("Place");
    }
    return ok(await satelliteOverpasses(place, new Date(), q.days), { headers: { "Cache-Control": "private, max-age=300" } });
  },
  { rateLimit: { limit: 30, windowMs: 60_000 } },
);
