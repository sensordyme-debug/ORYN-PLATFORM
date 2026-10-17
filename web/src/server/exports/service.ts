/**
 * Export requests and downloads.
 *
 * Guarantees
 *  - createExport requires exports.create AND organizations.settings
 *    .exportsEnabled !== false (read fresh from the database). It inserts a
 *    queued row, enqueues JOB.exportGenerate, and audits 'export.create' in
 *    one transaction.
 *  - Exports only ever contain the requesting org's rows: generation runs in
 *    the org's tenant context AND filters by org_id; aoi_restricted members'
 *    exports are limited to their granted AOIs (scope frozen at request).
 *  - Exports of other orgs, other members' restricted scopes, or unknown ids
 *    are indistinguishable (404).
 *  - Downloads require the export to be ready and unexpired, increment
 *    download_count / last_downloaded_at, and audit 'export.download'.
 */
import { z } from "zod";
import { AccessError, type OrgAccess } from "@/server/authz/access";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import { jsonb, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { storage } from "@/server/storage";
import { visibleAoiIds } from "@/server/alerts/scope";

export const EXPORT_TYPES = ["geojson", "csv", "geotiff", "pdf"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];
export const EXPORT_SUBJECTS = ["detections", "aois", "observations", "weather", "observation_raster", "report"] as const;
export type ExportSubject = (typeof EXPORT_SUBJECTS)[number];

/** Which subjects each format can carry. */
export const EXPORT_MATRIX: Record<ExportType, readonly ExportSubject[]> = {
  geojson: ["detections", "aois", "observations"],
  csv: ["detections", "aois", "observations", "weather"],
  geotiff: ["observation_raster"],
  pdf: ["report"],
};

const dateParam = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const exportParamsSchema = z.strictObject({
  aoiId: uuidSchema.optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
  observationId: uuidSchema.optional(),
  reportId: uuidSchema.optional(),
  /** Weather record kinds to include (default: all three, kept in separate rows with record_kind). */
  kinds: z.array(z.enum(["observation", "model_estimate", "forecast"])).min(1).max(3).optional(),
  variables: z.array(z.string().min(1).max(64)).max(20).optional(),
  /** Observations: include unusable ones (default true, with reasons). */
  includeUnusable: z.boolean().optional(),
  /** Detections: include ones reviewers dismissed (default false). */
  includeDismissed: z.boolean().optional(),
});
export type ExportParams = z.infer<typeof exportParamsSchema>;

export type CreateExportInput = { type: ExportType; subject: ExportSubject; params?: ExportParams };

export type ExportRecord = {
  id: string;
  type: ExportType;
  subject: ExportSubject;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  licenseNotes: string[];
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  downloadCount: number;
};

type ExportRow = {
  id: string;
  export_type: ExportType;
  subject: ExportSubject;
  params: Record<string, unknown>;
  status: ExportRecord["status"];
  storage_key: string | null;
  filename: string | null;
  content_type: string | null;
  size_bytes: string | number | null;
  license_notes: string[];
  error: string | null;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  download_count: number;
  expired_now: boolean;
};

function toRecord(r: ExportRow): ExportRecord {
  return {
    id: r.id,
    type: r.export_type,
    subject: r.subject,
    status: r.status,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    licenseNotes: r.license_notes ?? [],
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
    downloadCount: r.download_count,
  };
}

function userId(access: OrgAccess): string | null {
  return access.principal.type === "user" ? access.principal.userId : null;
}

async function assertExportsEnabled(tx: Tx, access: OrgAccess) {
  const [org] = await tx<{ settings: { exportsEnabled?: boolean } | null }[]>`select settings from organizations where id = ${access.org.id}`;
  if (org?.settings?.exportsEnabled === false || access.org.settings.exportsEnabled === false) {
    throw new AccessError(403, "forbidden", "Exports are disabled for this organization.");
  }
}

export async function createExport(
  access: OrgAccess,
  input: CreateExportInput,
): Promise<{ id: string; jobId: string; status: "queued" }> {
  access.assert("exports.create");
  const type = z.enum(EXPORT_TYPES).safeParse(input?.type);
  const subject = z.enum(EXPORT_SUBJECTS).safeParse(input?.subject);
  if (!type.success || !subject.success || !EXPORT_MATRIX[type.data].includes(subject.data)) {
    throw new DomainError("invalid_export", "This export format does not support that subject.", 422, { subject: "Unsupported combination." });
  }
  const parsed = exportParamsSchema.safeParse(input.params ?? {});
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[i.path.join(".") || "params"] = i.message;
    throw new DomainError("invalid_export", "Invalid export parameters.", 422, fields);
  }
  const params = parsed.data;
  if (subject.data === "observation_raster" && !params.observationId) {
    throw new DomainError("invalid_export", "A raster export needs an observation.", 422, { observationId: "Required." });
  }
  if (subject.data === "report" && !params.reportId) throw new DomainError("invalid_export", "A PDF export needs a report.", 422, { reportId: "Required." });

  return access.tx(async (tx) => {
    await assertExportsEnabled(tx, access);
    const visible = await visibleAoiIds(tx, access);
    const notVisible = (aoiId: string | null) => (visible ? !aoiId || !visible.includes(aoiId) : false);
    if (params.aoiId) {
      const [a] = await tx<{ id: string }[]>`select id from aois where id = ${params.aoiId} and org_id = ${access.org.id}`;
      if (!a || notVisible(a.id)) throw new DomainError("invalid_aoi", "Area of interest not found.", 422, { aoiId: "Unknown area." });
    }
    if (params.observationId) {
      const [o] = await tx<{ aoi_id: string; has_raster: boolean }[]>`
        select aoi_id, (raster ? 'data_key') as has_raster from observations where id = ${params.observationId} and org_id = ${access.org.id}`;
      if (!o || notVisible(o.aoi_id)) throw new DomainError("invalid_observation", "Observation not found.", 422, { observationId: "Unknown observation." });
      if (!o.has_raster) throw new DomainError("no_raster", "This observation has no stored raster to export.", 422, { observationId: "No raster." });
    }
    if (params.reportId) {
      const [r] = await tx<{ aoi_id: string | null; status: string; report_type: string }[]>`
        select aoi_id, status, report_type from reports where id = ${params.reportId} and org_id = ${access.org.id}`;
      if (!r || (r.aoi_id && notVisible(r.aoi_id)) || (r.report_type === "audit" && !access.can("audit.read"))) {
        throw new DomainError("invalid_report", "Report not found.", 422, { reportId: "Unknown report." });
      }
      if (r.status !== "ready") throw new DomainError("report_not_ready", "The report is not ready yet.", 409);
    }
    const stored = { ...params, scope_aoi_ids: visible };
    const [row] = await tx<{ id: string }[]>`
      insert into exports (org_id, export_type, subject, params, status, created_by)
      values (${access.org.id}, ${type.data}, ${subject.data}, ${jsonb(stored)}::jsonb, 'queued', ${userId(access)})
      returning id`;
    const id = row!.id;
    const job = await enqueueTx(tx, {
      orgId: access.org.id,
      type: JOB.exportGenerate,
      payload: { exportId: id },
      // A person is waiting: run ahead of background imagery processing (lower runs first).
      priority: 30,
      idempotencyKey: `export.generate:${id}`,
      createdBy: userId(access),
      timeoutSeconds: 600,
    });
    await tx`update exports set job_id = ${job.id} where id = ${id} and org_id = ${access.org.id}`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "export.create",
      targetType: "export",
      targetId: id,
      metadata: { type: type.data, subject: subject.data, params },
      ip: access.meta.ip,
      userAgent: access.meta.userAgent,
    });
    return { id, jobId: job.id, status: "queued" as const };
  });
}

async function findExport(tx: Tx, access: OrgAccess, exportId: string, forUpdate = false): Promise<ExportRow> {
  if (!uuidSchema.safeParse(exportId).success) throw notFoundError("Export");
  const [row] = await tx<ExportRow[]>`
    select id, export_type, subject, params, status, storage_key, filename, content_type, size_bytes, license_notes, error,
           created_by, created_at, completed_at, expires_at, download_count,
           (expires_at is not null and expires_at <= now()) as expired_now
      from exports where id = ${exportId} and org_id = ${access.org.id}
      ${forUpdate ? tx`for update` : tx``}`;
  if (!row) throw notFoundError("Export");
  // Restricted members only reach exports they created themselves (their scope was frozen at creation).
  if (access.aoiRestricted && row.created_by !== userId(access)) throw notFoundError("Export");
  return row;
}

export async function getExport(access: OrgAccess, exportId: string): Promise<ExportRecord> {
  access.assert("exports.create");
  return access.tx(async (tx) => toRecord(await findExport(tx, access, exportId)));
}

export async function listExports(access: OrgAccess, opts: { limit?: number } = {}): Promise<ExportRecord[]> {
  access.assert("exports.create");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return access.tx(async (tx) => {
    const rows = await tx<ExportRow[]>`
      select id, export_type, subject, params, status, storage_key, filename, content_type, size_bytes, license_notes, error,
             created_by, created_at, completed_at, expires_at, download_count,
             (expires_at is not null and expires_at <= now()) as expired_now
        from exports
       where org_id = ${access.org.id} ${access.aoiRestricted ? tx`and created_by = ${userId(access)}` : tx``}
       order by created_at desc, id desc
       limit ${limit}`;
    return rows.map(toRecord);
  });
}

/** Open a ready, unexpired export for download. The storage key comes from the row, never from input. */
export async function openExportDownload(
  access: OrgAccess,
  exportId: string,
): Promise<{ filename: string; contentType: string; body: Buffer; licenseNotes: string[] }> {
  access.assert("exports.create");
  const row = await access.tx(async (tx) => {
    await assertExportsEnabled(tx, access);
    return findExport(tx, access, exportId);
  });
  if (row.status === "expired" || (row.status === "ready" && row.expired_now)) {
    throw new DomainError("export_expired", "This export has expired. Create a new export.", 409);
  }
  if (row.status !== "ready" || !row.storage_key) throw new DomainError("export_not_ready", "This export is not ready yet.", 409);
  const obj = await storage().get(row.storage_key);
  if (!obj) throw new DomainError("export_missing", "The export file is no longer available.", 404);

  await access.tx(async (tx) => {
    const updated = await tx`
      update exports set download_count = download_count + 1, last_downloaded_at = now()
       where id = ${row.id} and org_id = ${access.org.id} and status = 'ready' and (expires_at is null or expires_at > now())
      returning id`;
    if (updated.length !== 1) throw new DomainError("export_expired", "This export has expired. Create a new export.", 409);
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "export.download",
      targetType: "export",
      targetId: row.id,
      metadata: { filename: row.filename, size_bytes: obj.size, type: row.export_type, subject: row.subject },
      ip: access.meta.ip,
      userAgent: access.meta.userAgent,
    });
  });
  return { filename: row.filename ?? `${row.id}`, contentType: row.content_type ?? obj.contentType ?? "application/octet-stream", body: obj.body, licenseNotes: row.license_notes ?? [] };
}
