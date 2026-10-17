"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  if (done) {
    return (
      <Notice tone="success" className="mt-5">
        If an account exists for that address, a reset link is on its way. It expires in 30 minutes.
      </Notice>
    );
  }
  return (
    <form
      className="mt-5 flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
        // The response is the same whether or not the account exists.
        await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" }).catch(() => undefined);
        setDone(true);
      }}
    >
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" required autoComplete="username" className={inputClass} />
      </Field>
      <Button type="submit" variant="primary" className="h-10" disabled={pending}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  if (state === "done") {
    return (
      <Notice tone="success" className="mt-5" title="Password updated">
        All other sessions were signed out. <Link href="/login" className="underline underline-offset-4">Sign in</Link>.
      </Notice>
    );
  }
  return (
    <form
      className="mt-5 flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const newPassword = String(f.get("password") ?? "");
        if (newPassword !== String(f.get("confirm") ?? "")) return setError("The passwords do not match.");
        setState("pending");
        const { error: err } = await authClient.resetPassword({ newPassword, token });
        if (err) {
          setState("idle");
          setError(err.message ?? "This reset link is invalid or has expired.");
          return;
        }
        setState("done");
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="New password" htmlFor="password" hint="At least 12 characters.">
        <input id="password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} />
      </Field>
      <Field label="Confirm" htmlFor="confirm">
        <input id="confirm" name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} />
      </Field>
      <Button type="submit" variant="primary" className="h-10" disabled={state === "pending"}>
        Update password
      </Button>
    </form>
  );
}
