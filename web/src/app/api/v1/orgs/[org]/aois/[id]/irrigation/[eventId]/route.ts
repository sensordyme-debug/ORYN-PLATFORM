import { deleteIrrigationEvent } from "@/server/agronomy/service";
import { orgApi } from "@/server/authz/next";
import { ok } from "@/server/http";

export const runtime = "nodejs";

/** Remove a logged irrigation event (its author, or someone who may edit the area). */
export const DELETE = orgApi<{ org: string; id: string; eventId: string }>("notes.write", async (_req, { access }, { id, eventId }) => {
  await deleteIrrigationEvent(access, id, eventId);
  return ok({ deleted: true });
});
