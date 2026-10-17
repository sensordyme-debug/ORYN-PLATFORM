import { orgApi } from "@/server/authz/next";
import { openReportPdf } from "@/server/reports/service";

export const runtime = "nodejs";

export const GET = orgApi<{ org: string; id: string }>("reports.read", async (_req, { access }, { id }) => {
  const f = await openReportPdf(access, id);
  return new Response(new Uint8Array(f.body), {
    headers: { "Content-Type": f.contentType, "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`, "Cache-Control": "private, no-store" },
  });
});
