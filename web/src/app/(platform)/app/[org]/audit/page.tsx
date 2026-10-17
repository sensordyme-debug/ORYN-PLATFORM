import Link from "next/link";
import { EmptyState, Notice, PageHeader, Panel, Table, td, th, Badge } from "@/components/platform/ui";
import { formatDateTime } from "@/lib/format";
import { listAuditEvents } from "@/server/audit";
import { getOrgPageAccess } from "@/server/authz/next";

export const metadata = { title: "Audit trail" };

export default async function AuditPage(props: PageProps<"/app/[org]/audit">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const access = await getOrgPageAccess(org);
  if (!access.can("audit.read")) return <Notice tone="warn">The audit trail is available to administrators and auditors.</Notice>;
  const before = typeof sp.before === "string" ? Number(sp.before) : undefined;
  const action = typeof sp.action === "string" ? sp.action : undefined;
  const target = typeof sp.target === "string" ? sp.target : undefined;
  const events = await listAuditEvents(access, { before: Number.isFinite(before) ? before : undefined, action, targetId: target, limit: 100 });
  const tz = access.org.settings.timezone ?? "UTC";
  const last = events.at(-1);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Governance"
        title="Audit trail"
        description="Append-only record of sign-ins, data changes, exports, downloads, and administrative actions. Entries cannot be edited or deleted by the application; retention purges keep at least 90 days."
      />
      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="text-[0.8125rem] text-bone-50/70">
          Action starts with
          <input name="action" defaultValue={action} placeholder="aoi., export., member." className="ml-2 rounded-[3px] border border-bone-50/15 bg-ink-950 px-2 py-1 text-[0.8125rem]" />
        </label>
        <button className="rounded-[3px] border border-bone-50/20 px-3 py-1 text-[0.8125rem]">Filter</button>
        {action || target ? <Link href={`/app/${org}/audit`} className="text-[0.8125rem] text-bone-50/55 underline">Clear</Link> : null}
      </form>
      <Panel bodyClassName="p-0">
        {events.length === 0 ? (
          <EmptyState title="No audit events" className="m-4" />
        ) : (
          <Table>
            <thead>
              <tr><th className={th}>Time ({tz})</th><th className={th}>Actor</th><th className={th}>Action</th><th className={th}>Target</th><th className={th}>Details</th></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className={`${td} whitespace-nowrap`}>{formatDateTime(e.createdAt, tz)}</td>
                  <td className={td}>
                    <Badge tone={e.actorType === "system" ? "muted" : e.actorType === "api_key" ? "info" : "neutral"}>{e.actorType.replace("_", " ")}</Badge>
                    <span className="ml-2">{e.actorName ?? e.actorLabel ?? "—"}</span>
                  </td>
                  <td className={`${td} t-mono`}>{e.action}</td>
                  <td className={td}>{e.targetType ? <span className="text-bone-50/60">{e.targetType} <code className="text-[0.6875rem]">{e.targetId?.slice(0, 8)}</code></span> : "—"}</td>
                  <td className={`${td} max-w-[28rem]`}>
                    <code className="block truncate text-[0.6875rem] text-bone-50/55" title={JSON.stringify(e.metadata)}>{JSON.stringify(e.metadata)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {last && events.length === 100 ? (
        <Link className="self-start text-[0.8125rem] underline" href={`/app/${org}/audit?before=${last.id}${action ? `&action=${encodeURIComponent(action)}` : ""}`}>Older entries →</Link>
      ) : null}
    </div>
  );
}
