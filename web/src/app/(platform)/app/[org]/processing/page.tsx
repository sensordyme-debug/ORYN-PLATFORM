import { JobControl } from "@/components/platform/job-controls";
import { Badge, EmptyState, Notice, PageHeader, Panel, Stat, Table, td, th } from "@/components/platform/ui";
import { formatDateTime, relativeTime, titleCase } from "@/lib/format";
import { getOrgPageAccess } from "@/server/authz/next";
import { jobCounts, listJobs, listRuns } from "@/server/jobs/views";

export const metadata = { title: "Processing" };

const STATUS_TONE = { queued: "neutral", running: "info", succeeded: "good", failed: "alert", dead: "alert", cancelled: "muted" } as const;
const RUN_TONE: Record<string, "good" | "alert" | "watch" | "info" | "muted"> = { succeeded: "good", failed: "alert", insufficient_data: "watch", running: "info", skipped: "muted" };

const JOB_LABEL: Record<string, string> = {
  "aoi.catalog_sync": "Imagery catalog search",
  "provider.catalog_sync": "Provider catalog poll",
  "aoi.process_asset": "Analyze imagery",
  "aoi.change_detection": "Change detection",
  "aoi.context_sync": "Weather, warnings & news refresh",
  "reference.import": "Reference layer import",
  "alerts.evaluate": "Evaluate alert rules",
  "alerts.deliver": "Deliver notifications",
  "report.generate": "Generate report",
  "export.generate": "Generate export",
  "retention.purge": "Apply retention policy",
};

export default async function ProcessingPage(props: PageProps<"/app/[org]/processing">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  if (!access.can("jobs.read")) return <Notice tone="warn">Processing details are available to analysts, administrators, and auditors.</Notice>;
  const [counts, active, problems, recent, runs] = await Promise.all([
    jobCounts(access),
    listJobs(access, { status: "active", limit: 50 }),
    listJobs(access, { status: "problem", limit: 50 }),
    listJobs(access, { limit: 30 }),
    listRuns(access, { limit: 40 }),
  ]);
  const tz = access.org.settings.timezone ?? "UTC";
  const manage = access.can("jobs.manage");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Processing"
        description="Background work for this organization: imagery searches, analyses, change detection, alert evaluation, reports, and exports. Failed work is retried with backoff and never marked successful; work that exhausts its retries stays here until someone retries or dismisses it."
      />
      <div className="grid grid-cols-2 gap-4 rounded-[4px] border border-bone-50/[0.09] bg-ink-850 p-4 sm:grid-cols-6">
        {(["queued", "running", "succeeded", "failed", "dead", "cancelled"] as const).map((s) => (
          <Stat key={s} label={s === "dead" ? "Retries exhausted" : titleCase(s)} value={counts[s]} detail="last 30 days" />
        ))}
      </div>
      {problems.length ? (
        <Panel title="Needs attention" description="Jobs that failed permanently or exhausted their retries." bodyClassName="p-0">
          <Table>
            <thead><tr><th className={th}>Job</th><th className={th}>Status</th><th className={th}>Attempts</th><th className={th}>Last error</th><th className={th}>Finished</th><th className={th} /></tr></thead>
            <tbody>
              {problems.map((j) => (
                <tr key={j.id}>
                  <td className={td}>{JOB_LABEL[j.type] ?? j.type}<code className="block text-[0.6875rem] text-bone-50/40">{j.id.slice(0, 8)}</code></td>
                  <td className={td}><Badge tone={STATUS_TONE[j.status]}>{j.status === "dead" ? "retries exhausted" : j.status}</Badge></td>
                  <td className={td}>{j.attempts}/{j.max_attempts}</td>
                  <td className={`${td} max-w-md text-data-alert/90`}>{j.last_error}</td>
                  <td className={td}>{formatDateTime(j.finished_at, tz)}</td>
                  <td className={td}>{manage ? <JobControl slug={org} jobId={j.id} action="retry" /> : null}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}
      <Panel title="In progress" bodyClassName="p-0">
        {active.length === 0 ? (
          <EmptyState title="Nothing queued or running" className="m-4" />
        ) : (
          <Table>
            <thead><tr><th className={th}>Job</th><th className={th}>Status</th><th className={th}>Progress</th><th className={th}>Attempt</th><th className={th}>Queued</th><th className={th} /></tr></thead>
            <tbody>
              {active.map((j) => (
                <tr key={j.id}>
                  <td className={td}>{JOB_LABEL[j.type] ?? j.type}</td>
                  <td className={td}><Badge tone={STATUS_TONE[j.status]}>{j.status}</Badge>{j.status === "queued" && j.attempts > 0 ? <span className="ml-2 text-[0.75rem] text-data-amber">retry {relativeTime(j.run_after)}</span> : null}</td>
                  <td className={td}><code className="text-[0.6875rem] text-bone-50/60">{Object.keys(j.progress ?? {}).length ? JSON.stringify(j.progress) : "—"}</code></td>
                  <td className={td}>{j.attempts}/{j.max_attempts}{j.last_error ? <span className="block text-[0.6875rem] text-data-amber">{j.last_error}</span> : null}</td>
                  <td className={td}>{relativeTime(j.created_at)}</td>
                  <td className={td}>{manage ? <JobControl slug={org} jobId={j.id} action="cancel" /> : null}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel title="Analysis runs" description="Every execution of an analytic, with the exact model version, inputs, and outcome." bodyClassName="p-0">
        {runs.length === 0 ? (
          <EmptyState title="No analyses yet" className="m-4">Runs appear when imagery is found for one of your areas.</EmptyState>
        ) : (
          <Table>
            <thead><tr><th className={th}>Area</th><th className={th}>Model</th><th className={th}>Outcome</th><th className={th}>Notes</th><th className={th}>Started</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className={td}>{r.aoi_name}</td>
                  <td className={td}><code className="text-[0.75rem]">{r.model_id}@{r.model_version}</code></td>
                  <td className={td}><Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status.replace("_", " ")}</Badge></td>
                  <td className={`${td} max-w-lg text-bone-50/65`}>{r.error ?? r.messages.join(" ") ?? "—"}</td>
                  <td className={td}>{formatDateTime(r.started_at, tz)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel title="Recent jobs" bodyClassName="p-0">
        <Table>
          <thead><tr><th className={th}>Job</th><th className={th}>Status</th><th className={th}>Created</th><th className={th}>Finished</th></tr></thead>
          <tbody>
            {recent.map((j) => (
              <tr key={j.id}>
                <td className={td}>{JOB_LABEL[j.type] ?? j.type}</td>
                <td className={td}><Badge tone={STATUS_TONE[j.status]}>{j.status}</Badge></td>
                <td className={td}>{formatDateTime(j.created_at, tz)}</td>
                <td className={td}>{formatDateTime(j.finished_at, tz)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}
