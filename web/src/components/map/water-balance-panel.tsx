"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Badge, Button, inputClass, Notice } from "@/components/platform/ui";
import { CROP_PROFILES, SOIL_TEXTURES, textureAvailableWaterMmPerM } from "@/lib/fao56";
import { formatDate } from "@/lib/format";
import type { Agronomy, WaterBalance } from "@/server/agronomy/service";

/**
 * FAO-56 crop water balance for one field (src/server/agronomy): a planning
 * estimate of root-zone depletion from the field's crop, planting date, soil
 * and logged irrigation, and stored weather. Missing inputs are named; days
 * without weather are never filled in.
 */

const CONDITION: Record<NonNullable<WaterBalance["current"]>["condition"], { tone: "good" | "watch" | "alert"; label: string }> = {
  no_stress_expected: { tone: "good", label: "No stress expected" },
  approaching_stress: { tone: "watch", label: "Approaching stress" },
  stress_likely: { tone: "alert", label: "Stress likely" },
};

export function WaterBalancePanel({ slug, aoiId, canEdit, canLog, timeZone }: { slug: string; aoiId: string; canEdit: boolean; canLog: boolean; timeZone: string }) {
  const base = `${orgApi(slug)}/aois/${aoiId}`;
  const [wb, setWb] = useState<WaterBalance | null>(null);
  const [ag, setAg] = useState<Agronomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    Promise.all([api<WaterBalance>(`${base}/water-balance`), api<Agronomy>(`${base}/agronomy`)])
      .then(([w, a]) => {
        setWb(w);
        setAg(a);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "The water balance could not be loaded."));
  }, [base]);
  useEffect(load, [load]);

  if (error) return <section aria-label="Crop water balance"><Notice tone="error">{error}</Notice></section>;
  if (!wb || !ag) return <section aria-label="Crop water balance"><p className="text-[0.75rem] text-bone-50/55" role="status">Loading the water balance…</p></section>;

  const c = wb.current;
  return (
    <section aria-label="Crop water balance" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="t-eyebrow text-bone-50/55">Crop water balance · planning estimate</p>
        {canEdit && !editing ? <Button size="sm" onClick={() => setEditing(true)}>{wb.status === "insufficient_inputs" ? "Add field details" : "Edit field details"}</Button> : null}
      </div>

      {editing ? (
        <AgronomyForm base={base} ag={ag} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      ) : null}

      {wb.status === "estimated" && c ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
            <Badge tone={CONDITION[c.condition].tone}>{CONDITION[c.condition].label}</Badge>
            <span className="text-bone-50/85">
              Depletion {c.depletionMm} mm{c.depletionRangeMm ? ` (${c.depletionRangeMm[0]}–${c.depletionRangeMm[1]})` : ""} of {c.tawMm} mm available · readily available {c.rawMm} mm
            </span>
          </div>
          <p className="text-[0.75rem] text-bone-50/65">{wb.statusText}</p>
          {wb.weather?.et0 ? (
            <p className={`text-[0.6875rem] ${/non-commercial/i.test(wb.weather.et0.licence) ? "text-data-amber" : "text-bone-50/60"}`}>
              Weather: {wb.weather.et0.provider === "open-meteo" ? "Open-Meteo" : "NOAA NWS"} ({wb.weather.et0.recordKind}) · {wb.weather.et0.licence}
            </p>
          ) : null}
          <DepletionChart series={wb.series} />
          <p className="text-[0.75rem] text-bone-50/75">{wb.recommendation}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.6875rem]">
            <dt className="text-bone-50/55">Through</dt>
            <dd className="text-bone-50/80">{formatDate(`${c.date}T12:00:00Z`, timeZone)} · {c.stage} stage · Ks {c.ks}</dd>
            <dt className="text-bone-50/55">Season totals</dt>
            <dd className="text-bone-50/80">
              ETo {wb.totals!.et0Mm} mm · crop use {wb.totals!.etcAdjMm} mm · rain {wb.totals!.precipMm} mm ({wb.totals!.effectivePrecipMm} effective) · irrigation {wb.totals!.irrigationMm} mm
            </dd>
          </dl>
        </>
      ) : (
        <Notice tone={wb.status === "insufficient_inputs" ? "info" : "warn"}>
          {wb.statusText}
          {wb.missingInputs.length ? (
            <ul className="mt-1 list-disc pl-4">
              {wb.missingInputs.map((m) => <li key={m.input}><span className="font-medium">{m.input}</span>: {m.why}</li>)}
            </ul>
          ) : null}
          {wb.status === "insufficient_weather" ? <span className="mt-1 block">{wb.recommendation}</span> : null}
        </Notice>
      )}

      <details className="text-[0.6875rem] text-bone-50/65">
        <summary className="cursor-pointer text-bone-50/75">Inputs, sources and limitations</summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {wb.inputs.crop ? (<><dt className="text-bone-50/55">Crop</dt><dd>{wb.inputs.crop.label} — {wb.inputs.crop.source}</dd></>) : null}
          {wb.inputs.plantingDate ? (<><dt className="text-bone-50/55">Planted</dt><dd>{wb.inputs.plantingDate.value}</dd></>) : null}
          {wb.inputs.stages ? (<><dt className="text-bone-50/55">Stages</dt><dd>{wb.inputs.stages.days.init}/{wb.inputs.stages.days.dev}/{wb.inputs.stages.days.mid}/{wb.inputs.stages.days.late} days — {wb.inputs.stages.source}</dd></>) : null}
          {wb.inputs.availableWater ? (<><dt className="text-bone-50/55">Soil water</dt><dd>{wb.inputs.availableWater.mmPerM} mm per m — {wb.inputs.availableWater.source}</dd></>) : null}
          {wb.inputs.rootDepth ? (<><dt className="text-bone-50/55">Root depth</dt><dd>{wb.inputs.rootDepth.central.toFixed(2)} m{wb.inputs.rootDepth.range ? ` (${wb.inputs.rootDepth.range[0]}–${wb.inputs.rootDepth.range[1]} m)` : ""} — {wb.inputs.rootDepth.source}</dd></>) : null}
          {wb.weather?.et0 ? (<><dt className="text-bone-50/55">ETo</dt><dd>{wb.weather.et0.method} · {wb.weather.et0.provider}, {wb.weather.et0.recordKind} · {wb.weather.et0.licence}</dd></>) : null}
          {wb.weather?.precipitation ? (<><dt className="text-bone-50/55">Rain</dt><dd>{wb.weather.precipitation.method} · {wb.weather.precipitation.provider} · {wb.weather.presentDays} of {wb.weather.expectedDays} days present</dd></>) : null}
          <dt className="text-bone-50/55">Method</dt>
          <dd>{wb.method.id}@{wb.method.version} — {wb.method.reference}</dd>
        </dl>
        <p className="mt-1 text-bone-50/55">Assumptions</p>
        <ul className="list-disc pl-4">{wb.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        <p className="mt-1 text-bone-50/55">Limitations</p>
        <ul className="list-disc pl-4">{wb.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>

      <IrrigationLog base={base} ag={ag} canLog={canLog} timeZone={timeZone} onChanged={load} />
    </section>
  );
}

/** Depletion (mm below field capacity, downward) against the readily and totally available water. */
function DepletionChart({ series }: { series: WaterBalance["series"] }) {
  if (series.length < 2) return null;
  const W = 320;
  const H = 96;
  // 10 % headroom below the total available water so its line stays visible.
  const max = Math.max(...series.map((d) => d.tawMm), 1) * 1.1;
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (mm: number) => (mm / max) * H;
  const line = (f: (d: (typeof series)[number]) => number) => series.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f(d)).toFixed(1)}`).join(" ");
  const first = series[0]!;
  const last = series.at(-1)!;
  return (
    <figure className="flex flex-col gap-1">
      <svg viewBox={`0 -4 ${W} ${H + 8}`} className="h-24 w-full" role="img" aria-label={`Root-zone depletion from ${first.date} to ${last.date}: ${last.depletionMm} mm on the last day, readily available water ${last.rawMm} mm, total ${last.tawMm} mm.`}>
        <line x1="0" x2={W} y1="0" y2="0" stroke="#f2f1ed" strokeOpacity="0.25" strokeWidth="1" />
        <text x="2" y="9" fontSize="8" fill="#f2f1ed" fillOpacity="0.6">field capacity (0 mm)</text>
        <text x="2" y={H + 2} fontSize="8" fill="#f2f1ed" fillOpacity="0.6">{Math.round(max)} mm</text>
        <path d={line((d) => d.rawMm)} fill="none" stroke="#e9b949" strokeWidth="1" strokeDasharray="4 3" />
        <path d={line((d) => d.tawMm)} fill="none" stroke="#e5544b" strokeWidth="1" strokeDasharray="2 3" />
        <path d={line((d) => d.depletionMm)} fill="none" stroke="#5fb4d6" strokeWidth="1.5" />
        {series.map((d, i) => (d.irrigationMm > 0 ? <circle key={d.date} cx={x(i)} cy={y(d.depletionMm)} r="2.5" fill="#8dbf63" /> : null))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-3 text-[0.6875rem] text-bone-50/60">
        <span><span aria-hidden="true" className="text-data-water">━</span> depletion (down = drier)</span>
        <span><span aria-hidden="true" className="text-data-amber">╍</span> readily available</span>
        <span><span aria-hidden="true" className="text-data-alert">┅</span> total available</span>
        <span>{first.date} → {last.date}</span>
      </figcaption>
    </figure>
  );
}

function AgronomyForm({ base, ag, onCancel, onSaved }: { base: string; ag: Agronomy; onCancel: () => void; onSaved: () => void }) {
  const [crop, setCrop] = useState(ag.crop ?? "");
  const [plantingDate, setPlantingDate] = useState(ag.plantingDate ?? "");
  const [soilMode, setSoilMode] = useState<"texture" | "measured">(ag.availableWaterMmPerM !== null ? "measured" : "texture");
  const [soilTexture, setSoilTexture] = useState(ag.soilTexture ?? "");
  const [aw, setAw] = useState(ag.availableWaterMmPerM?.toString() ?? "");
  const [rootDepth, setRootDepth] = useState(ag.rootDepthM?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`${base}/agronomy`, {
        method: "PUT",
        json: {
          crop: crop || null,
          plantingDate: plantingDate || null,
          stageDays: ag.stageDays,
          soilTexture: soilMode === "texture" ? soilTexture || null : null,
          availableWaterMmPerM: soilMode === "measured" && aw ? Number(aw) : null,
          rootDepthM: rootDepth ? Number(rootDepth) : null,
          notes: ag.notes,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the field details.");
    } finally {
      setSaving(false);
    }
  };
  const label = "flex flex-col gap-0.5 text-[0.6875rem] text-bone-50/65";
  return (
    <form method="post" onSubmit={save} className="flex flex-col gap-2 rounded-[3px] border border-bone-50/10 p-2" aria-label="Field details for the water balance">
      <label className={label}>
        Crop
        <select className={inputClass} value={crop} onChange={(e) => setCrop(e.target.value)}>
          <option value="">Not set</option>
          {Object.values(CROP_PROFILES).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className={label}>
        Planting date
        <input type="date" className={inputClass} value={plantingDate} onChange={(e) => setPlantingDate(e.target.value)} />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-[0.6875rem] text-bone-50/65">Soil</legend>
        <div className="flex gap-3 text-[0.6875rem]">
          <label className="flex items-center gap-1"><input type="radio" checked={soilMode === "texture"} onChange={() => setSoilMode("texture")} /> Texture class</label>
          <label className="flex items-center gap-1"><input type="radio" checked={soilMode === "measured"} onChange={() => setSoilMode("measured")} /> Surveyed available water</label>
        </div>
        {soilMode === "texture" ? (
          <select aria-label="Soil texture" className={inputClass} value={soilTexture} onChange={(e) => setSoilTexture(e.target.value)}>
            <option value="">Not set</option>
            {Object.values(SOIL_TEXTURES).map((t) => <option key={t.id} value={t.id}>{t.label} (typical {textureAvailableWaterMmPerM(t)} mm/m)</option>)}
          </select>
        ) : (
          <input aria-label="Available water, mm per m of soil" type="number" min={20} max={300} step={1} className={inputClass} placeholder="mm per m, e.g. from a soil survey" value={aw} onChange={(e) => setAw(e.target.value)} />
        )}
      </fieldset>
      <label className={label}>
        Rooting depth, m (optional; FAO-56 range used when empty)
        <input type="number" min={0.1} max={3} step={0.05} className={inputClass} value={rootDepth} onChange={(e) => setRootDepth(e.target.value)} />
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function IrrigationLog({ base, ag, canLog, timeZone, onChanged }: { base: string; ag: Agronomy; canLog: boolean; timeZone: string; onChanged: () => void }) {
  const [date, setDate] = useState("");
  const [mm, setMm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`${base}/irrigation`, { method: "POST", json: { appliedOn: date, amountMm: Number(mm) } });
      setDate("");
      setMm("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log the irrigation.");
    }
  };
  const remove = async (id: string) => {
    try {
      await api(`${base}/irrigation/${id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the irrigation event.");
    }
  };
  if (!canLog && ag.irrigation.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[0.6875rem] text-bone-50/55">Irrigation logged ({ag.irrigation.length})</p>
      {ag.irrigation.length ? (
        <ul className="flex flex-col text-[0.6875rem] text-bone-50/80">
          {ag.irrigation.slice(-8).map((ev) => (
            <li key={ev.id} className="flex items-center justify-between gap-2">
              <span>{formatDate(`${ev.appliedOn}T12:00:00Z`, timeZone)} · {ev.amountMm} mm{ev.note ? ` · ${ev.note}` : ""}</span>
              {canLog ? <button type="button" className="underline text-bone-50/60" onClick={() => remove(ev.id)} aria-label={`Delete irrigation on ${ev.appliedOn}`}>Delete</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canLog ? (
        <form method="post" onSubmit={add} className="flex flex-wrap items-end gap-1" aria-label="Log irrigation">
          <input aria-label="Date applied" type="date" required className={`${inputClass} w-auto`} value={date} onChange={(e) => setDate(e.target.value)} />
          <input aria-label="Net amount, mm" type="number" required min={0.1} max={300} step={0.1} placeholder="mm" className={`${inputClass} w-20`} value={mm} onChange={(e) => setMm(e.target.value)} />
          <Button type="submit" size="sm">Log irrigation</Button>
        </form>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
