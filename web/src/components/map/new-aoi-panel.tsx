"use client";

import { useState } from "react";
import { api, ApiError, orgApi } from "@/components/map/api";
import type { Aoi } from "@/components/map/types";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { AOI_KIND_LABEL, AOI_KINDS, type AoiKind } from "@/lib/aoi-config";
import { formatArea, geometryArea, type Geometry } from "@/lib/geo";

export function NewAoiPanel({
  slug,
  geometry,
  defaultKind,
  parents,
  onCreated,
  onCancel,
}: {
  slug: string;
  geometry: Geometry;
  defaultKind: AoiKind;
  parents: { id: string; name: string }[];
  onCreated: (aoi: Aoi) => void;
  onCancel: () => void;
}) {
  const needsBuffer = geometry.type === "Point" || geometry.type === "LineString";
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AoiKind>(geometry.type === "Point" ? "public_asset" : geometry.type === "LineString" ? "road_corridor" : defaultKind);
  const [bufferM, setBufferM] = useState(geometry.type === "Point" ? 100 : 30);
  const [parentId, setParentId] = useState("");
  const [description, setDescription] = useState("");
  const [crop, setCrop] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const area = needsBuffer ? (geometry.type === "Point" ? Math.PI * bufferM * bufferM : null) : geometryArea(geometry);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const aoi = await api<Aoi>(`${orgApi(slug)}/aois`, {
        method: "POST",
        json: {
          name,
          kind,
          description,
          geometry,
          ...(needsBuffer ? { bufferM } : {}),
          parentId: parentId || null,
          metadata: crop ? { crop } : {},
        },
      });
      onCreated(aoi);
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
      } else setError("Could not save the area.");
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 p-4">
      <div>
        <p className="t-eyebrow text-bone-50/45">New area of interest</p>
        <p className="mt-1 text-[0.8125rem] text-bone-50/65">
          {geometry.type === "Point" ? "Point" : geometry.type === "LineString" ? "Line" : "Polygon"} drawn
          {area !== null ? ` · ${formatArea(area)}` : ""}. Saving starts monitoring and queues a search of the last 180 days of imagery.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Name" htmlFor="aoi-name" error={fields.name}>
        <input id="aoi-name" required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
      </Field>
      <Field label="Type" htmlFor="aoi-kind">
        <select id="aoi-kind" value={kind} onChange={(e) => setKind(e.target.value as AoiKind)} className={inputClass}>
          {AOI_KINDS.map((k) => <option key={k} value={k}>{AOI_KIND_LABEL[k]}</option>)}
        </select>
      </Field>
      {needsBuffer ? (
        <Field label="Buffer distance (m)" htmlFor="aoi-buffer" hint={geometry.type === "Point" ? "Monitors a circle of this radius." : "Monitors a corridor this far either side of the line."} error={fields.bufferM}>
          <input id="aoi-buffer" type="number" min={10} max={50000} value={bufferM} onChange={(e) => setBufferM(Number(e.target.value))} className={inputClass} />
        </Field>
      ) : null}
      {parents.length && (kind === "field" || kind === "construction_site" || kind === "public_asset") ? (
        <Field label="Part of" htmlFor="aoi-parent" hint="E.g. the farm this field belongs to.">
          <select id="aoi-parent" value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputClass}>
            <option value="">—</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      ) : null}
      {kind === "field" ? (
        <Field label="Crop (optional)" htmlFor="aoi-crop">
          <input id="aoi-crop" value={crop} maxLength={80} onChange={(e) => setCrop(e.target.value)} className={inputClass} placeholder="e.g. cotton, peanuts, soybeans" />
        </Field>
      ) : null}
      <Field label="Description (optional)" htmlFor="aoi-desc">
        <textarea id="aoi-desc" rows={2} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save and start monitoring"}</Button>
        <Button variant="ghost" onClick={onCancel}>Discard</Button>
      </div>
    </form>
  );
}
