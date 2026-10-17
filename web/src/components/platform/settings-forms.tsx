"use client";

import { useActionState, useState } from "react";
import {
  createApiKeyAction,
  inviteAction,
  removeMemberAction,
  revokeApiKeyAction,
  revokeInvitationAction,
  updateMemberAction,
  updateSettingsAction,
} from "@/app/(platform)/app/[org]/settings/actions";
import { CopyField } from "@/components/platform/copy-field";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { API_KEY_SCOPES, ORG_ROLES, ROLE_DESCRIPTION, ROLE_LABEL, type OrgRole } from "@/lib/authz";

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "UTC"];

export function SettingsForm({
  slug,
  defaults,
}: {
  slug: string;
  defaults: { name: string; timezone: string; exportsEnabled: boolean; auditDays: number; newsDays: number; exportsDays: number; jobsDays: number };
}) {
  const [state, action, pending] = useActionState(updateSettingsAction.bind(null, slug), null);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {state ? <Notice tone={state.ok ? "success" : "error"} className="sm:col-span-2">{state.ok ? "Settings saved." : state.error}</Notice> : null}
      <Field label="Organization name" htmlFor="s-name" className="sm:col-span-2">
        <input id="s-name" name="name" defaultValue={defaults.name} className={inputClass} />
      </Field>
      <Field label="Time zone" htmlFor="s-tz" hint="Used to display local times in reports and alerts.">
        <select id="s-tz" name="timezone" defaultValue={defaults.timezone} className={inputClass}>
          {TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
        </select>
      </Field>
      <label className="flex items-center gap-2 self-end pb-2 text-[0.8125rem] text-bone-50/75">
        <input type="checkbox" name="exportsEnabled" defaultChecked={defaults.exportsEnabled} />
        Allow data exports (still limited to roles with export permission)
      </label>
      <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-4">
        <legend className="t-eyebrow mb-2 text-bone-50/50">Retention (days)</legend>
        <Field label="Audit trail" htmlFor="r-audit" hint="Minimum 90.">
          <input id="r-audit" name="auditDays" type="number" min={90} max={3650} defaultValue={defaults.auditDays} className={inputClass} />
        </Field>
        <Field label="News matches" htmlFor="r-news">
          <input id="r-news" name="newsDays" type="number" min={7} max={3650} defaultValue={defaults.newsDays} className={inputClass} />
        </Field>
        <Field label="Export files" htmlFor="r-exp">
          <input id="r-exp" name="exportsDays" type="number" min={1} max={90} defaultValue={defaults.exportsDays} className={inputClass} />
        </Field>
        <Field label="Finished jobs" htmlFor="r-jobs">
          <input id="r-jobs" name="jobsDays" type="number" min={7} max={3650} defaultValue={defaults.jobsDays} className={inputClass} />
        </Field>
      </fieldset>
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
      </div>
    </form>
  );
}

export function InviteForm({ slug, emailAvailable }: { slug: string; emailAvailable: boolean }) {
  const [state, action, pending] = useActionState(inviteAction.bind(null, slug), null);
  const [role, setRole] = useState<OrgRole>("analyst");
  return (
    <form action={action} className="flex flex-col gap-3">
      {state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null}
      {state?.ok ? (
        <Notice tone="success" title="Invitation created">
          {state.data.emailed === "sent" ? "An email was sent. " : state.data.emailed === "not_configured" ? "Email is not configured — share the link yourself. " : state.data.emailed === "failed" ? "The email could not be sent — share the link yourself. " : ""}
          This link is shown once and expires in {state.data.expiresInDays} days:
          <CopyField value={state.data.link} className="mt-2" />
        </Notice>
      ) : null}
      <Field label="Email" htmlFor="inv-email" error={state && !state.ok ? state.fields?.email : undefined}>
        <input id="inv-email" name="email" type="email" required className={inputClass} />
      </Field>
      <Field label="Role" htmlFor="inv-role" hint={ROLE_DESCRIPTION[role]}>
        <select id="inv-role" name="role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className={inputClass}>
          {ORG_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
      </Field>
      <label className={`flex items-center gap-2 text-[0.8125rem] ${emailAvailable ? "text-bone-50/75" : "text-bone-50/35"}`}>
        <input type="checkbox" name="sendEmail" disabled={!emailAvailable} />
        Email the invitation {emailAvailable ? "" : "(email delivery not configured)"}
      </label>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create invitation"}</Button>
    </form>
  );
}

export function MemberControls({
  slug,
  membershipId,
  role,
  aoiRestricted,
  grantedAoiIds,
  aois,
  isSelf,
}: {
  slug: string;
  membershipId: string;
  role: OrgRole;
  aoiRestricted: boolean;
  grantedAoiIds: string[];
  aois: { id: string; name: string }[];
  isSelf: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [showGrants, setShowGrants] = useState(false);
  const [grants, setGrants] = useState(new Set(grantedAoiIds));
  const run = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    setError(r.ok ? null : (r.error ?? "Failed"));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Role"
          defaultValue={role}
          className={`${inputClass} w-auto py-1 text-[0.75rem]`}
          onChange={(e) => run(updateMemberAction(slug, membershipId, { role: e.target.value as OrgRole }))}
        >
          {ORG_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[0.75rem] text-bone-50/70">
          <input
            type="checkbox"
            defaultChecked={aoiRestricted}
            onChange={(e) => run(updateMemberAction(slug, membershipId, { aoiRestricted: e.target.checked }))}
          />
          Limit to assigned areas
        </label>
        {aoiRestricted ? <Button size="sm" variant="ghost" onClick={() => setShowGrants((s) => !s)}>Assigned areas ({grants.size})</Button> : null}
        {!isSelf ? (
          <Button size="sm" variant="danger" onClick={() => confirm("Remove this member from the organization?") && run(removeMemberAction(slug, membershipId))}>
            Remove
          </Button>
        ) : null}
      </div>
      {showGrants ? (
        <div className="max-h-48 overflow-y-auto rounded-[3px] border border-bone-50/10 p-2">
          {aois.map((a) => (
            <label key={a.id} className="flex items-center gap-2 py-0.5 text-[0.75rem]">
              <input
                type="checkbox"
                checked={grants.has(a.id)}
                onChange={(e) => {
                  const next = new Set(grants);
                  if (e.target.checked) next.add(a.id);
                  else next.delete(a.id);
                  setGrants(next);
                }}
              />
              {a.name}
            </label>
          ))}
          <Button size="sm" variant="primary" className="mt-2" onClick={() => run(updateMemberAction(slug, membershipId, { grantedAoiIds: [...grants] }))}>
            Save assignments
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-[0.75rem] text-data-alert">{error}</p> : null}
    </div>
  );
}

export function RevokeInvitationButton({ slug, id }: { slug: string; id: string }) {
  return <Button size="sm" variant="ghost" onClick={() => revokeInvitationAction(slug, id)}>Revoke</Button>;
}

export function ApiKeyForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(createApiKeyAction.bind(null, slug), null);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null}
      {state?.ok ? (
        <Notice tone="success" title="API key created — copy it now">
          It will not be shown again. Send it as <code>Authorization: Bearer …</code>.
          <CopyField value={state.data.key} className="mt-2" />
        </Notice>
      ) : null}
      <Field label="Name" htmlFor="k-name">
        <input id="k-name" name="name" required maxLength={80} className={inputClass} placeholder="County GIS sync" />
      </Field>
      <fieldset>
        <legend className="mb-1 text-[0.8125rem] text-bone-50/75">Scopes</legend>
        <div className="grid grid-cols-2 gap-1">
          {API_KEY_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-[0.75rem] text-bone-50/75">
              <input type="checkbox" name="scopes" value={s} defaultChecked={s.endsWith(".read")} />
              <code>{s}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Expires" htmlFor="k-exp">
        <select id="k-exp" name="expiresInDays" defaultValue="90" className={inputClass}>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="never">Never (not recommended)</option>
        </select>
      </Field>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create API key"}</Button>
    </form>
  );
}

export function RevokeApiKeyButton({ slug, id }: { slug: string; id: string }) {
  return (
    <Button size="sm" variant="danger" onClick={() => confirm("Revoke this key? Clients using it will stop working immediately.") && revokeApiKeyAction(slug, id)}>
      Revoke
    </Button>
  );
}
