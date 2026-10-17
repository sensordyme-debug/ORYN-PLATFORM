import { getAoi, updateAoi } from "@/server/aois/service";
import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";

export const runtime = "nodejs";

export const GET = orgApi<{ org: string; id: string }>("aoi.read", async (_req, { access }, { id }) => ok(await getAoi(access, id)));

export const PATCH = orgApi<{ org: string; id: string }>("aoi.write", async (req, { access }, { id }) =>
  ok(await updateAoi(access, id, (await readJson(req)) as never)),
);
