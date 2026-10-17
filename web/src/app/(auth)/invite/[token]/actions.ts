"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { createCredentialUser, passwordSchema } from "@/server/accounts/service";
import { getAuth } from "@/server/auth/auth";
import { getSessionUser, requestMeta } from "@/server/auth/session";
import { toActionError, type ActionResult } from "@/server/authz/next";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { acceptInvitation, lookupInvitation } from "@/server/orgs/service";
import { rateLimit } from "@/server/rate-limit";

export async function acceptInviteAction(token: string): Promise<ActionResult<{ slug: string }>> {
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, error: "Sign in first.", code: "unauthenticated" };
    const slug = await acceptInvitation(token, { id: user.id, email: user.email }, await requestMeta());
    return { ok: true, data: { slug } };
  } catch (err) {
    return toActionError(err);
  }
}

const signupSchema = z.object({ name: z.string().trim().min(2, "Enter your name.").max(100), password: passwordSchema });

/**
 * Create an account from an invitation link. The account's email is the
 * invited address, taken from the invitation the token identifies — holding
 * the link is what authorizes the account, not knowing the address.
 */
export async function signUpWithInvitationAction(token: string, raw: { name: string; password: string }): Promise<ActionResult<{ slug: string }>> {
  try {
    const meta = await requestMeta();
    if (!rateLimit(`invite-signup:${meta.ip ?? "unknown"}`, 10, 60 * 60 * 1000).ok) {
      return { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" };
    }
    const inv = await lookupInvitation(token);
    if (inv.state !== "valid") throw new DomainError("invitation_invalid", "This invitation is no longer valid.", 409);
    const input = signupSchema.parse(raw);
    const [existing] = await db()`select 1 from auth_user where lower(email) = ${inv.email.toLowerCase()}`;
    if (existing) throw new DomainError("already_registered", "An account already exists for this address. Sign in to accept the invitation.", 409);
    const { id } = await createCredentialUser({ email: inv.email, name: input.name, password: input.password }, "invitation");
    // Sign in through Better Auth so it issues the session cookie.
    await getAuth().api.signInEmail({ body: { email: inv.email, password: input.password }, headers: await headers() });
    const slug = await acceptInvitation(token, { id, email: inv.email }, meta);
    return { ok: true, data: { slug } };
  } catch (err) {
    return toActionError(err);
  }
}
