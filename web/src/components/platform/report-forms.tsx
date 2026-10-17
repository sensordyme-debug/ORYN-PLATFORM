"use client";

import { useState } from "react";
import { createExportAction, createReportAction } from "@/app/(platform)/app/[org]/reports/actions";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";

const REPORT_TYPES: { id: string; label: string; needsAoi: boolean; kinds?: string[] }[] = [
  { id: "field", label: "Field report", needsAoi: true, kinds: ["agriculture"] },
  { id: "aoi", label: "Area of interest report", needsAoi: true },
  { id: "change", label: "Change report", needsAoi: true },
  { id: "weather", label: "Weather context report", needsAoi: true },
  { id: "municipal", label: "Municipal monitoring report", needsAoi: true, kinds: ["municipal", "public_sector", "infrastructure", "enterprise"] },
  { id: "disaster", label: "Disaster situation report", needsAoi: true },
  { id: "processing", label: "Processing history report", needsAoi: false },
  { id: "audit", label: "Audit trail report", needsAoi: false },
];

export function ReportForm({ slug, orgKind, aois, defaultAoi, aiAvailable, canAudit }: { slug: string; orgKind: string; aois: { id: string; name: string }[]; defaultAoi?: string; aiAvailable: boolean; canAudit: boolean }) {
  const types = REPORT_TYPES.filter((t) => (!t.kinds || t.kinds.includes(orgKind)) && (t.id !== "audit" || canAudit));
  const [type, setType] = useState(types[0]!.id);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const needsAoi = types.find((t) => t.id === type)?.needsAoi;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setPending(true);
        const r = await createReportAction(slug, { type, aoiId: needsAoi ? String(f.get("aoiId")) : null, from: String(f.get("from") || "") || undefined, to: String(f.get("to") || "") || undefined, ai: f.get("ai") === "on" });
        setPending(false);
        setMsg(r.ok ? { ok: true, text: "Report queued. It is built from stored results and appears below when ready." } : { ok: false, text: r.error });
      }}
    >
      {msg ? <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice> : null}
      <Field label="Report" htmlFor="rep-type">
        <select id="rep-type" value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>{types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      </Field>
      {needsAoi ? (
        <Field label="Area" htmlFor="rep-aoi">
          <select id="rep-aoi" name="aoiId" defaultValue={defaultAoi} required className={inputClass}>{aois.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="From (optional)" htmlFor="rep-from"><input id="rep-from" name="from" type="date" className={inputClass} /></Field>
        <Field label="To (optional)" htmlFor="rep-to"><input id="rep-to" name="to" type="date" className={inputClass} /></Field>
      </div>
      <label className={`flex items-start gap-2 text-[0.8125rem] ${aiAvailable ? "text-bone-50/75" : "text-bone-50/35"}`}>
        <input type="checkbox" name="ai" disabled={!aiAvailable} className="mt-0.5" />
        <span>Add an AI-written narrative {aiAvailable ? "(summarizes only the report's stored findings, cites them, and is checked against them)" : "(not configured on this server)"}</span>
      </label>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Queuing…" : "Generate report"}</Button>
    </form>
  );
}

const SUBJECTS: Record<string, { id: string; label: string }[]> = {
  geojson: [{ id: "detections", label: "Candidate changes" }, { id: "aois", label: "Areas of interest" }, { id: "observations", label: "Observation footprints & metrics" }],
  csv: [{ id: "observations", label: "Observation metrics (time series)" }, { id: "detections", label: "Candidate changes" }, { id: "weather", label: "Weather records" }, { id: "aois", label: "Areas of interest" }],
  geotiff: [{ id: "observation_raster", label: "Observation raster (Float32 GeoTIFF)" }],
};

export function ExportForm({ slug, aois }: { slug: string; aois: { id: string; name: string }[] }) {
  const [type, setType] = useState("csv");
  const [subject, setSubject] = useState("observations");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const params: Record<string, unknown> = {};
        if (f.get("aoiId")) params.aoiId = String(f.get("aoiId"));
        if (f.get("observationId")) params.observationId = String(f.get("observationId")).trim();
        setPending(true);
        const r = await createExportAction(slug, { type, subject, params });
        setPending(false);
        setMsg(r.ok ? { ok: true, text: "Export queued. Licence notes for the data included are attached to it." } : { ok: false, text: r.error });
      }}
    >
      {msg ? <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Format" htmlFor="ex-type">
          <select id="ex-type" value={type} onChange={(e) => { setType(e.target.value); setSubject(SUBJECTS[e.target.value]![0]!.id); }} className={inputClass}>
            <option value="csv">CSV</option><option value="geojson">GeoJSON</option><option value="geotiff">GeoTIFF</option>
          </select>
        </Field>
        <Field label="Contents" htmlFor="ex-subject">
          <select id="ex-subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={inputClass}>{SUBJECTS[type]!.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        </Field>
      </div>
      {subject === "observation_raster" ? (
        <Field label="Observation id" htmlFor="ex-obs" hint="Copy it from an area's observation history (the link in the Acquired column contains it).">
          <input id="ex-obs" name="observationId" required className={inputClass} />
        </Field>
      ) : (
        <Field label="Area (optional)" htmlFor="ex-aoi">
          <select id="ex-aoi" name="aoiId" className={inputClass}><option value="">All areas</option>{aois.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
      )}
      <Button type="submit" disabled={pending}>{pending ? "Queuing…" : "Create export"}</Button>
    </form>
  );
}
