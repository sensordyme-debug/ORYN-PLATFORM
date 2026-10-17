import { SettingsTabs } from "@/components/platform/settings-tabs";
import { PageHeader } from "@/components/platform/ui";
import { getOrgPageAccess } from "@/server/authz/next";

export default async function SettingsLayout(props: LayoutProps<"/app/[org]/settings">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  const tabs = [
    ...(access.can("org.read") ? [{ href: `/app/${org}/settings`, label: "General" }] : []),
    ...(access.can("members.read") ? [{ href: `/app/${org}/settings/members`, label: "Members" }] : []),
    ...(access.can("apikeys.manage") ? [{ href: `/app/${org}/settings/api-keys`, label: "API keys" }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Administration" title="Settings" />
      <SettingsTabs tabs={tabs} />
      {props.children}
    </div>
  );
}
