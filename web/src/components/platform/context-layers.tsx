"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Button, Notice } from "@/components/platform/ui";

const CATEGORIES = [
  ["roads", "Roads"],
  ["buildings", "Buildings"],
  ["bridges", "Bridges"],
  ["critical_facilities", "Critical facilities (hospitals, schools, fire, police, utilities)"],
  ["waterways", "Waterways"],
] as const;

export function OsmImportForm({ slug, aoiId }: { slug: string; aoiId: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(["roads", "buildings", "critical_facilities"]));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {msg ? <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice> : null}
      <div className="grid gap-1 sm:grid-cols-2">
        {CATEGORIES.map(([id, label]) => (
          <label key={id} className="flex items-center gap-2 text-[0.8125rem]">
            <input type="checkbox" checked={selected.has(id)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(id); else n.delete(id); setSelected(n); }} />
            {label}
          </label>
        ))}
      </div>
      <p className="text-[0.75rem] text-bone-50/45">Data © OpenStreetMap contributors (ODbL). Imported for this area&apos;s bounding box; the import replaces an earlier one with the same categories.</p>
      <Button
        size="sm"
        className="self-start"
        disabled={pending || selected.size === 0}
        onClick={async () => {
          setPending(true);
          try {
            await api(`${orgApi(slug)}/aois/${aoiId}/osm-import`, { method: "POST", json: { categories: [...selected] } });
            setMsg({ ok: true, text: "Import queued. The layer appears here and in the map's Layers tab when the worker finishes." });
          } catch (e) {
            setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Could not queue the import." });
          } finally {
            setPending(false);
          }
        }}
      >
        Import OpenStreetMap context
      </Button>
    </div>
  );
}

export function DeleteLayerButton({ slug, layerId }: { slug: string; layerId: string }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        if (!confirm("Remove this reference layer?")) return;
        await api(`${orgApi(slug)}/reference-layers/${layerId}`, { method: "DELETE" });
        router.refresh();
      }}
    >
      Remove
    </Button>
  );
}
