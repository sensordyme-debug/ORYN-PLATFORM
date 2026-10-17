import { z } from "zod";
import { orgApi } from "@/server/authz/next";
import { DomainError } from "@/server/errors";
import { ok, searchParam } from "@/server/http";
import { MAX_OFFSET_DAYS, satelliteTracks } from "@/server/intel/satellites";

export const runtime = "nodejs";

/**
 * Computed tracks of the satellites behind ORYN's imagery, around `at`
 * (default now). Positions are model output from orbital elements.
 */
export const GET = orgApi(
  "results.read",
  async (req) => {
    const raw = searchParam(req, "at");
    const at = raw ? new Date(z.iso.datetime({ offset: true }).parse(raw)) : new Date();
    if (Math.abs(at.getTime() - Date.now()) > MAX_OFFSET_DAYS * 86_400_000) {
      throw new DomainError("invalid", `Satellite positions are available within ${MAX_OFFSET_DAYS} days of now.`, 422, { at: "Out of range." });
    }
    return ok(await satelliteTracks(at), { headers: { "Cache-Control": "private, max-age=60" } });
  },
  { rateLimit: { limit: 60, windowMs: 60_000 } },
);
