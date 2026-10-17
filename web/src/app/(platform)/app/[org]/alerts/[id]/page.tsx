import Link from "next/link";
import { AlertControls } from "@/components/platform/alert-controls";
import { Badge, KeyValues, LinkButton, Notice, PageHeader, Panel, SEVERITY_TONE } from "@/components/platform/ui";
import { formatDateTime } from "@/lib/format";
import { getAlert } from "@/server/alerts/service";
import { getOrgPageAccess } from "@/server/authz/next";
import { listMembers } from "@/server/orgs/service";

export const metadata = { title: "Alert" };

const BASIS_LABEL: Record<string, string> = {
  observation: "Based on observed data",
  model_estimate: "Based on a model estimate (reanalysis), not direct observation",
  forecast: "Based on a FORECAST — not an observed condition",
  official_warning: "Based on an official warning",
  candidate_change: "Based on an unverified candidate change",
};

export default async function AlertPage(props: PageProps<"/app/[org]/alerts/[id]">) {
  const { org, id } = await props.params;
  const access = await getOrgPageAccess(org);
  const a = await getAlert(access, id);
  const tz = access.org.settings.timezone ?? "UTC";
  const members = access.can("alerts.respond") && access.can("members.read") ? (await listMembers(access)).filter((m) => ["org_admin", "analyst", "field_operator"].includes(m.role)) : [];
  const ex = a.explanation;
  const mapHref = a.detectionId ? `/app/${org}/map?detection=${a.detectionId}` : a.observationId ? `/app/${org}/map?aoi=${a.aoiId}&obs=${a.observationId}` : `/app/${org}/map?aoi=${a.aoiId}`;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={`/app/${org}/alerts`} className="hover:underline">Alerts</Link>}
        title={a.title}
        actions={<LinkButton href={mapHref} variant="primary">Show on map</LinkButton>}
      />
      <div className="flex flex-wrap gap-2">
        <Badge tone={SEVERITY_TONE[a.severity] ?? "neutral"}>{a.severity}</Badge>
        <Badge tone={a.status === "open" ? "alert" : a.status === "acknowledged" ? "watch" : "muted"}>{a.status}</Badge>
        <Badge tone={ex.basis === "forecast" || ex.basis === "candidate_change" ? "watch" : "neutral"}>{BASIS_LABEL[ex.basis] ?? ex.basis}</Badge>
        {a.escalationLevel ? <Badge tone="signal">Escalated</Badge> : null}
      </div>
      {a.fromReprocessing ? <Notice tone="info" title="Raised while reprocessing data ORYN already had">{ex.reprocessing ?? "This does not indicate a new observation."} No notification was sent.</Notice> : null}
      {a.status === "suppressed" ? <Notice tone="info">Suppressed by the rule&apos;s cooldown: a similar alert for this area was raised recently. Kept for the record; not notified.</Notice> : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <Panel title="What happened">
            <div className="flex flex-col gap-3 text-[0.875rem] leading-relaxed">
              <p><span className="text-bone-50/50">What: </span>{ex.what}</p>
              <p><span className="text-bone-50/50">Where: </span>{ex.where}</p>
              <p><span className="text-bone-50/50">Why this rule fired: </span>{ex.why}</p>
              <p><span className="text-bone-50/50">How certain: </span>{ex.certainty}</p>
              <p><span className="text-bone-50/50">Suggested action: </span>{ex.suggested_action}</p>
            </div>
          </Panel>
          <Panel title="Values compared" description={`Rule: ${ex.rule.name} (${ex.rule.type})`}>
            <KeyValues items={[...Object.entries(ex.values).map(([k, v]) => [k.replace(/_/g, " "), String(v ?? "—")] as [string, string]), ...Object.entries(ex.rule.params).map(([k, v]) => [`rule ${k.replace(/_/g, " ")}`, Array.isArray(v) ? v.join(", ") || "any" : String(v)] as [string, string])]} />
          </Panel>
          <Panel title="Evidence" description="The stored records this alert rests on.">
            <ul className="flex flex-col gap-2 text-[0.8125rem]">
              {a.evidence.map((e) => (
                <li key={`${e.type}-${e.id}`} className="rounded-[3px] border border-bone-50/[0.07] px-3 py-2">
                  <span className="t-mono mr-2 text-[0.6875rem] uppercase text-bone-50/45">{e.type.replace(/_/g, " ")}</span>
                  {e.type === "detection" ? <Link className="hover:underline" href={`/app/${org}/map?detection=${e.id}`}>{e.label}</Link> : e.type === "observation" ? <Link className="hover:underline" href={`/app/${org}/map?aoi=${a.aoiId}&obs=${e.id}`}>{e.label}</Link> : e.label}
                  {e.observed_at ? <span className="block text-[0.75rem] text-bone-50/45">acquired/valid {formatDateTime(e.observed_at, tz)}</span> : null}
                  {e.records.length === 0 ? <span className="block text-[0.75rem] text-data-amber">The underlying record is no longer stored (retention).</span> : null}
                </li>
              ))}
            </ul>
          </Panel>
          {ex.limitations.length ? (
            <Panel title="Limitations"><ul className="list-disc pl-4 text-[0.8125rem] text-bone-50/75">{ex.limitations.map((l) => <li key={l}>{l}</li>)}</ul></Panel>
          ) : null}
        </div>
        <div className="flex flex-col gap-6">
          <Panel title="Timeline">
            <KeyValues
              items={[
                ["Real-world event", a.eventAt ? formatDateTime(a.eventAt, tz) : "Unknown"],
                ["Data acquired", a.observedAt ? formatDateTime(a.observedAt, tz) : "—"],
                ["Received by ORYN", a.ingestedAt ? formatDateTime(a.ingestedAt, tz) : "—"],
                ["Processed", a.processedAt ? formatDateTime(a.processedAt, tz) : "—"],
                ["Alert raised", formatDateTime(a.createdAt, tz)],
                ["Notified", a.notifiedAt ? formatDateTime(a.notifiedAt, tz) : "Not notified"],
                ["Acknowledged", a.acknowledgedAt ? `${formatDateTime(a.acknowledgedAt, tz)}` : "—"],
                ["Resolved", a.resolvedAt ? `${formatDateTime(a.resolvedAt, tz)}${a.resolutionNote ? ` — ${a.resolutionNote}` : ""}` : "—"],
              ]}
            />
          </Panel>
          <Panel title="Respond">
            <AlertControls slug={org} alertId={a.id} status={a.status} canRespond={access.can("alerts.respond")} canNote={access.can("notes.write")} members={members.map((m) => ({ id: m.userId, name: m.name }))} assignedTo={a.assignedTo} />
          </Panel>
          <Panel title="History">
            <ul className="flex flex-col gap-2 text-[0.75rem]">
              {a.events.map((e) => (
                <li key={e.id}><span className="text-bone-50/85">{e.action.replace(/_/g, " ")}</span>{e.note ? ` — ${e.note}` : ""}<span className="block text-bone-50/45">{e.actorName ?? "System"} · {formatDateTime(e.createdAt, tz)}</span></li>
              ))}
              {a.notes.map((n) => (
                <li key={n.id}><span className="text-bone-50/85">Note</span> — {n.body}<span className="block text-bone-50/45">{n.authorName ?? "—"} · {formatDateTime(n.createdAt, tz)}</span></li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
