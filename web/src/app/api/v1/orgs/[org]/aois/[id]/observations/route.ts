import { orgApi } from "@/server/authz/next";
import { ok, searchParam } from "@/server/http";
import { listObservations } from "@/server/results/service";

export const runtime = "nodejs";

export const GET = orgApi<{ org: string; id: string }>("results.read", async (req, { access }, { id }) =>
  ok({ items: await listObservations(access, id, { kind: searchParam(req, "kind"), includeSuperseded: searchParam(req, "history") === "1" }) }),
);
