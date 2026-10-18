import { waterBalance } from "@/server/agronomy/service";
import { orgApi } from "@/server/authz/next";
import { ok } from "@/server/http";

export const runtime = "nodejs";

/** FAO-56 crop water balance for the field through yesterday, from its agronomy inputs and stored weather. */
export const GET = orgApi<{ org: string; id: string }>("results.read", async (_req, { access }, { id }) => ok(await waterBalance(access, id)), {
  rateLimit: { limit: 60, windowMs: 60_000 },
});
