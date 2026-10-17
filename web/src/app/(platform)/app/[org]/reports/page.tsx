import Link from "next/link";
import { ExportForm, ReportForm } from "@/components/platform/report-forms";
import { Badge, EmptyState, Notice, PageHeader, Panel, Table, td, th } from "@/components/platform/ui";
import { formatBytes, formatDateTime } from "@/lib/format";
import { listAois } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";
import { env } from "@/server/config/env";
import { integrationEnabled } from "@/server/integrations";
import { listExports } from "@/server/exports/service";
import { listReports } from "@/server/reports/service";

export const metadata = { title: "Reports & exports" };

const TONE = { queued: "neutral", generating: "info", running: "info", ready: "good", failed: "alert", expired: "muted" } as const;

export default async function ReportsPage(props: PageProps<"/app/[org]/reports">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const access = await getOrgPageAccess(org);
  const tz = access.org.settings.timezone ?? "UTC";
  const canExport = access.can("exports.create") && access.org.settings.exportsEnabled !== false;
  const [reports, exports, aois] = await Promise.all([
    listReports(access, { limit: 50 }),
    canExport ? listExports(access, { limit: 50 }) : Promise.resolve([]),
    listAois(access, { limit: 500 }),
  ]);
  const aoiOptions = aois.items.map((a) => ({ id: a.id, name: a.name }));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Outputs" title="Reports & exports" description="Reports are frozen snapshots of stored results with their evidence, sources, licences, and limitations. Exports include licence notes for the data they contain. Both are generated in the background and every download is audited." />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Panel title="Reports" bodyClassName="p-0">
          {reports.length === 0 ? <EmptyState title="No reports yet" className="m-4" /> : (
            <Table>
              <thead><tr><th className={th}>Report</th><th className={th}>Status</th><th className={th}>Generated</th><th className={th} /></tr></thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td className={td}><Link href={`/app/${org}/reports/${r.id}`} className="font-medium hover:underline">{r.title}</Link><span className="block text-[0.75rem] text-bone-50/45">{r.summaryMethod ?? ""}</span></td>
                    <td className={td}><Badge tone={TONE[r.status]}>{r.status}</Badge>{r.error ? <span className="block text-[0.75rem] text-data-alert">{r.error}</span> : null}</td>
                    <td className={td}>{r.completedAt ? formatDateTime(r.completedAt, tz) : formatDateTime(r.createdAt, tz)}</td>
                    <td className={td}>{r.status === "ready" ? <a className="text-[0.8125rem] underline" href={`/api/v1/orgs/${org}/reports/${r.id}/pdf`}>PDF ({formatBytes(r.pdfSizeBytes)})</a> : null}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        {access.can("reports.generate") ? (
          <Panel title="Generate a report">
            <ReportForm slug={org} orgKind={access.org.kind} aois={aoiOptions} defaultAoi={typeof sp.aoi === "string" ? sp.aoi : undefined} aiAvailable={Boolean(env.anthropicApiKey()) && integrationEnabled("ai-summaries")} canAudit={access.can("audit.read")} />
          </Panel>
        ) : null}
      </div>
      {canExport ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Panel title="Exports" bodyClassName="p-0">
            {exports.length === 0 ? <EmptyState title="No exports yet" className="m-4" /> : (
              <Table>
                <thead><tr><th className={th}>File</th><th className={th}>Status</th><th className={th}>Licence notes</th><th className={th}>Expires</th><th className={th} /></tr></thead>
                <tbody>
                  {exports.map((e) => (
                    <tr key={e.id}>
                      <td className={td}>{e.filename ?? `${e.subject}.${e.type}`}<span className="block text-[0.75rem] text-bone-50/45">{formatBytes(e.sizeBytes)} · downloaded {e.downloadCount}×</span></td>
                      <td className={td}><Badge tone={TONE[e.status]}>{e.status}</Badge>{e.error ? <span className="block text-[0.75rem] text-data-alert">{e.error}</span> : null}</td>
                      <td className={`${td} max-w-sm text-[0.75rem] text-bone-50/60`}>{e.licenseNotes.join(" ") || "—"}</td>
                      <td className={td}>{e.expiresAt ? formatDateTime(e.expiresAt, tz) : "—"}</td>
                      <td className={td}>{e.status === "ready" ? <a className="text-[0.8125rem] underline" href={`/api/v1/orgs/${org}/exports/${e.id}/download`}>Download</a> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
          <Panel title="Create an export"><ExportForm slug={org} aois={aoiOptions} /></Panel>
        </div>
      ) : (
        <Notice>{access.org.settings.exportsEnabled === false ? "Exports are disabled for this organization." : "Your role cannot create or download exports."}</Notice>
      )}
    </div>
  );
}
