import { SettingsForm } from "@/components/platform/settings-forms";
import { KeyValues, Notice, Panel } from "@/components/platform/ui";
import { formatDateTime } from "@/lib/format";
import { getOrgPageAccess } from "@/server/authz/next";
import { emailConfigured } from "@/server/email";
import { emailUnavailableReason } from "@/server/notifications/email";

export default async function GeneralSettingsPage(props: PageProps<"/app/[org]/settings">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  const s = access.org.settings;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Panel title="Organization" description="Name, time zone, exports, and data retention.">
        {access.can("org.manage") ? (
          <SettingsForm
            slug={org}
            defaults={{
              name: access.org.name,
              timezone: s.timezone ?? "America/New_York",
              exportsEnabled: s.exportsEnabled !== false,
              auditDays: s.retention?.auditDays ?? 365,
              newsDays: s.retention?.newsDays ?? 180,
              exportsDays: s.retention?.exportsDays ?? 7,
              jobsDays: s.retention?.jobsDays ?? 30,
            }}
          />
        ) : (
          <Notice>Only organization administrators can change settings.</Notice>
        )}
      </Panel>
      <Panel title="Workspace">
        <KeyValues
          items={[
            ["Type", access.org.kind.replace("_", " ")],
            ["Slug", access.org.slug],
            ["Sample data", access.org.isSynthetic ? "Yes — synthetic development organization" : "No"],
            ["Onboarding", access.org.onboardingCompletedAt ? `Completed ${formatDateTime(access.org.onboardingCompletedAt)}` : "Not completed"],
            [
              "Email delivery",
              emailConfigured()
                ? "Configured"
                : emailUnavailableReason() === "email_not_verified"
                  ? "Configured but not yet verified in this deployment — off; notifications are in-app only"
                  : "Not configured — notifications are in-app only",
            ],
          ]}
        />
      </Panel>
    </div>
  );
}
