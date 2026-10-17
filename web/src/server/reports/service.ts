/**
 * Report requests and retrieval.
 *
 * Guarantees
 *  - createReport requires reports.generate (and audit.read for audit
 *    reports); it inserts a queued row, enqueues JOB.reportGenerate, and
 *    writes an audit row — all in one transaction.
 *  - AOI-scoped reports require an AOI in the org that the caller can see;
 *    org-wide reports by aoi_restricted members are limited to their AOIs.
 *  - Reports are only readable within their org and AOI scope (404 otherwise).
 */
import { z } from "zod";
import type { OrgAccess } from "@/server/authz/access";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import { jsonb, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { storage } from "@/server/storage";
import { visibleAoiIds } from "@/server/alerts/scope";
import { AOI_REQUIRED, REPORT_TYPE_LABEL, REPORT_TYPES, type ReportContent, type ReportType } from "@/server/reports/types";

const dateParam = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const reportParamsSchema = z
  .strictObject({
    from: dateParam.optional(),
    to: dateParam.optional(),
    /** Set false to skip the optional AI narrative. */
    ai_summary: z.boolean().optional(),
  })
  .refine((p) => !p.from || !p.to || Date.parse(p.from) < Date.parse(p.to), { message: "from must be before to", path: ["from"] })
  .refine((p) => !p.from || !p.to || Date.parse(p.to) - Date.parse(p.from) <= 2 * 366 * 86_400_000, { message: "The period may span at most two years.", path: ["to"] });

const createSchema = z.object({
  type: z.enum(REPORT_TYPES),
  aoiId: uuidSchema.nullish(),
  params: reportParamsSchema.default({}),
});

export type CreateReportInput = { type: ReportType; aoiId?: string | null; params?: z.input<typeof reportParamsSchema> };

export type ReportRecord = {
  id: string;
  type: ReportType;
  title: string;
  aoiId: string | null;
  status: "queued" | "generating" | "ready" | "failed";
  params: Record<string, unknown>;
  summaryMethod: string | null;
  pdfSizeBytes: number | null;
  error: string | null;
  jobId: string | null;
  createdBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

type ReportRow = {
  id: string;
  report_type: ReportType;
  title: string;
  aoi_id: string | null;
  status: ReportRecord["status"];
  params: Record<string, unknown>;
  summary_method: string | null;
  pdf_size_bytes: string | number | null;
  pdf_storage_key: string | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
};

function toRecord(r: ReportRow): ReportRecord {
  return {
    id: r.id,
    type: r.report_type,
    title: r.title,
    aoiId: r.aoi_id,
    status: r.status,
    params: r.params,
    summaryMethod: r.summary_method,
    pdfSizeBytes: r.pdf_size_bytes == null ? null : Number(r.pdf_size_bytes),
    error: r.error,
    jobId: r.job_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

function invalid(err: z.ZodError): DomainError {
  const fields: Record<string, string> = {};
  for (const i of err.issues) fields[i.path.join(".") || "input"] = i.message;
  return new DomainError("invalid_report", "The report request is invalid.", 422, fields);
}

export async function createReport(access: OrgAccess, input: CreateReportInput): Promise<{ id: string; jobId: string; status: "queued" }> {
  access.assert("reports.generate");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const { type, params } = parsed.data;
  const aoiId = parsed.data.aoiId ?? null;
  if (type === "audit") access.assert("audit.read");
  if (AOI_REQUIRED[type] && !aoiId) {
    throw new DomainError("aoi_required", `A ${REPORT_TYPE_LABEL[type].toLowerCase()} needs an area of interest.`, 422, { aoiId: "Select an area." });
  }

  return access.tx(async (tx) => {
    const visible = await visibleAoiIds(tx, access);
    let subject = access.org.name;
    if (aoiId && type !== "audit") {
      const [aoi] = await tx<{ id: string; name: string }[]>`select id, name from aois where id = ${aoiId} and org_id = ${access.org.id}`;
      if (!aoi || (visible && !visible.includes(aoi.id))) throw new DomainError("invalid_aoi", "Area of interest not found.", 422, { aoiId: "Unknown area." });
      subject = aoi.name;
    }
    const stored = { ...params, scope_aoi_ids: aoiId ? null : visible };
    const title = `${REPORT_TYPE_LABEL[type]} — ${subject}`;
    const createdBy = access.principal.type === "user" ? access.principal.userId : null;
    const [row] = await tx<{ id: string }[]>`
      insert into reports (org_id, aoi_id, report_type, title, status, params, created_by)
      values (${access.org.id}, ${type === "audit" ? null : aoiId}, ${type}, ${title}, 'queued', ${jsonb(stored)}::jsonb, ${createdBy})
      returning id`;
    const id = row!.id;
    const job = await enqueueTx(tx, {
      orgId: access.org.id,
      type: JOB.reportGenerate,
      payload: { reportId: id },
      // A person is waiting: run ahead of background imagery processing (lower runs first).
      priority: 30,
      idempotencyKey: `report.generate:${id}`,
      createdBy,
      timeoutSeconds: 600,
    });
    await tx`update reports set job_id = ${job.id} where id = ${id} and org_id = ${access.org.id}`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "report.create",
      targetType: "report",
      targetId: id,
      metadata: { type, aoi_id: aoiId, params },
      ip: access.meta.ip,
      userAgent: access.meta.userAgent,
    });
    return { id, jobId: job.id, status: "queued" as const };
  });
}

async function findReport(tx: Tx, access: OrgAccess, reportId: string): Promise<ReportRow> {
  if (!uuidSchema.safeParse(reportId).success) throw notFoundError("Report");
  const [row] = await tx<ReportRow[]>`
    select id, report_type, title, aoi_id, status, params, summary_method, pdf_size_bytes, pdf_storage_key, error, job_id,
           created_by, created_at, completed_at
      from reports where id = ${reportId} and org_id = ${access.org.id}`;
  if (!row) throw notFoundError("Report");
  if (row.report_type === "audit" && !access.can("audit.read")) throw notFoundError("Report");
  const visible = await visibleAoiIds(tx, access);
  if (visible && (row.aoi_id ? !visible.includes(row.aoi_id) : row.created_by !== (access.principal.type === "user" ? access.principal.userId : null))) {
    throw notFoundError("Report");
  }
  return row;
}

export async function listReports(access: OrgAccess, opts: { limit?: number; aoiId?: string } = {}): Promise<ReportRecord[]> {
  access.assert("reports.read");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.aoiId && !uuidSchema.safeParse(opts.aoiId).success) return [];
  return access.tx(async (tx) => {
    const visible = await visibleAoiIds(tx, access);
    const rows = await tx<ReportRow[]>`
      select id, report_type, title, aoi_id, status, params, summary_method, pdf_size_bytes, pdf_storage_key, error, job_id,
             created_by, created_at, completed_at
        from reports
       where org_id = ${access.org.id}
         ${visible ? tx`and aoi_id = any(${visible}::uuid[])` : tx``}
         ${opts.aoiId ? tx`and aoi_id = ${opts.aoiId}` : tx``}
         ${access.can("audit.read") ? tx`` : tx`and report_type <> 'audit'`}
       order by created_at desc, id desc
       limit ${limit}`;
    return rows.map(toRecord);
  });
}

export async function getReport(access: OrgAccess, reportId: string): Promise<ReportRecord & { content: ReportContent | null }> {
  access.assert("reports.read");
  return access.tx(async (tx) => {
    const row = await findReport(tx, access, reportId);
    const [c] = await tx<{ content: ReportContent | null }[]>`select content from reports where id = ${row.id} and org_id = ${access.org.id}`;
    return { ...toRecord(row), content: c?.content ?? null };
  });
}

/** The stored PDF of a ready report. The storage key comes from the row, never from input. */
export async function openReportPdf(access: OrgAccess, reportId: string): Promise<{ filename: string; contentType: string; body: Buffer }> {
  access.assert("reports.read");
  const row = await access.tx((tx) => findReport(tx, access, reportId));
  if (row.status !== "ready" || !row.pdf_storage_key) throw new DomainError("report_not_ready", "This report is not ready yet.", 409);
  const obj = await storage().get(row.pdf_storage_key);
  if (!obj) throw new DomainError("report_missing", "The report file is no longer available.", 404);
  const safeTitle = row.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "_").slice(0, 80) || "report";
  return { filename: `${safeTitle}.pdf`, contentType: "application/pdf", body: obj.body };
}
