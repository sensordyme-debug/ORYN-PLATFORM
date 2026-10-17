"use client";

import { useActionState, useState } from "react";
import { createOrgAction, inviteOrgAdminAction } from "@/app/(platform)/app/admin/actions";
import { CopyField } from "@/components/platform/copy-field";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(createOrgAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null}
      {state?.ok ? (
        <Notice tone="success" title={`Created ${state.data.slug}`}>
          {state.data.link ? (
            <>
              Send this one-time invitation link to the administrator (it is not shown again):
              <CopyField value={state.data.link} className="mt-2" />
            </>
          ) : (
            "No administrator was invited yet."
          )}
        </Notice>
      ) : null}
      <Field label="Name" htmlFor="org-name" error={state && !state.ok ? state.fields?.name : undefined}>
        <input id="org-name" name="name" required className={inputClass} placeholder="Town of Tarboro" />
      </Field>
      <Field label="Slug" htmlFor="org-slug" hint="Used in URLs. Lowercase letters, digits, hyphens." error={state && !state.ok ? state.fields?.slug : undefined}>
        <input id="org-slug" name="slug" required pattern="[a-z0-9][a-z0-9-]{1,47}" className={inputClass} placeholder="tarboro-nc" />
      </Field>
      <Field label="Type" htmlFor="org-kind">
        <select id="org-kind" name="kind" className={inputClass} defaultValue="municipal">
          <option value="agriculture">Agricultural operator</option>
          <option value="municipal">Municipal government</option>
          <option value="infrastructure">Infrastructure operator</option>
          <option value="enterprise">Enterprise</option>
          <option value="public_sector">Public-sector organization</option>
        </select>
      </Field>
      <Field label="First administrator email (optional)" htmlFor="org-admin">
        <input id="org-admin" name="adminEmail" type="email" className={inputClass} />
      </Field>
      <label className="flex items-start gap-2 text-[0.8125rem] text-bone-50/70">
        <input type="checkbox" name="synthetic" className="mt-0.5" />
        Synthetic sample organization (development data only — labelled throughout the UI)
      </label>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create organization"}</Button>
    </form>
  );
}

export function InviteAdminButton({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<{ link?: string; error?: string } | null>(null);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>Invite admin</Button>;
  return (
    <div className="flex min-w-[260px] flex-col gap-2">
      {result?.link ? <CopyField value={result.link} /> : null}
      {result?.error ? <p className="text-[0.75rem] text-data-alert">{result.error}</p> : null}
      <input aria-label={`Administrator email for ${orgName}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            const r = await inviteOrgAdminAction(orgId, email);
            setResult(r.ok ? { link: r.data.link } : { error: r.error });
          }}
        >
          Create invitation
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
    </div>
  );
}
