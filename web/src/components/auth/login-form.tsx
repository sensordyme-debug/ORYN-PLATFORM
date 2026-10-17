"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next, resetAvailable }: { next: string; resetAvailable: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const identifier = String(form.get("identifier") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    // Accounts provisioned by an administrator sign in with a username;
    // accounts created from an email invitation may also use their address.
    const { error: err } = identifier.includes("@")
      ? await authClient.signIn.email({ email: identifier, password })
      : await authClient.signIn.username({ username: identifier, password });
    if (err) {
      setPending(false);
      // One message for every failure (unknown user, wrong password, disabled
      // account, malformed username) so the form does not reveal which.
      setError(err.status === 429 ? "Too many attempts. Wait a minute and try again." : "The username or password is incorrect.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Username" htmlFor="identifier" hint="Accounts created from an email invitation can also use their email address.">
        <input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          maxLength={200}
          className={inputClass}
        />
      </Field>
      <Field label="Password" htmlFor="password">
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} className={inputClass} />
      </Field>
      <Button type="submit" variant="primary" disabled={pending} className="mt-1 h-10">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-[0.8125rem] text-bone-50/50">
        {resetAvailable ? (
          <>
            <Link href="/forgot-password" className="underline underline-offset-4 hover:text-bone-50">
              Forgot your password?
            </Link>{" "}
            Accounts without an email address: ask your administrator for a reset.
          </>
        ) : (
          "Forgot your password? Ask your ORYN administrator to reset it."
        )}
      </p>
    </form>
  );
}
