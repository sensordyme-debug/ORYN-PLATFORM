import { orgApi } from "@/server/authz/next";
import { ok } from "@/server/http";
import { deleteReferenceLayer, referenceLayerFeatures } from "@/server/reference/service";

export const runtime = "nodejs";

export const GET = orgApi<{ org: string; id: string }>("results.read", async (_req, { access }, { id }) => ok(await referenceLayerFeatures(access, id)));

export const DELETE = orgApi<{ org: string; id: string }>("layers.manage", async (_req, { access }, { id }) => {
  await deleteReferenceLayer(access, id);
  return ok({ deleted: true });
});
