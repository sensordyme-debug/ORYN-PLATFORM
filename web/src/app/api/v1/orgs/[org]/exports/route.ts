import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";
import { createExport, listExports } from "@/server/exports/service";

export const runtime = "nodejs";

// Exports are data packages for the people who may create them; the service
// asserts exports.create for list, read and download alike.
export const GET = orgApi("exports.create", async (_req, { access }) => ok({ items: await listExports(access, { limit: 100 }) }));
export const POST = orgApi("exports.create", async (req, { access }) => ok(await createExport(access, (await readJson(req)) as never), { status: 202 }), {
  rateLimit: { limit: 20, windowMs: 60_000 },
});
