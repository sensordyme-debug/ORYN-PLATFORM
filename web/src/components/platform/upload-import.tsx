"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { importUploadAction } from "@/app/(platform)/app/[org]/areas/actions";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { AOI_KIND_LABEL, AOI_KINDS, type AoiKind } from "@/lib/aoi-config";
import { formatArea } from "@/lib/geo";

type Parsed = { uploadId: string; status: string; features: { index: number; name: string | null; areaM2: number; geometry: { type: string } }[]; errors: string[]; skipped: number };

export function UploadImport({ slug, defaultKind, parents, maxMb }: { slug: string; defaultKind: AoiKind; parents: { id: string; name: string }[]; maxMb: number }) {
  const router = useRouter();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [kind, setKind] = useState<AoiKind>(defaultKind);
  const [mode, setMode] = useState<"aois" | "layer">("aois");
  const [layerKind, setLayerKind] = useState("permits");
  const [layerName, setLayerName] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onFile(file: File) {
    setError(null);
    setParsed(null);
    if (file.size > maxMb * 1e6) {
      setError(`The file is larger than ${maxMb} MB.`);
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    setPending(true);
    try {
      const r = await fetch(`${orgApi(slug)}/uploads`, { method: "POST", body: fd, credentials: "same-origin" });
      const body = (await r.json()) as Parsed & { error?: { message: string } };
      if (!r.ok && body.error) throw new ApiError(r.status, "upload", body.error.message);
      setParsed(body);
      setSelected(new Set(body.features.map((f) => f.index)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The upload failed.");
    } finally {
      setPending(false);
    }
  }

  async function doImport() {
    if (!parsed) return;
    setPending(true);
    if (mode === "layer") {
      try {
        await api(`${orgApi(slug)}/reference-layers`, { method: "POST", json: { uploadId: parsed.uploadId, name: layerName || "Uploaded layer", kind: layerKind } });
        router.push(`/app/${slug}/map`);
      } catch (e) {
        setPending(false);
        setError(e instanceof ApiError ? e.message : "The import failed.");
      }
      return;
    }
    const r = await importUploadAction(slug, { uploadId: parsed.uploadId, indices: [...selected], kind, parentId: parentId || null });
    setPending(false);
    if (!r.ok) setError(r.error);
    else router.push(`/app/${slug}/areas`);
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        aria-label="GeoJSON file"
        disabled={pending}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        className="text-[0.8125rem] file:mr-3 file:rounded-[3px] file:border file:border-bone-50/20 file:bg-transparent file:px-3 file:py-1 file:text-bone-50"
      />
      <p className="text-[0.75rem] text-bone-50/45">GeoJSON in WGS 84 (EPSG:4326), up to {maxMb} MB. Polygons, multipolygons, points, and lines are accepted; points and lines are buffered by 50 m.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {parsed ? (
        <div className="flex flex-col gap-3">
          {parsed.errors.length ? <Notice tone="warn" title={`${parsed.skipped} feature(s) skipped`}><ul className="list-disc pl-4">{parsed.errors.map((e) => <li key={e}>{e}</li>)}</ul></Notice> : null}
          {parsed.features.length ? (
            <>
              <div className="max-h-64 overflow-y-auto rounded-[3px] border border-bone-50/10">
                {parsed.features.map((f) => (
                  <label key={f.index} className="flex items-center gap-2 border-b border-bone-50/[0.05] px-3 py-1.5 text-[0.8125rem]">
                    <input type="checkbox" checked={selected.has(f.index)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(f.index); else n.delete(f.index); setSelected(n); }} />
                    <span className="flex-1">{f.name ?? `Feature ${f.index + 1}`}</span>
                    <span className="text-bone-50/45">{f.geometry.type} · {f.areaM2 ? formatArea(f.areaM2) : "buffered"}</span>
                  </label>
                ))}
              </div>
              <div className="flex gap-4 text-[0.8125rem]">
                <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "aois"} onChange={() => setMode("aois")} /> Areas to monitor</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "layer"} onChange={() => setMode("layer")} /> Reference layer (permits, parcels…)</label>
              </div>
              {mode === "layer" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Layer name" htmlFor="imp-lname"><input id="imp-lname" value={layerName} onChange={(e) => setLayerName(e.target.value)} className={inputClass} placeholder="Building permits 2026" /></Field>
                  <Field label="Layer type" htmlFor="imp-lkind">
                    <select id="imp-lkind" value={layerKind} onChange={(e) => setLayerKind(e.target.value)} className={inputClass}>
                      {["permits", "parcels", "boundary", "infrastructure", "land_use", "custom"].map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}
                    </select>
                  </Field>
                </div>
              ) : null}
              <div className={mode === "layer" ? "hidden" : "grid gap-3 sm:grid-cols-2"}>
                <Field label="Import as" htmlFor="imp-kind">
                  <select id="imp-kind" value={kind} onChange={(e) => setKind(e.target.value as AoiKind)} className={inputClass}>
                    {AOI_KINDS.map((k) => <option key={k} value={k}>{AOI_KIND_LABEL[k]}</option>)}
                  </select>
                </Field>
                {parents.length ? (
                  <Field label="Part of (optional)" htmlFor="imp-parent">
                    <select id="imp-parent" value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputClass}>
                      <option value="">—</option>
                      {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </Field>
                ) : null}
              </div>
              <Button variant="primary" disabled={pending || (mode === "aois" && selected.size === 0)} onClick={doImport}>
                {pending ? "Importing…" : mode === "layer" ? `Import ${parsed.features.length} features as a reference layer` : `Import ${selected.size} area${selected.size === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
