"use client";

import { useEffect, useState } from "react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Button, inputClass } from "@/components/platform/ui";
import { formatDateTime } from "@/lib/format";

type Note = { id: string; body: string; author: string | null; created_at: string };

export function NotesThread({ slug, targetType, targetId, canWrite, timeZone }: { slug: string; targetType: string; targetId: string; canWrite: boolean; timeZone: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<{ items: Note[] }>(`${orgApi(slug)}/notes?targetType=${targetType}&targetId=${targetId}`)
      .then((r) => setNotes(r.items))
      .catch(() => setNotes([]));
  }, [slug, targetType, targetId, tick]);
  return (
    <section aria-label="Analyst notes">
      <p className="t-eyebrow mb-2 text-bone-50/45">Notes ({notes.length})</p>
      <ul className="flex flex-col gap-2">
        {notes.map((n) => (
          <li key={n.id} className="rounded-[3px] bg-bone-50/[0.03] px-2.5 py-1.5 text-[0.75rem]">
            <p className="whitespace-pre-wrap text-bone-50/85">{n.body}</p>
            <p className="mt-0.5 text-bone-50/40">{n.author ?? "Former member"} · {formatDateTime(n.created_at, timeZone)}</p>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form
          className="mt-2 flex flex-col gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(`${orgApi(slug)}/notes`, { method: "POST", json: { targetType, targetId, body } });
              setBody("");
              setError(null);
              setTick((t) => t + 1);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Could not save the note.");
            }
          }}
        >
          <textarea aria-label="Add a note" value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={10000} className={inputClass} placeholder="Add a field observation or analyst note…" />
          {error ? <p className="text-[0.75rem] text-data-alert">{error}</p> : null}
          <Button type="submit" size="sm" disabled={!body.trim()} className="self-start">Add note</Button>
        </form>
      ) : null}
    </section>
  );
}
