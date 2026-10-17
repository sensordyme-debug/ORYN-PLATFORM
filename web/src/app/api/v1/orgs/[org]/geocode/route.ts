import { orgApi } from "@/server/authz/next";
import { DomainError } from "@/server/errors";
import { ok, searchParam } from "@/server/http";
import { isProviderError } from "@/server/providers/http";
import { geocode } from "@/server/providers/geocoding";

export const runtime = "nodejs";

/** Coordinates, U.S. addresses (Census geocoder), and place names (TIGERweb). */
export const GET = orgApi(
  "aoi.read",
  async (req) => {
    const q = (searchParam(req, "q") ?? "").slice(0, 200);
    if (q.trim().length < 2) throw new DomainError("invalid", "Enter at least two characters.", 422);
    try {
      return ok({ items: await geocode(q) }, { headers: { "Cache-Control": "private, max-age=300" } });
    } catch (err) {
      if (isProviderError(err)) throw new DomainError("provider_unavailable", "The geocoding service is unavailable right now.", 503);
      throw err;
    }
  },
  { rateLimit: { limit: 30, windowMs: 60_000 } },
);
