import { orgApi } from "@/server/authz/next";
import { openExportDownload } from "@/server/exports/service";

export const runtime = "nodejs";

/** Download a ready export. Permission, org export setting, and expiry are enforced; every download is audited. */
export const GET = orgApi<{ org: string; id: string }>("exports.create", async (_req, { access }, { id }) => {
  const f = await openExportDownload(access, id);
  return new Response(new Uint8Array(f.body), {
    headers: {
      "Content-Type": f.contentType,
      "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
