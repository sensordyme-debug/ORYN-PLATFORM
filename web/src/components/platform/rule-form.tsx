"use client";

import { useState } from "react";
import { createRuleAction } from "@/app/(platform)/app/[org]/alerts/actions";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";

type JsonSchema = { type?: string; enum?: string[]; default?: unknown; minimum?: number; maximum?: number; exclusiveMinimum?: number; items?: JsonSchema; anyOf?: JsonSchema[]; description?: string; properties?: Record<string, JsonSchema>; required?: string[] };
type CatalogEntry = { type: string; label: string; description: string; needs: string; paramsSchema: JsonSchema };

function fieldDefault(s: JsonSchema): string {
  if (s.default !== undefined) return Array.isArray(s.default) ? (s.default as unknown[]).join(", ") : String(s.default);
  return "";
}

export function RuleForm({ slug, catalog, aois }: { slug: string; catalog: CatalogEntry[]; aois: { id: string; name: string }[] }) {
  const [type, setType] = useState(catalog[0]?.type ?? "");
  const entry = catalog.find((c) => c.type === type);
  const props = entry?.paramsSchema.properties ?? {};
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const params: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(props)) {
      const raw = values[k] ?? fieldDefault(s);
      if (raw === "") continue;
      const t = s.type ?? s.anyOf?.[0]?.type;
      if (t === "number" || t === "integer") params[k] = Number(raw);
      else if (t === "array") params[k] = raw.split(",").map((x) => x.trim()).filter(Boolean);
      else params[k] = raw;
    }
    setPending(true);
    const r = await createRuleAction(slug, {
      name: String(f.get("name")),
      ruleType: type,
      aoiId: String(f.get("aoiId") ?? "") || null,
      severity: String(f.get("severity")),
      cooldownHours: Number(f.get("cooldownHours")),
      notifyEmail: f.get("notifyEmail") === "on",
      escalateAfterHours: f.get("escalateAfterHours") ? Number(f.get("escalateAfterHours")) : null,
      params,
    });
    setPending(false);
    setMsg(r.ok ? { ok: true, text: "Rule created. It applies to data processed from now on." } : { ok: false, text: r.error + (r.fields ? ` (${Object.entries(r.fields).map(([k, v]) => `${k}: ${v}`).join("; ")})` : "") });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {msg ? <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice> : null}
      <Field label="Rule type" htmlFor="r-type" hint={entry ? `${entry.description} Needs: ${entry.needs}` : undefined}>
        <select id="r-type" value={type} onChange={(e) => { setType(e.target.value); setValues({}); }} className={inputClass}>
          {catalog.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="Name" htmlFor="r-name"><input id="r-name" name="name" required maxLength={120} className={inputClass} defaultValue={entry?.label} key={type} /></Field>
      {Object.entries(props).map(([k, s]) => {
        const t = s.type ?? s.anyOf?.[0]?.type;
        const options = s.enum ?? s.items?.enum;
        return (
          <Field key={`${type}-${k}`} label={k.replace(/_/g, " ")} htmlFor={`p-${k}`} hint={s.description ?? (t === "array" ? "Comma-separated." : undefined)}>
            {options && t !== "array" ? (
              <select id={`p-${k}`} className={inputClass} value={values[k] ?? fieldDefault(s)} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                {options.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input id={`p-${k}`} className={inputClass} type={t === "number" || t === "integer" ? "number" : "text"} step={t === "integer" ? 1 : "any"}
                value={values[k] ?? fieldDefault(s)} onChange={(e) => setValues({ ...values, [k]: e.target.value })} placeholder={options ? options.join(", ") : undefined} />
            )}
          </Field>
        );
      })}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Applies to" htmlFor="r-aoi">
          <select id="r-aoi" name="aoiId" className={inputClass}><option value="">All areas</option>{aois.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
        <Field label="Severity" htmlFor="r-sev">
          <select id="r-sev" name="severity" defaultValue="moderate" className={inputClass}>{["info", "low", "moderate", "high", "critical"].map((s) => <option key={s}>{s}</option>)}</select>
        </Field>
        <Field label="Cooldown (hours)" htmlFor="r-cool" hint="Suppress repeats for the same area."><input id="r-cool" name="cooldownHours" type="number" min={0} max={8760} defaultValue={24} className={inputClass} /></Field>
        <Field label="Escalate if open after (hours)" htmlFor="r-esc"><input id="r-esc" name="escalateAfterHours" type="number" min={1} max={8760} className={inputClass} placeholder="Never" /></Field>
      </div>
      <label className="flex items-center gap-2 text-[0.8125rem] text-bone-50/75"><input type="checkbox" name="notifyEmail" /> Also email (when email delivery is configured)</label>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create rule"}</Button>
    </form>
  );
}
