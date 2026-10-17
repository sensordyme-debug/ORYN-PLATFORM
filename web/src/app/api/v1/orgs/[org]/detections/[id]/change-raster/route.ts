import { orgApi } from "@/server/authz/next";
import { detectionChangePng } from "@/server/results/service";

export const runtime = "nodejs";

/** Rendered ΔNDVI PNG of the comparison behind a candidate change. Private, tenant-checked, cacheable per user. */
export const GET = orgApi<{ org: string; id: string }>(
  "results.read",
  async (_req, { access }, { id }) => {
    const png = await detectionChangePng(access, id);
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  },
  { rateLimit: { limit: 600, windowMs: 60_000 } },
);
