import type { Metadata } from "next";
import { PlatformShell, type NavItem } from "@/components/platform/shell";
import { SyntheticBanner, TrialBanner } from "@/components/platform/ui";
import { ROLE_LABEL } from "@/lib/authz";
import { listUserOrgs } from "@/server/authz/access";
import { currentModelKeys } from "@/server/analytics/registry";
import { getOrgPageAccess } from "@/server/authz/next";
import { getSessionUser } from "@/server/auth/session";

export const metadata: Metadata = { title: { default: "Platform", template: "%s — ORYN Platform" }, robots: { index: false } };

export default async function OrgLayout(props: LayoutProps<"/app/[org]">) {
  const { org: slug } = await props.params;
  const access = await getOrgPageAccess(slug);
  const user = (await getSessionUser())!;
  const orgs = await listUserOrgs(user.id);
  const base = `/app/${slug}`;

  const counts = await access.tx(async (tx) => {
    const [r] = await tx<{ unread: number; open_alerts: number; unreviewed: number }[]>`
      select
        (select count(*)::int from notifications n where n.org_id = ${access.org.id} and n.user_id = ${user.id} and n.channel = 'in_app' and n.read_at is null) as unread,
        (select count(*)::int from alerts a where a.org_id = ${access.org.id} and a.status = 'open') as open_alerts,
        (select count(*)::int from detections d where d.org_id = ${access.org.id} and d.verification_status = 'unverified' and d.evidence_grade in ('moderate', 'strong')
            and d.model_id || '@' || d.model_version = any(${currentModelKeys()})) as unreviewed`;
    return r!;
  });

  const isAg = access.org.kind === "agriculture";
  const isMunicipal = access.org.kind === "municipal" || access.org.kind === "public_sector" || access.org.kind === "infrastructure";
  const nav: NavItem[] = [
    { href: base, label: isAg ? "Farm overview" : isMunicipal ? "Municipal overview" : "Overview", icon: "overview" },
    { href: `${base}/map`, label: "Map workspace", icon: "map" },
    { href: `${base}/intel`, label: "Intelligence globe", icon: "globe" },
    { href: `${base}/areas`, label: isAg ? "Fields & farms" : "Areas of interest", icon: "areas" },
    { href: `${base}/detections`, label: isMunicipal ? "Inspection queue" : "Change review", icon: "review", badge: counts.unreviewed },
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
      banner={access.org.isTrial ? <TrialBanner sharedAccount={user.trialOnly} /> : access.org.isSynthetic ? <SyntheticBanner /> : null}
    >
      {props.children}
    </PlatformShell>
  );
}
