"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { acceptInviteAction, signUpWithInvitationAction } from "@/app/(auth)/invite/[token]/actions";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { authClient } from "@/lib/auth-client";

export function InviteAccept({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        variant="primary"
        className="h-10"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const r = await acceptInviteAction(token);
          if (!r.ok) {
            setError(r.error);
            setPending(false);
            return;
          }
          router.replace(`/app/${r.data.slug}`);
        }}
      >
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
    </div>
  );
}

export function InviteSignup({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    const r = await signUpWithInvitationAction(token, { name: String(form.get("name") ?? "").trim(), password });
    if (!r.ok) {
      setPending(false);
      setError(r.fields?.password ?? r.fields?.name ?? r.error);
      return;
    }
    router.replace(`/app/${r.data.slug}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-[0.875rem] text-bone-50/65">Create your account to accept.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Email" htmlFor="email">
        <input id="email" value={email} readOnly className={inputClass} />
      </Field>
      <Field label="Full name" htmlFor="name">
        <input id="name" name="name" required minLength={2} maxLength={100} autoComplete="name" className={inputClass} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters.">
        <input id="password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} />
      </Field>
      <Field label="Confirm password" htmlFor="confirm">
        <input id="confirm" name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} />
      </Field>
      <Button type="submit" variant="primary" className="h-10" disabled={pending}>
        {pending ? "Creating account…" : "Create account and join"}
      </Button>
    </form>
  );
}

export function SignOutButton({ redirectTo }: { redirectTo?: string }) {
  const router = useRouter();
  return (
    <Button
      onClick={async () => {
        await authClient.signOut();
        if (redirectTo) router.replace(redirectTo);
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
