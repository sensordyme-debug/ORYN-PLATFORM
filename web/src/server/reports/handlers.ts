/**
 * Report generation job.
 *
 *   JOB.reportGenerate  org job  { reportId }
 *
 * Assembles the content snapshot from stored data, summarizes it (template
 * always; AI optionally), renders the PDF, stores it under
 * orgs/<org>/reports/<id>/report.pdf, and marks the report ready.
 *
 * Guarantees
 *  - Idempotent: a report already 'ready' is not regenerated.
 *  - On failure the report is marked 'failed' with the error and the error
 *    is rethrown so the job records it (and retries when retryable).
 *  - No transaction is held open while summarizing or rendering.
 */
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import { jsonb, withTenant } from "@/server/db/client";
import { PermanentJobError } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobHandler } from "@/server/jobs/worker";
import { orgKey, storage } from "@/server/storage";
import { parsePayload, requireOrg } from "@/server/alerts/job-payload";
import { buildReportContent, loadReportSource } from "@/server/reports/assemble";
import { renderReportPdf } from "@/server/reports/pdf";
import { summarizeReport, type SummaryClient } from "@/server/reports/summarize";
import { REPORT_SECTIONS, type ReportContent, type ReportType } from "@/server/reports/types";

export const reportGeneratePayload = z.object({ reportId: uuidSchema });

/** Read the stored PNG preview for the map, only from this org's storage prefix. */
export async function loadRasterPng(orgId: string, content: ReportContent): Promise<Buffer | null> {
  const key = content.observations?.latest?.raster?.png_key;
  if (!key || !key.startsWith(`orgs/${orgId}/`)) return null;
  try {
    return (await storage().get(key))?.body ?? null;
  } catch {
    return null;
  }
}

export async function generateReport(
  orgId: string,
  reportId: string,
  deps: { summaryClient?: SummaryClient } = {},
): Promise<{ status: "ready"; reportId: string; sizeBytes: number; summaryMethod: string } | { status: "already_ready"; reportId: string }> {
  const report = await withTenant({ orgId }, async (tx) => {
    const [r] = await tx<{ id: string; report_type: ReportType; title: string; aoi_id: string | null; status: string; params: Record<string, unknown> }[]>`
      select id, report_type, title, aoi_id, status, params from reports where id = ${reportId} and org_id = ${orgId} for update`;
    if (!r) return null;
    if (r.status !== "ready") await tx`update reports set status = 'generating', error = null where id = ${r.id} and org_id = ${orgId}`;
    return r;
  });
  if (!report) throw new PermanentJobError(`Report ${reportId} not found.`);
  if (report.status === "ready") return { status: "already_ready", reportId };

  try {
    const scope = Array.isArray(report.params.scope_aoi_ids) ? (report.params.scope_aoi_ids as string[]) : null;
    const params = Object.fromEntries(Object.entries(report.params).filter(([k]) => k !== "scope_aoi_ids"));
    const source = await withTenant({ orgId }, (tx) =>
      loadReportSource(tx, {
        orgId,
        reportId,
        type: report.report_type,
        title: report.title,
        aoiId: report.aoi_id,
        params,
        sections: REPORT_SECTIONS[report.report_type],
        scopeAoiIds: scope,
      }),
    );
    const content = buildReportContent(source);
    content.summary = await summarizeReport(content, { ai: params.ai_summary !== false, client: deps.summaryClient });
    const pdf = await renderReportPdf(content, { rasterPng: await loadRasterPng(orgId, content) });
    const key = orgKey(orgId, "reports", reportId, "report.pdf");
    const { size } = await storage().put(key, pdf, "application/pdf");
    await withTenant({ orgId }, async (tx) => {
      await tx`
        update reports set status = 'ready', content = ${jsonb(content)}::jsonb, summary_method = ${content.summary!.method},
                           pdf_storage_key = ${key}, pdf_size_bytes = ${size}, completed_at = now(), error = null
         where id = ${reportId} and org_id = ${orgId}`;
      await recordAudit(tx, {
        orgId,
        actor: { type: "system", label: "report.generate" },
        action: "report.generate",
        targetType: "report",
        targetId: reportId,
        metadata: { size_bytes: size, summary_method: content.summary!.method, evidence_items: Object.keys(content.evidence).length },
      });
    });
    return { status: "ready", reportId, sizeBytes: size, summaryMethod: content.summary.method };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await withTenant({ orgId }, (tx) => tx`update reports set status = 'failed', error = ${message} where id = ${reportId} and org_id = ${orgId}`).catch(() => {});
    throw err;
  }
}

export const reportGenerateHandler: JobHandler = {
  type: JOB.reportGenerate,
  describe: "Generate a report",
  async run(ctx) {
    const orgId = requireOrg(ctx);
    const { reportId } = parsePayload(reportGeneratePayload, ctx);
    return generateReport(orgId, reportId);
  },
};

export const REPORT_HANDLERS: JobHandler[] = [reportGenerateHandler];
