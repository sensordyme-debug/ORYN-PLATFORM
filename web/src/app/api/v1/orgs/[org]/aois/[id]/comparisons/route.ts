import { orgApi } from "@/server/authz/next";
import { createComparison, listComparisons } from "@/server/comparisons/service";
import { ok, readJson } from "@/server/http";

export const runtime = "nodejs";

/** Season comparisons of this area, newest first. */
export const GET = orgApi<{ org: string; id: string }>("results.read", async (_req, { access }, { id }) => ok({ items: await listComparisons(access, id) }));

/**
 * Request a season comparison: { baseline: {from, to}, comparison: {from, to} }
 * (YYYY-MM-DD). The periods must be season-matched; see src/server/comparisons/periods.ts.
 */
export const POST = orgApi<{ org: string; id: string }>(
  "analysis.run",
  async (req, { access }, { id }) => ok(await createComparison(access, id, await readJson(req)), { status: 202 }),
  { rateLimit: { limit: 6, windowMs: 60_000 } },
);
