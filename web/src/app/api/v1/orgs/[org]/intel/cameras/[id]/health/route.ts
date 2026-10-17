import { orgApi } from "@/server/authz/next";
import { notFoundError } from "@/server/errors";
import { ok } from "@/server/http";
import { streamHealth } from "@/server/intel/cameras";

export const runtime = "nodejs";

/** Live-stream health for one registered camera (HEAD of its playlist, cached 60 s). */
export const GET = orgApi<{ org: string; id: string }>(
  "results.read",
  async (_req, _ctx, { id }) => {
    if (!/^[a-z-]+:\d{1,2}:[A-Za-z0-9_-]{1,20}$/.test(id)) throw notFoundError("Camera");
    const h = await streamHealth(id);
    if (!h) throw notFoundError("Camera");
    return ok(h, { headers: { "Cache-Control": "private, max-age=30" } });
  },
  { rateLimit: { limit: 60, windowMs: 60_000 } },
);
