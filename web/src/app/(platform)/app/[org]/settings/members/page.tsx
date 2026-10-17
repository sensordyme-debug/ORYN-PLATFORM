import { InviteForm, MemberControls, RevokeInvitationButton } from "@/components/platform/settings-forms";
import { Badge, Panel, Table, td, th } from "@/components/platform/ui";
import { ROLE_LABEL } from "@/lib/authz";
import { formatDate } from "@/lib/format";
import { listAois } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";
import { emailConfigured } from "@/server/email";
import { listInvitations, listMembers } from "@/server/orgs/service";

export default async function MembersPage(props: PageProps<"/app/[org]/settings/members">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  if (!access.can("members.read")) return <p className="text-bone-50/60">You do not have access to the member list.</p>;
  const manage = access.can("members.manage");
  const [members, invitations, aois] = await Promise.all([
    listMembers(access),
    manage ? listInvitations(access) : Promise.resolve([]),
    manage ? listAois(access, { limit: 500 }) : Promise.resolve({ items: [], total: 0 }),
  ]);
  const pending = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > new Date());
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        <Panel title={`${members.length} members`} bodyClassName="p-0">
          <Table>
            <thead>
              <tr><th className={th}>Member</th><th className={th}>Role</th><th className={th}>Joined</th></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId}>
                  <td className={td}>
                    <span className="font-medium">{m.name}</span>
                    <span className="block text-[0.75rem] text-bone-50/50">{[m.username, m.email].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td className={td}>
                    {manage ? (
                      <MemberControls
                        slug={org}
                        membershipId={m.membershipId}
                        role={m.role}
                        aoiRestricted={m.aoiRestricted}
                        grantedAoiIds={m.grantedAoiIds}
                        aois={aois.items.map((a) => ({ id: a.id, name: a.name }))}
                        isSelf={m.userId === access.tenant.userId}
                      />
                    ) : (
                      <>
                        {ROLE_LABEL[m.role]}
                        {m.aoiRestricted ? <Badge className="ml-2">Assigned areas only</Badge> : null}
                      </>
                    )}
                  </td>
                  <td className={td}>{formatDate(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
        {manage && pending.length ? (
          <Panel title="Pending invitations" bodyClassName="p-0">
            <Table>
              <thead><tr><th className={th}>Email</th><th className={th}>Role</th><th className={th}>Expires</th><th className={th} /></tr></thead>
              <tbody>
                {pending.map((i) => (
                  <tr key={i.id}>
                    <td className={td}>{i.email}</td>
                    <td className={td}>{ROLE_LABEL[i.role]}</td>
                    <td className={td}>{formatDate(i.expiresAt)}</td>
                    <td className={td}><RevokeInvitationButton slug={org} id={i.id} /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        ) : null}
      </div>
      {manage ? (
        <Panel title="Invite a member" description="People join only through an invitation you create here.">
          <InviteForm slug={org} emailAvailable={emailConfigured()} />
        </Panel>
      ) : null}
    </div>
  );
}
