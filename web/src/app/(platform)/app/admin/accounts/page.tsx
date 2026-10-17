import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountActions, CreateAccountForm, type OrgOption } from "@/components/platform/account-admin";
import { Badge, PageHeader, Panel, Table, td, th } from "@/components/platform/ui";
import { ROLE_LABEL } from "@/lib/authz";
import { formatDateTime } from "@/lib/format";
import { listAccountEvents, listAccounts, type AccountOperator } from "@/server/accounts/service";
import { requirePlatformAdmin } from "@/server/auth/session";
import { listAllOrganizations } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Accounts — ORYN platform administration", robots: { index: false } };

export default async function AccountsAdminPage() {
  const user = await requirePlatformAdmin("/app/admin/accounts");
  if (!user) notFound();
  const op: AccountOperator = { type: "platform_admin", userId: user.id, label: user.label, isPlatformAdmin: true, mustChangePassword: false };
  const [accounts, orgRows, events] = await Promise.all([listAccounts(op), listAllOrganizations(user), listAccountEvents(op, 30)]);
  const orgs: OrgOption[] = orgRows.map((o) => ({ slug: o.slug, name: o.name, isTrial: o.is_trial }));
  return (
    <main id="main" className="min-h-[100svh] bg-ink-900 text-bone-50">
      <div className="mx-auto max-w-7xl px-4 py-10">
        <Link href="/app/admin" className="text-[0.8125rem] text-bone-50/55 hover:text-bone-50">← Platform administration</Link>
        <PageHeader
          className="mt-4"
          eyebrow="Platform administration"
          title="Accounts"
          description="Partner accounts are issued here or with `npm run oryn:accounts`; there is no public sign-up. Every change is recorded in the platform audit trail and in the trail of each organization the account belongs to. Passwords are never displayed again after issue."
        />
        <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
          <Panel title={`${accounts.length} accounts`} bodyClassName="p-0">
            <Table>
              <thead>
                <tr>
                  <th className={th}>Account</th>
                  <th className={th}>Status</th>
                  <th className={th}>Organizations</th>
                  <th className={th}>Sessions</th>
                  <th className={th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className={td}>
                      <span className="font-medium">{a.displayUsername ?? a.email}</span>
                      <span className="block text-[0.75rem] text-bone-50/45">{[a.name, a.displayUsername ? a.email : null].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        {a.disabledAt ? <Badge tone="alert" title={a.disabledReason ?? undefined}>Disabled</Badge> : <Badge tone="good">Active</Badge>}
                        {a.mustChangePassword ? <Badge tone="watch">Must change password</Badge> : null}
                        {a.trialOnly ? <Badge tone="info">Trial only</Badge> : null}
                        {a.isPlatformAdmin ? <Badge tone="signal">Platform admin</Badge> : null}
                      </span>
                    </td>
                    <td className={td}>
                      {a.memberships.length === 0 ? <span className="text-bone-50/45">None</span> : (
                        <ul className="text-[0.75rem]">
                          {a.memberships.map((m) => (
                            <li key={m.slug}>{m.name}{m.isTrial ? " (trial)" : ""} — {ROLE_LABEL[m.role]}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={td}>
                      {a.activeSessions}
                      {a.lastSessionAt ? <span className="block text-[0.6875rem] text-bone-50/45">last {formatDateTime(a.lastSessionAt)}</span> : null}
                    </td>
                    <td className={td}>
                      <AccountActions
                        orgs={orgs}
                        account={{
                          id: a.id,
                          handle: a.displayUsername ?? a.email ?? a.name,
                          trialOnly: a.trialOnly,
                          disabled: Boolean(a.disabledAt),
                          isSelf: a.id === user.id,
                          memberships: a.memberships.map((m) => ({ slug: m.slug, name: m.name, role: m.role })),
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
          <div className="flex flex-col gap-6">
            <Panel title="New partner account">
              <CreateAccountForm orgs={orgs} />
            </Panel>
            <Panel title="Recent account activity" bodyClassName="p-0">
              <ul className="divide-y divide-bone-50/[0.05] text-[0.75rem]">
                {events.map((e) => (
                  <li key={e.id} className="px-4 py-2">
                    <span className="t-mono text-bone-50/80">{e.action}</span> {String(e.metadata.account ?? "")}
                    <span className="block text-bone-50/45">{e.actor_label ?? "—"} · {formatDateTime(e.created_at)}</span>
                  </li>
                ))}
                {events.length === 0 ? <li className="px-4 py-3 text-bone-50/45">No account changes recorded yet.</li> : null}
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </main>
  );
}
