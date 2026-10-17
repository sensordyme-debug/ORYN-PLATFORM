import { APIError } from "better-auth/api";
import { z } from "zod";
import { passwordSchema } from "@/server/accounts/service";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { withSystem } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(128),
    newPassword: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: "The passwords do not match." })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ["newPassword"], message: "Choose a password different from the current one." });

/**
 * The signed-in user replaces their password. Better Auth verifies the
 * current password, stores the new hash, ends every other session, and issues
 * this browser a fresh session. Then the "must change password" requirement
 * is cleared — the only way it is cleared other than an emailed reset.
 */
type ChangePasswordApi = {
  api: {
    changePassword(args: { body: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }; headers: Headers }): Promise<unknown>;
  };
};

/**
 * @param deps.auth    Better Auth instance (getAuth() in a Server Action, so the
 *                     new session cookie is set on the response)
 * @param deps.headers the request headers carrying the session cookie
 */
export async function changeOwnPassword(
  user: Pick<SessionUser, "id" | "username" | "label" | "mustChangePassword">,
  raw: z.input<typeof changePasswordSchema>,
  meta: { ip: string | null; userAgent: string | null },
  deps: { auth: ChangePasswordApi; headers: Headers },
): Promise<void> {
  // The HTTP rate limiter does not apply to server-side calls; guessing the
  // current password from a stolen session is limited here instead.
  if (!rateLimit(`password-change:${user.id}`, 5, 15 * 60_000).ok) {
    throw new DomainError("rate_limited", "Too many attempts. Wait 15 minutes and try again.", 429);
  }
  const input = changePasswordSchema.parse(raw);
  if (user.username && input.newPassword.toLowerCase().includes(user.username)) {
    throw new DomainError("invalid", "Please correct the highlighted fields.", 422, { newPassword: "Do not include your username in your password." });
  }
  try {
    await deps.auth.api.changePassword({
      body: { currentPassword: input.currentPassword, newPassword: input.newPassword, revokeOtherSessions: true },
      headers: deps.headers,
    });
  } catch (err) {
    if (err instanceof APIError && err.statusCode === 400) {
      throw new DomainError("invalid", "Please correct the highlighted fields.", 422, { currentPassword: "The current password is incorrect." });
    }
    throw err;
  }
  await withSystem("accounts.password_changed", async (tx) => {
    await tx`
      insert into account_controls (user_id, must_change_password, password_changed_at) values (${user.id}, false, now())
      on conflict (user_id) do update set must_change_password = false, password_changed_at = now()`;
    await recordAudit(tx, {
      orgId: null,
      actor: { type: "user", userId: user.id, label: user.label },
      action: "account.password_change",
      targetType: "user",
      targetId: user.id,
      metadata: { was_required: user.mustChangePassword, other_sessions_revoked: true },
      ...meta,
    });
  });
}
