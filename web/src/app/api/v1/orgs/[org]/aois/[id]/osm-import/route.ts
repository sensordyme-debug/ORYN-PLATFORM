import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";
import { requestOsmImport } from "@/server/reference/service";

export const runtime = "nodejs";

/** Queue an OpenStreetMap context import. Body: { categories: ["roads", "buildings", …] } */
export const POST = orgApi<{ org: string; id: string }>("layers.manage", async (req, { access }, { id }) =>
  ok(await requestOsmImport(access, id, (await readJson(req)) as never), { status: 202 }),
  { rateLimit: { limit: 10, windowMs: 60_000 } },
);
