import Link from "next/link";
import { MarkAllRead } from "@/components/platform/alert-controls";
import { Badge, EmptyState, LinkButton, PageHeader, Panel, SEVERITY_TONE, Table, td, th } from "@/components/platform/ui";
import { formatDateTime, relativeTime } from "@/lib/format";
import { listAlerts } from "@/server/alerts/service";
import { getSessionUser } from "@/server/auth/session";
import { getOrgPageAccess } from "@/server/authz/next";
import { listNotifications } from "@/server/notifications/service";

export const metadata = { title: "Alerts" };

const STATUSES = ["open", "acknowledged", "resolved", "suppressed"] as const;
const BASIS_LABEL: Record<string, string> = {
  observation: "Observed data",
  model_estimate: "Model estimate",
  forecast: "Forecast",
  official_warning: "Official warning",
  candidate_change: "Candidate change",
};

export default async function AlertsPage(props: PageProps<"/app/[org]/alerts">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const access = await getOrgPageAccess(org);
  const tz = access.org.settings.timezone ?? "UTC";
  const view = sp.view === "notifications" ? "notifications" : "alerts";
  const status = STATUSES.includes(sp.status as never) ? (sp.status as (typeof STATUSES)[number]) : null;

  if (view === "notifications") {
    const user = (await getSessionUser())!;
    const items = await listNotifications(user.id, access.org.id, false, { limit: 100 });
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Alerts" title="Your notifications" actions={<><LinkButton href={`/app/${org}/alerts`} size="sm" variant="ghost">All alerts</LinkButton><MarkAllRead slug={org} /></>} />
        <Panel bodyClassName="p-0">
          {items.length === 0 ? <EmptyState title="No notifications" className="m-4">You are notified about alerts for rules that target your role and areas you can see.</EmptyState> : (
            <ul>
              {items.map((n) => (
                <li key={n.id} className="flex items-start justify-between gap-3 border-b border-bone-50/[0.05] px-4 py-2.5 text-[0.8125rem]">
                  <span>
                    {!n.readAt ? <span aria-label="unread" className="mr-2 inline-block size-1.5 rounded-full bg-signal align-middle" /> : null}
                    <Link className="hover:underline" href={`/app/${org}/alerts/${n.alertId}`}>{n.title}</Link>
                    <span className="block text-[0.75rem] text-bone-50/45">{n.aoiName} · {n.reason === "escalated" ? "escalated · " : ""}{relativeTime(n.createdAt)}</span>
                  </span>
                  <Badge tone={SEVERITY_TONE[n.severity] ?? "neutral"}>{n.severity}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    );
  }

  const { items, nextCursor } = await listAlerts(access, { status: status ? [status] : ["open", "acknowledged"], limit: 100, cursor: typeof sp.cursor === "string" ? sp.cursor : null });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Monitoring"
        title="Alerts"
        description="Alerts come only from configured rules evaluated against stored data. Each shows when the underlying data was acquired, when ORYN processed it, and when the alert was raised."
        actions={
          <>
            <LinkButton href={`/app/${org}/alerts?view=notifications`} size="sm" variant="ghost">My notifications</LinkButton>
            <LinkButton href={`/app/${org}/alerts/rules`} size="sm">Alert rules</LinkButton>
          </>
        }
      />
      <nav aria-label="Alert status" className="flex gap-1 text-[0.8125rem]">
        {[["Active", null], ...STATUSES.map((s) => [s[0]!.toUpperCase() + s.slice(1), s])].map(([label, s]) => (
          <Link key={label} href={`/app/${org}/alerts${s ? `?status=${s}` : ""}`} aria-current={status === s ? "page" : undefined} className={`rounded-[3px] px-2.5 py-1 ${status === s ? "bg-bone-50/[0.08] text-bone-50" : "text-bone-50/55 hover:text-bone-50"}`}>
            {label}
          </Link>
        ))}
      </nav>
      <Panel bodyClassName="p-0">
        {items.length === 0 ? (
          <EmptyState title="No alerts here" className="m-4" />
        ) : (
          <Table>
            <thead><tr><th className={th}>Alert</th><th className={th}>Severity</th><th className={th}>Basis</th><th className={th}>Data acquired</th><th className={th}>Alert raised</th><th className={th}>Status</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className={td}>
                    <Link href={`/app/${org}/alerts/${a.id}`} className="font-medium hover:underline">{a.title}</Link>
                    <span className="block text-[0.75rem] text-bone-50/45">{a.aoiName} · {a.ruleName ?? "rule deleted"}{a.fromReprocessing ? " · from reprocessing (not new data)" : ""}{a.escalationLevel ? " · escalated" : ""}</span>
                  </td>
                  <td className={td}><Badge tone={SEVERITY_TONE[a.severity] ?? "neutral"}>{a.severity}</Badge></td>
                  <td className={td}>{a.basis ? BASIS_LABEL[a.basis] ?? a.basis : "—"}</td>
                  <td className={`${td} whitespace-nowrap`}>{a.observedAt ? formatDateTime(a.observedAt, tz) : a.eventAt ? `event ${formatDateTime(a.eventAt, tz)}` : "—"}</td>
                  <td className={`${td} whitespace-nowrap`}>{formatDateTime(a.createdAt, tz)}</td>
                  <td className={td}><Badge tone={a.status === "open" ? "alert" : a.status === "acknowledged" ? "watch" : "muted"}>{a.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {nextCursor ? <Link className="self-start text-[0.8125rem] underline" href={`/app/${org}/alerts?${status ? `status=${status}&` : ""}cursor=${encodeURIComponent(nextCursor)}`}>More →</Link> : null}
    </div>
  );
}
