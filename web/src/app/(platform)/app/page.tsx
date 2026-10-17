import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { SignOutButton } from "@/components/auth/invite";
import { EmptyState, LinkButton } from "@/components/platform/ui";
import { ROLE_LABEL } from "@/lib/authz";
import { listUserOrgs } from "@/server/authz/access";
import { passwordChangePath, requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Organizations — ORYN Platform", robots: { index: false } };

export default async function PlatformHome() {
  const user = await requireUser("/app");
  const orgs = await listUserOrgs(user.id);
  // An administrator-issued password must be replaced before any real organization opens.
  if (user.mustChangePassword && orgs.some((o) => o.passwordChangeRequired)) redirect(passwordChangePath("/app"));
  if (orgs.length === 1 && !user.isPlatformAdmin) redirect(`/app/${orgs[0]!.slug}`);
  return (
    <main id="main" className="tech-grid min-h-[100svh] bg-ink-950 text-bone-50">
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Logo className="h-5 w-auto" />
        <h1 className="mt-10 text-[1.75rem] font-medium tracking-[-0.025em]">Choose an organization</h1>
        <p className="mt-1 text-[0.875rem] text-bone-50/55">
          Signed in as {user.displayUsername ?? user.label}
          {user.trialOnly ? " · trial account (trial workspaces only)" : ""}
        </p>
        <ul className="mt-8 flex flex-col gap-2">
          {orgs.map((o) => (
            <li key={o.id}>
              <Link href={`/app/${o.slug}`} className="flex items-center justify-between rounded-[4px] border border-bone-50/10 bg-ink-850 px-4 py-3 hover:border-bone-50/30">
                <span>
                  <span className="block font-medium">{o.name}</span>
                  <span className="block text-[0.75rem] text-bone-50/50">
                    {ROLE_LABEL[o.role]} · {o.kind.replace("_", " ")}
                    {o.isTrial ? " · trial workspace" : o.isSynthetic ? " · synthetic sample" : ""}
                  </span>
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
        {orgs.length === 0 ? (
          <EmptyState title="You are not a member of any organization yet" className="mt-8">
            {user.trialOnly ? "No trial workspace is assigned to this account. Contact your ORYN administrator." : "Ask your ORYN administrator to add you to an organization."}
          </EmptyState>
        ) : null}
        <div className="mt-8 flex gap-2">
          <LinkButton href="/app/account">Your account</LinkButton>
          {user.isPlatformAdmin ? <LinkButton href="/app/admin">Platform administration</LinkButton> : null}
          <SignOutButton redirectTo="/login" />
        </div>
      </div>
    </main>
  );
}
