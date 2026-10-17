import { ApiKeyForm, RevokeApiKeyButton } from "@/components/platform/settings-forms";
import { Badge, EmptyState, Panel, Table, td, th } from "@/components/platform/ui";
import { formatDate, relativeTime } from "@/lib/format";
import { getOrgPageAccess } from "@/server/authz/next";
import { listApiKeys } from "@/server/orgs/service";

export default async function ApiKeysPage(props: PageProps<"/app/[org]/settings/api-keys">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  if (!access.can("apikeys.manage")) return <p className="text-bone-50/60">Only organization administrators can manage API keys.</p>;
  const keys = await listApiKeys(access);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Panel title="API keys" description="Keys act for this organization only, limited to their scopes. Every use is attributed in the audit trail." bodyClassName="p-0">
        {keys.length === 0 ? (
          <EmptyState title="No API keys" className="m-4">Create a key to read areas, results, and alerts from another system.</EmptyState>
        ) : (
          <Table>
            <thead><tr><th className={th}>Name</th><th className={th}>Scopes</th><th className={th}>Last used</th><th className={th}>Expires</th><th className={th} /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "opacity-50" : undefined}>
                  <td className={td}><span className="font-medium">{k.name}</span><code className="block text-[0.6875rem] text-bone-50/45">oryn_{k.prefix}_…</code></td>
                  <td className={td}><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} tone="muted">{s}</Badge>)}</div></td>
                  <td className={td}>{k.lastUsedAt ? relativeTime(k.lastUsedAt) : "Never"}</td>
                  <td className={td}>{k.revokedAt ? <Badge tone="alert">Revoked</Badge> : k.expiresAt ? formatDate(k.expiresAt) : "Never"}</td>
                  <td className={td}>{k.revokedAt ? null : <RevokeApiKeyButton slug={org} id={k.id} />}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel title="Create a key"><ApiKeyForm slug={org} /></Panel>
    </div>
  );
}
