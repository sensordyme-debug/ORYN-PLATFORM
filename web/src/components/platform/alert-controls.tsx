"use client";

import { useState } from "react";
import { alertAction, markNotificationsReadAction, ruleDeleteAction, ruleToggleAction } from "@/app/(platform)/app/[org]/alerts/actions";
import { Button, inputClass, Notice } from "@/components/platform/ui";

export function AlertControls({ slug, alertId, status, canRespond, canNote, members, assignedTo }: {
  slug: string; alertId: string; status: string; canRespond: boolean; canNote: boolean; members: { id: string; name: string }[]; assignedTo: string | null;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (kind: "ack" | "resolve" | "reopen" | "note" | "assign", userId?: string | null) => {
    setPending(true);
    const r = await alertAction(slug, alertId, { kind, note: note || undefined, userId });
    setPending(false);
    if (!r.ok) setError(r.error);
    else {
      setError(null);
      if (kind !== "assign") setNote("");
    }
  };
  if (!canRespond && !canNote) return <p className="text-[0.8125rem] text-bone-50/50">Your role can view alerts but not respond to them.</p>;
  return (
    <div className="flex flex-col gap-3">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <textarea aria-label="Note" className={inputClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was found or done? (required to resolve)" />
      <div className="flex flex-wrap gap-2">
        {canRespond && status === "open" ? <Button disabled={pending} onClick={() => run("ack")}>Acknowledge</Button> : null}
        {canRespond && (status === "open" || status === "acknowledged") ? <Button variant="primary" disabled={pending || !note.trim()} onClick={() => run("resolve")}>Resolve</Button> : null}
        {canRespond && (status === "resolved" || status === "suppressed") ? <Button disabled={pending} onClick={() => run("reopen")}>Reopen</Button> : null}
        {canNote ? <Button variant="ghost" disabled={pending || !note.trim()} onClick={() => run("note")}>Add note</Button> : null}
      </div>
      {canRespond ? (
        <label className="flex items-center gap-2 text-[0.8125rem] text-bone-50/70">
          Assigned to
          <select className={`${inputClass} w-auto`} value={assignedTo ?? ""} disabled={pending} onChange={(e) => run("assign", e.target.value || null)}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function RuleControls({ slug, ruleId, enabled }: { slug: string; ruleId: string; enabled: boolean }) {
  return (
    <span className="flex gap-1">
      <Button size="sm" onClick={() => ruleToggleAction(slug, ruleId, !enabled)}>{enabled ? "Disable" : "Enable"}</Button>
      <Button size="sm" variant="danger" onClick={() => confirm("Delete this rule? Existing alerts are kept.") && ruleDeleteAction(slug, ruleId)}>Delete</Button>
    </span>
  );
}

export function MarkAllRead({ slug }: { slug: string }) {
  return <Button size="sm" onClick={() => markNotificationsReadAction(slug)}>Mark all read</Button>;
}
