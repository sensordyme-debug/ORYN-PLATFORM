import { recordAudit } from "@/server/audit";
import { getAoi, queueAoiRefresh } from "@/server/aois/service";
import { orgApi } from "@/server/authz/next";
import { DomainError } from "@/server/errors";
import { ok } from "@/server/http";

export const runtime = "nodejs";

/** Ask ORYN to search the catalogs for this area now (in addition to its schedule). */
export const POST = orgApi<{ org: string; id: string }>(
  "analysis.run",
  async (_req, { access }, { id }) => {
    await access.tx(async (tx) => {
      const aoi = await getAoi(access, id, tx);
      if (aoi.status !== "active") throw new DomainError("archived", "Archived areas are not monitored.", 409);
      await queueAoiRefresh(tx, access, id, "manual");
      await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "aoi.sync_requested", targetType: "aoi", targetId: id, ...access.meta });
    });
    return ok({ queued: true }, { status: 202 });
  },
  { rateLimit: { limit: 10, windowMs: 60_000 } },
);
