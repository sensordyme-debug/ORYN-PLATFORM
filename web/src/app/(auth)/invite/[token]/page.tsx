import type { Metadata } from "next";
import Link from "next/link";
import { InviteAccept, InviteSignup, SignOutButton } from "@/components/auth/invite";
import { Notice } from "@/components/platform/ui";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/authz";
import { formatDateTime } from "@/lib/format";
import { getSessionUser } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { lookupInvitation } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

const STATE_MESSAGE = {
  expired: "This invitation has expired. Ask your administrator to send a new one.",
  revoked: "This invitation was withdrawn by an administrator.",
  accepted: "This invitation has already been used.",
  unknown: "This invitation link is not valid. Check that you copied the whole link.",
} as const;

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const inv = await lookupInvitation(token);
  if (inv.state !== "valid") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-[1.5rem] font-medium tracking-[-0.025em]">Invitation unavailable</h1>
        <Notice tone="warn">{STATE_MESSAGE[inv.state]}</Notice>
        <Link href="/login" className="text-[0.875rem] underline underline-offset-4">
          Go to sign in
        </Link>
      </div>
    );
  }

  const header = (
    <div>
      <p className="t-eyebrow text-bone-50/50">Invitation</p>
      <h1 className="mt-1.5 text-[1.5rem] font-medium tracking-[-0.025em]">Join {inv.orgName}</h1>
      <p className="mt-2 text-[0.875rem] text-bone-50/60">
        Role: <span className="text-bone-50">{ROLE_LABEL[inv.role]}</span> — {ROLE_DESCRIPTION[inv.role]}
      </p>
      <p className="mt-1 text-[0.75rem] text-bone-50/45">For {inv.email} · expires {formatDateTime(inv.expiresAt)}</p>
    </div>
  );

  const user = await getSessionUser();
  if (user) {
    if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
      return (
        <div className="flex flex-col gap-5">
          {header}
          <Notice tone="warn" title="Signed in with a different account">
            You are signed in as {user.email}, but this invitation is for {inv.email}. Sign out, then open the link again.
          </Notice>
          <SignOutButton />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-5">
        {header}
        <InviteAccept token={token} />
      </div>
    );
  }

  const [existing] = await db()<{ id: string }[]>`select id from auth_user where lower(email) = ${inv.email.toLowerCase()}`;
  return (
    <div className="flex flex-col gap-5">
      {header}
      {existing ? (
        <Notice title="You already have an ORYN account">
          <Link className="underline underline-offset-4" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
            Sign in as {inv.email}
          </Link>{" "}
          to accept.
        </Notice>
      ) : (
        <InviteSignup token={token} email={inv.email} />
      )}
    </div>
  );
}
