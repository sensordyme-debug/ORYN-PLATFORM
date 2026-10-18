import type { Metadata } from "next";
import { PlatformShell, type NavItem } from "@/components/platform/shell";
import { FixtureBanner, SyntheticBanner, TrialBanner } from "@/components/platform/ui";
import { ROLE_LABEL } from "@/lib/authz";
import { orgProfile } from "@/lib/org-profile";
import { listUserOrgs } from "@/server/authz/access";
import { getOrgPageAccess } from "@/server/authz/next";
import { getSessionUser } from "@/server/auth/session";
import { shellSummary } from "@/server/orgs/shell";

export const metadata: Metadata = { title: { default: "Platform", template: "%s — ORYN Platform" }, robots: { index: false } };

export default async function OrgLayout(props: LayoutProps<"/app/[org]">) {
  const { org: slug } = await props.params;
  const access = await getOrgPageAccess(slug);
  const user = (await getSessionUser())!;
  const orgs = await listUserOrgs(user.id);
  const base = `/app/${slug}`;

  const counts = await shellSummary(access, user.id);

  const words = orgProfile(access.org.kind);
  const nav: NavItem[] = [
    { href: base, label: words.overview, icon: "overview" },
    { href: `${base}/map`, label: "Map workspace", icon: "map" },
    { href: `${base}/intel`, label: "Intelligence globe", icon: "globe" },
    { href: `${base}/areas`, label: words.areas, icon: "areas" },
    { href: `${base}/detections`, label: words.review, icon: "review", badge: counts.unreviewed },
    { href: `${base}/alerts`, label: "Alerts", icon: "alerts", badge: counts.open_alerts },
    { href: `${base}/reports`, label: "Reports & exports", icon: "reports" },
  ];
  if (access.can("jobs.read")) nav.push({ href: `${base}/processing`, label: "Processing", icon: "processing" });
  nav.push({ href: `${base}/sources`, label: "Data sources", icon: "sources" });
  if (access.can("members.read") || access.can("org.manage")) nav.push({ href: `${base}/settings`, label: "Settings", icon: "settings" });
  if (access.can("audit.read")) nav.push({ href: `${base}/audit`, label: "Audit trail", icon: "audit" });

  return (
    <PlatformShell
      orgSlug={slug}
      orgName={access.org.name}
      orgs={orgs.map((o) => ({ slug: o.slug, name: o.name, role: o.role }))}
      nav={nav}
      user={{ name: user.name, handle: user.displayUsername ?? user.contactEmail ?? user.label, isPlatformAdmin: user.isPlatformAdmin }}
      unread={counts.unread}
      roleLabel={access.role ? ROLE_LABEL[access.role] : ""}
      banner={
        access.org.isTrial ? (
          <TrialBanner sharedAccount={user.trialOnly} fixtures={counts.has_fixture_data} />
        ) : access.org.isSynthetic ? (
          <SyntheticBanner fixtures={counts.has_fixture_data} />
        ) : counts.has_fixture_data ? (
          <FixtureBanner />
        ) : null
      }
    >
      {props.children}
    </PlatformShell>
  );
}
