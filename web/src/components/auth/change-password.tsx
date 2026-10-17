"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/app/(platform)/app/account/actions";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";

export function ChangePasswordForm({ next }: { next: string | null }) {
  const [state, action, pending] = useActionState(changePasswordAction, null);
  const fieldError = (f: string) => (state && !state.ok ? state.fields?.[f] : undefined);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state && !state.ok && !state.fields ? <Notice tone="error">{state.error}</Notice> : null}
      <Field label="Current password" htmlFor="currentPassword" error={fieldError("currentPassword")}>
        <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} className={inputClass} />
      </Field>
      <Field label="New password" htmlFor="newPassword" hint="At least 12 characters. Use a passphrase you do not use elsewhere." error={fieldError("newPassword")}>
        <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} className={inputClass} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={fieldError("confirm")}>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} className={inputClass} />
      </Field>
      <Button type="submit" variant="primary" disabled={pending} className="h-10 self-start px-5">
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
