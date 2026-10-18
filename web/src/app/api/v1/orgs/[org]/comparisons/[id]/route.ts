import { orgApi } from "@/server/authz/next";
import { getComparison } from "@/server/comparisons/service";
import { ok } from "@/server/http";

export const runtime = "nodejs";

/** One season comparison: periods, chosen images, every image considered, outcome, and findings. */
export const GET = orgApi<{ org: string; id: string }>("results.read", async (_req, { access }, { id }) => ok(await getComparison(access, id)));
