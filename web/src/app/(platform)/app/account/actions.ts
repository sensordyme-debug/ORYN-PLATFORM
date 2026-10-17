"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-redirect";
import { changeOwnPassword } from "@/server/accounts/self-service";
import { getAuth } from "@/server/auth/auth";
import { getSessionUser, requestMeta } from "@/server/auth/session";
import { toActionError, type ActionResult } from "@/server/authz/next";

export async function changePasswordAction(_: unknown, form: FormData): Promise<ActionResult> {
  const next = String(form.get("next") ?? "");
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, error: "Your session has expired. Sign in again.", code: "unauthenticated" };
    await changeOwnPassword(
      user,
      {
        currentPassword: String(form.get("currentPassword") ?? ""),
        newPassword: String(form.get("newPassword") ?? ""),
        confirm: String(form.get("confirm") ?? ""),
      },
      await requestMeta(),
      { auth: getAuth(), headers: await headers() },
    );
  } catch (err) {
    return toActionError(err);
  }
  // Every earlier session (including the one this request arrived with) was
  // ended and a new session cookie was set; navigate so the next render uses it.
  redirect(next ? safeNext(next) : "/app/account?changed=1");
}
