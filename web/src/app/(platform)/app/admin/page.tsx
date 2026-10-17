import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateOrgForm, InviteAdminButton } from "@/components/platform/admin-forms";
import { Badge, LinkButton, PageHeader, Panel, Table, td, th } from "@/components/platform/ui";
import { formatDate } from "@/lib/format";
import { requirePlatformAdmin } from "@/server/auth/session";
import { listAllOrganizations } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Platform administration — ORYN", robots: { index: false } };

export default async function AdminPage() {
  const user = await requirePlatformAdmin("/app/admin");
  if (!user) notFound();
  const orgs = await listAllOrganizations(user);
  return (
    <main id="main" className="min-h-[100svh] bg-ink-900 text-bone-50">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <Link href="/app" className="text-[0.8125rem] text-bone-50/55 hover:text-bone-50">← Organizations</Link>
        <PageHeader
          className="mt-4"
          eyebrow="Platform administration"
          title="Organizations"
          description="Creating an organization and inviting its first administrator are cross-tenant actions; both are recorded in that organization's audit trail. Platform administrators do not gain access to an organization's data unless they are invited as members."
        />
        <div className="mt-4">
          <LinkButton href="/app/admin/accounts">Partner accounts</LinkButton>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
          <Panel title={`${orgs.length} organizations`} bodyClassName="p-0">
            <Table>
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Type</th>
                  <th className={th}>Members</th>
                  <th className={th}>Active AOIs</th>
                  <th className={th}>Created</th>
                  <th className={th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.id}>
                    <td className={td}>
                      <span className="font-medium">{o.name}</span>
                      <span className="block text-[0.75rem] text-bone-50/45">{o.slug}</span>
                      {o.is_trial ? <Badge tone="info" className="mt-1">Trial</Badge> : o.is_synthetic ? <Badge tone="watch" className="mt-1">Synthetic</Badge> : null}
                    </td>
                    <td className={td}>{o.kind.replace("_", " ")}</td>
                    <td className={td}>{o.members}{o.admins === 0 ? <Badge tone="alert" className="ml-2">No admin</Badge> : null}</td>
                    <td className={td}>{o.aois}</td>
                    <td className={td}>{formatDate(o.created_at)}</td>
                    <td className={td}><InviteAdminButton orgId={o.id} orgName={o.name} /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
          <Panel title="New organization">
            <CreateOrgForm />
          </Panel>
        </div>
      </div>
    </main>
  );
}
