import Link from "next/link";
import { Badge, KeyValues, LinkButton, Notice, PageHeader, Panel } from "@/components/platform/ui";
import { formatDateTime } from "@/lib/format";
import { getOrgPageAccess } from "@/server/authz/next";
import { getReport } from "@/server/reports/service";

export const metadata = { title: "Report" };

const STATUS_TONE = { ok: "good", missing: "alert", stale: "watch", partial: "watch" } as const;

export default async function ReportPage(props: PageProps<"/app/[org]/reports/[id]">) {
  const { org, id } = await props.params;
  const access = await getOrgPageAccess(org);
  const r = await getReport(access, id);
  const tz = access.org.settings.timezone ?? "UTC";
  const c = r.content;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={`/app/${org}/reports`} className="hover:underline">Reports</Link>}
        title={r.title}
        actions={r.status === "ready" ? <LinkButton variant="primary" href={`/api/v1/orgs/${org}/reports/${id}/pdf`} prefetch={false}>Download PDF</LinkButton> : null}
      />
      {r.status !== "ready" ? <Notice tone={r.status === "failed" ? "error" : "info"}>{r.status === "failed" ? `Generation failed: ${r.error}` : "This report is still being generated."}</Notice> : null}
      {c ? (
        <>
          {c.org.is_synthetic || c.aoi?.is_synthetic ? <Notice tone="warn">Synthetic development data: boundaries in this report are sample placeholders.</Notice> : null}
          <Panel title="Data currency">
            <div className="flex items-start gap-3"><Badge tone={STATUS_TONE[c.data_currency.status]}>{c.data_currency.status}</Badge><p className="text-[0.875rem]">{c.data_currency.statement}</p></div>
          </Panel>
          {c.summary ? (
            <Panel title="Summary" description={`Method: ${c.summary.method}`}>
              <p className="whitespace-pre-wrap text-[0.875rem] leading-relaxed">{c.summary.text}</p>
            </Panel>
          ) : null}
          {c.comparison ? (
            <Panel title="Season comparison" description={`${c.comparison.sensor} · ${c.comparison.method.model_id}@${c.comparison.method.model_version}`}>
              <div className="flex flex-col gap-3 text-[0.8125rem]">
                <div className="flex items-start gap-3">
                  <Badge tone={c.comparison.outcome === "changes_found" ? "watch" : c.comparison.compared ? "good" : "alert"}>{c.comparison.outcome_label}</Badge>
                  <p>{c.comparison.outcome_detail}</p>
                </div>
                <KeyValues
                  items={[
                    ["Baseline period", `${c.comparison.periods.baseline.from} – ${c.comparison.periods.baseline.to}`],
                    ["Comparison period", `${c.comparison.periods.comparison.from} – ${c.comparison.periods.comparison.to}`],
                    ...([c.comparison.images.baseline, c.comparison.images.comparison].filter(Boolean).map((i) => [
                      i!.role === "baseline" ? "Baseline image" : "Comparison image",
                      `${i!.external_id} · ${formatDateTime(i!.acquired_at, tz)} · ${i!.clear_fraction === null ? "—" : Math.round(i!.clear_fraction * 100)}% clear`,
                    ]) as [string, string][]),
                    ["Thresholds", `NDVI change ≥ ${c.comparison.method.threshold} over ≥ ${c.comparison.method.min_area_m2.toLocaleString("en-US")} m²`],
                  ]}
                />
                {c.comparison.findings.length ? (
                  <ul className="flex flex-col gap-1">
                    {c.comparison.findings.map((f, i) => (
                      <li key={f.detection_id}>
                        <span className="t-mono mr-2 text-[0.6875rem] text-bone-50/40">{i + 1}</span>
                        <Link className="hover:underline" href={`/app/${org}/map?detection=${f.detection_id}`}>{f.title}</Link>
                        <span className="ml-2 text-[0.75rem] text-bone-50/50">evidence {f.evidence_grade} · {f.verification_status.replace(/_/g, " ")} [{f.evidence_id}]</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Panel>
          ) : null}
          <Panel title="Findings" description="Every finding cites the stored records it comes from.">
            <ul className="flex flex-col gap-2 text-[0.8125rem]">
              {c.findings.map((f) => (
                <li key={f.id}><span className="t-mono mr-2 text-[0.6875rem] text-bone-50/40">{f.id}</span>{f.text} <span className="text-[0.6875rem] text-bone-50/40">[{f.evidence_ids.join(", ")}]</span></li>
              ))}
            </ul>
          </Panel>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Report">
              <KeyValues
                items={[
                  ["Generated", formatDateTime(c.report.generated_at, tz)],
                  ["Period", `${formatDateTime(c.report.period.from, tz)} – ${formatDateTime(c.report.period.to, tz)}`],
                  ["Area", c.aoi ? `${c.aoi.name} · ${c.aoi.area_text}` : "Organization-wide"],
                  ["Boundary source", c.aoi ? String(c.aoi.boundary_source.method ?? "—") : "—"],
                  ...([
                    ["Observations", c.observations?.statement.text],
                    ["Detections", c.detections?.statement.text],
                    ["Weather", c.weather?.statement.text],
                    ["Warnings", c.warnings?.statement.text],
                    ["News", c.news?.statement.text],
                    ["Alerts", c.alerts?.statement.text],
                  ].filter(([, v]) => v) as [string, string][]),
                ]}
              />
            </Panel>
            <Panel title="Sources & limitations">
              <ul className="list-disc pl-4 text-[0.75rem] text-bone-50/70">
                {c.sources.attributions.map((a) => <li key={a}>{a}</li>)}
              </ul>
              <ul className="mt-3 list-disc pl-4 text-[0.75rem] text-bone-50/60">
                {c.limitations.general.map((l) => <li key={l.id}>{l.text}</li>)}
                {c.limitations.models.flatMap((m) => m.limitations.slice(0, 3).map((l) => <li key={`${m.model_id}-${l.id}`}>{m.name}: {l.text}</li>))}
              </ul>
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}
