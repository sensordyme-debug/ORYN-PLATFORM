import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";
import { getDetection, reviewDetection } from "@/server/results/service";

export const runtime = "nodejs";

export const POST = orgApi<{ org: string; id: string }>("detections.review", async (req, { access }, { id }) => {
  await reviewDetection(access, id, (await readJson(req)) as never);
  return ok(await getDetection(access, id));
});
