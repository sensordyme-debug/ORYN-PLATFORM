import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ChangePasswordForm } from "@/components/auth/change-password";
import { SignOutButton } from "@/components/auth/invite";
import { Badge, KeyValues, Notice, Panel } from "@/components/platform/ui";
import { safeNext } from "@/lib/safe-redirect";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Your account — ORYN Platform", robots: { index: false } };

export default async function AccountPage(props: PageProps<"/app/account">) {
  const sp = await props.searchParams;
  const user = await requireUser("/app/account");
  const next = typeof sp.next === "string" ? safeNext(sp.next) : null;
  return (
    <main id="main" className="tech-grid min-h-[100svh] bg-ink-950 text-bone-50">
      <div className="mx-auto max-w-xl px-4 py-16">
        <Logo className="h-5 w-auto" />
        <h1 className="mt-10 text-[1.75rem] font-medium tracking-[-0.025em]">Your account</h1>
        <div className="mt-6 flex flex-col gap-6">
          {sp.changed === "1" ? (
            <Notice tone="success" title="Password changed">
              Every other session was signed out.
            </Notice>
          ) : null}
          {user.mustChangePassword && !user.trialOnly ? (
            <Notice tone="warn" title="Choose a new password to continue">
              Your administrator issued your current password. Replace it with one only you know before opening your organization&apos;s data.
            </Notice>
          ) : null}
          {user.trialOnly ? (
            <Notice title="Trial account">
              This account can open trial workspaces only. They hold synthetic sample data — never a real customer&apos;s. It may be shared, so
              do not enter or upload anything confidential.
            </Notice>
          ) : null}
          <Panel title="Profile">
            <KeyValues
              items={[
                ["Username", user.displayUsername ?? user.username ?? "—"],
                ["Name", user.name],
                ["Email", user.contactEmail ?? "None on file"],
                [
                  "Access",
                  <span key="a" className="flex flex-wrap gap-1.5">
                    {user.isPlatformAdmin ? <Badge tone="watch">Platform administrator</Badge> : null}
                    {user.trialOnly ? <Badge tone="info">Trial only</Badge> : null}
                    {!user.isPlatformAdmin && !user.trialOnly ? <Badge>Organization member</Badge> : null}
                  </span>,
                ],
              ]}
            />
            <p className="mt-3 text-[0.75rem] text-bone-50/45">Usernames and organization roles are changed by an administrator.</p>
          </Panel>
          <Panel title="Change password">
            <ChangePasswordForm next={next ?? (user.mustChangePassword ? "/app" : null)} />
          </Panel>
          <div className="flex items-center gap-4">
            <Link href="/app" className="text-[0.8125rem] text-bone-50/60 underline-offset-4 hover:text-bone-50 hover:underline">
              ← Organizations
            </Link>
            <SignOutButton redirectTo="/login" />
          </div>
        </div>
      </div>
    </main>
  );
}
