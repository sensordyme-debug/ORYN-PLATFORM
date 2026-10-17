import { orgApi } from "@/server/authz/next";
import { searchParam } from "@/server/http";
import { observationPng } from "@/server/results/service";

export const runtime = "nodejs";

/** Rendered PNG for an observation (?layer=index|true_color). Private, tenant-checked, cacheable per user. */
export const GET = orgApi<{ org: string; id: string }>(
  "results.read",
  async (req, { access }, { id }) => {
    const layer = searchParam(req, "layer") === "true_color" ? "true_color" : "index";
    const png = await observationPng(access, id, layer);
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  },
  { rateLimit: { limit: 600, windowMs: 60_000 } },
);
