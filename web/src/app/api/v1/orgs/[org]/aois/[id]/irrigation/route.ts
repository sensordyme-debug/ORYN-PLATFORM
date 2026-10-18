import { addIrrigationEvent } from "@/server/agronomy/service";
import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";

export const runtime = "nodejs";

/** Log irrigation applied to the field: { appliedOn (YYYY-MM-DD), amountMm, note }. */
export const POST = orgApi<{ org: string; id: string }>("notes.write", async (req, { access }, { id }) => ok(await addIrrigationEvent(access, id, await readJson(req)), { status: 201 }), {
  rateLimit: { limit: 30, windowMs: 60_000 },
});
