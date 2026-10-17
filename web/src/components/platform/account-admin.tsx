"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createAccountAction,
  removeMembershipAction,
  resetPasswordAction,
  revokeSessionsAction,
  setDisabledAction,
  setMembershipAction,
  setTrialOnlyAction,
} from "@/app/(platform)/app/admin/accounts/actions";
import { CopyField } from "@/components/platform/copy-field";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { ORG_ROLES, ROLE_LABEL, type OrgRole } from "@/lib/authz";

export type OrgOption = { slug: string; name: string; isTrial: boolean };
export type AccountRowData = {
  id: string;
  handle: string;
  trialOnly: boolean;
  disabled: boolean;
  isSelf: boolean;
  memberships: { slug: string; name: string; role: OrgRole }[];
};

const LEAST_PRIVILEGE_ORDER: OrgRole[] = ["viewer", "field_operator", "analyst", "auditor", "org_admin"];
const roleOptions = LEAST_PRIVILEGE_ORDER.filter((r) => (ORG_ROLES as readonly string[]).includes(r));

export function CreateAccountForm({ orgs }: { orgs: OrgOption[] }) {
  const [state, action, pending] = useActionState(createAccountAction, null);
  const err = (f: string) => (state && !state.ok ? state.fields?.[f] : undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state && !state.ok && !state.fields ? <Notice tone="error">{state.error}</Notice> : null}
      {state?.ok ? (
        state.data.created ? (
          <Notice tone="success" title={`Created ${state.data.username}`}>
            Temporary password — shown once, not stored anywhere readable. Give it to the partner through a separate channel; they must
            replace it at first sign-in.
            {state.data.temporaryPassword ? <CopyField value={state.data.temporaryPassword} className="mt-2" /> : null}
          </Notice>
        ) : (
          <Notice title={`${state.data.username} already exists`}>
            {[...state.data.notes, state.data.membership === "created" ? "Added the requested membership." : null].filter(Boolean).join(" ")}
          </Notice>
        )
      ) : null}
      <Field label="Username" htmlFor="acct-username" hint="3–30 letters, digits, dots, or underscores. Sign-in is case-insensitive." error={err("username")}>
        <input id="acct-username" name="username" required autoComplete="off" spellCheck={false} className={inputClass} placeholder="jdoe" />
      </Field>
      <Field label="Name" htmlFor="acct-name" error={err("name")}>
        <input id="acct-name" name="name" required className={inputClass} placeholder="Jane Doe" />
      </Field>
      <Field label="Email (optional)" htmlFor="acct-email" hint="Only a real address the partner controls. Leave blank otherwise." error={err("email")}>
        <input id="acct-email" name="email" type="email" className={inputClass} />
      </Field>
      <Field label="Organization" htmlFor="acct-org" error={err("orgSlug")}>
        <select id="acct-org" name="org" className={inputClass} defaultValue="">
          <option value="">None yet</option>
          {orgs.map((o) => (
            <option key={o.slug} value={o.slug}>
              {o.name}
              {o.isTrial ? " (trial)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Role" htmlFor="acct-role" hint="Start with the least privilege the partner needs.">
        <select id="acct-role" name="role" className={inputClass} defaultValue="viewer">
          {roleOptions.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
      </Field>
      <label className="flex items-start gap-2 text-[0.8125rem] text-bone-50/70">
        <input type="checkbox" name="trialOnly" className="mt-0.5" />
        Trial-only account (can open trial workspaces only)
      </label>
      <p className="text-[0.75rem] text-bone-50/45">
        A temporary password is generated. The account never receives platform-administrator rights from this form.
      </p>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create account"}</Button>
    </form>
  );
}

export function AccountActions({ account, orgs }: { account: AccountRowData; orgs: OrgOption[] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [org, setOrg] = useState("");
  const [role, setRole] = useState<OrgRole>("viewer");
  const label = account.handle;

  function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, success: (d: T) => string) {
    setMessage(null);
    start(async () => {
      const r = await fn();
      setMessage(r.ok ? { tone: "success", text: success(r.data) } : { tone: "error", text: r.error });
    });
  }

  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[0.75rem] text-bone-50/60 hover:text-bone-50">Manage</summary>
      <div className="mt-2 flex min-w-[280px] flex-col gap-2">
        {message ? <p className={message.tone === "error" ? "text-[0.75rem] text-data-alert" : "text-[0.75rem] text-data-good"}>{message.text}</p> : null}
        {secret ? (
          <div className="text-[0.75rem] text-bone-50/70">
            New temporary password (shown once):
            <CopyField value={secret} className="mt-1" />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Issue a new temporary password for ${label}? Their sessions end and they must change it at next sign-in.`)) return;
              setSecret(null);
              act(() => resetPasswordAction(account.id), (d) => {
                setSecret(d.temporaryPassword);
                return `Password reset; ${d.sessionsRevoked} session(s) ended.`;
              });
            }}
          >
            Reset password
          </Button>
          <Button size="sm" disabled={pending} onClick={() => act(() => revokeSessionsAction(account.id), (d) => `${d.sessionsRevoked} session(s) ended.`)}>
            Sign out everywhere
          </Button>
          {account.isSelf ? null : account.disabled ? (
            <Button size="sm" disabled={pending} onClick={() => act(() => setDisabledAction(account.id, false, null), () => "Account enabled.")}>
              Enable
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                const reason = prompt(`Disable ${label}? Their sessions and the API keys they created are revoked. Reason (recorded in the audit trail):`);
                if (reason === null) return;
                act(() => setDisabledAction(account.id, true, reason || null), (d) => `Disabled; ${d.sessionsRevoked} session(s) and ${d.apiKeysRevoked} API key(s) revoked.`);
              }}
            >
              Disable
            </Button>
          )}
          {account.trialOnly ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (!confirm(`Lift the trial-only restriction on ${label}? Its sessions end and it must change its password before opening any real organization.`)) return;
                act(() => setTrialOnlyAction(account.id, false), () => "Trial restriction lifted; password change required.");
              }}
            >
              Lift trial restriction
            </Button>
          ) : null}
        </div>
        {account.memberships.length ? (
          <ul className="flex flex-col gap-1 text-[0.75rem]">
            {account.memberships.map((m) => (
              <li key={m.slug} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <select
                  aria-label={`Role in ${m.name}`}
                  defaultValue={m.role}
                  disabled={pending}
                  className={`${inputClass} h-7 w-auto py-0 text-[0.75rem]`}
                  onChange={(e) => act(() => setMembershipAction(account.id, m.slug, e.target.value as OrgRole), (d) => `Role ${d.result}.`)}
                >
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="text-bone-50/50 hover:text-data-alert"
                  aria-label={`Remove from ${m.name}`}
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`Remove ${label} from ${m.name}?`)) return;
                    act(() => removeMembershipAction(account.id, m.slug), () => "Membership removed.");
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-1.5">
          <select aria-label="Organization to add" value={org} onChange={(e) => setOrg(e.target.value)} className={`${inputClass} h-7 py-0 text-[0.75rem]`}>
            <option value="">Add to organization…</option>
            {orgs
              .filter((o) => !account.memberships.some((m) => m.slug === o.slug) && (!account.trialOnly || o.isTrial))
              .map((o) => (
                <option key={o.slug} value={o.slug}>{o.name}{o.isTrial ? " (trial)" : ""}</option>
              ))}
          </select>
          <select aria-label="Role for the new membership" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className={`${inputClass} h-7 w-auto py-0 text-[0.75rem]`}>
            {roleOptions.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <Button size="sm" disabled={pending || !org} onClick={() => act(() => setMembershipAction(account.id, org, role), (d) => `Membership ${d.result}.`)}>
            Add
          </Button>
        </div>
      </div>
    </details>
  );
}
