import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";
import { createReport, listReports } from "@/server/reports/service";

export const runtime = "nodejs";

export const GET = orgApi("reports.read", async (_req, { access }) => ok({ items: await listReports(access, { limit: 100 }) }));
export const POST = orgApi("reports.generate", async (req, { access }) => ok(await createReport(access, (await readJson(req)) as never), { status: 202 }), {
  rateLimit: { limit: 20, windowMs: 60_000 },
});
