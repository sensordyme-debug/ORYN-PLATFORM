import { z } from "zod";
import { setAoiArchived } from "@/server/aois/service";
import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";

export const runtime = "nodejs";

export const POST = orgApi<{ org: string; id: string }>("aoi.write", async (req, { access }, { id }) => {
  const { archived } = z.object({ archived: z.boolean() }).parse(await readJson(req));
  return ok(await setAoiArchived(access, id, archived));
});
