import { orgApi } from "@/server/authz/next";
import { ok } from "@/server/http";
import { getObservation } from "@/server/results/service";

export const runtime = "nodejs";

export const GET = orgApi<{ org: string; id: string }>("results.read", async (_req, { access }, { id }) => ok(await getObservation(access, id)));
