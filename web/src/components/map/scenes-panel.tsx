"use client";

/**
 * Saved scenes and presets for the map workspace. A scene is view state only;
 * restoring one re-fetches everything through the normal permission-checked
 * APIs (the server already removed any area this viewer cannot see).
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Badge, Button, inputClass } from "@/components/platform/ui";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { SCENE_PRESETS, type ScenePreset, type SceneState, type SceneStateInput } from "@/lib/scenes";

export type SavedScene = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "org";
  state: SceneState;
  aoiUnavailable: boolean;
  createdByName: string | null;
  createdAt: string;
  canDelete: boolean;
};

export function ScenesPanel({
  slug,
  timeZone,
  canShare,
  hasArea,
  capture,
  onApply,
  onPreset,
}: {
  slug: string;
  timeZone: string;
  /** May share scenes with the organization (notes.write). */
  canShare: boolean;
  hasArea: boolean;
  capture: () => SceneStateInput | null;
  onApply: (s: SavedScene) => void;
  onPreset: (p: ScenePreset) => void;
}) {
  const [items, setItems] = useState<SavedScene[] | null>(null);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"org" | "private">(canShare ? "org" : "private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    let cancelled = false;
    api<{ items: SavedScene[] }>(`${orgApi(slug)}/scenes`)
      .then((r) => !cancelled && setItems(r.items))
      .catch((e: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(e instanceof ApiError ? e.message : "Could not load saved scenes.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug, version]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const state = capture();
    if (!state) return setError("The map is still loading.");
    setBusy(true);
    setError(null);
    try {
      await api(`${orgApi(slug)}/scenes`, { method: "POST", json: { name: name.trim(), visibility, state } });
      setName("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the scene.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: SavedScene) {
    if (!window.confirm(`Delete the scene “${s.name}”?`)) return;
    try {
      await api(`${orgApi(slug)}/scenes/${s.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the scene.");
    }
  }

  return (
    <div className="flex flex-col gap-4 p-3 text-[0.75rem]">
      <form onSubmit={save} className="flex flex-col gap-2" aria-label="Save the current view">
        <p className="t-eyebrow text-bone-50/45">Save the current view</p>
        <input aria-label="Scene name" className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. North field — July check" />
        <div className="flex items-center justify-between gap-2">
          <select aria-label="Who can open this scene" className={cn(inputClass, "w-auto py-0.5 text-[0.75rem]")} value={visibility} onChange={(e) => setVisibility(e.target.value as "org" | "private")}>
            {canShare ? <option value="org">Organization</option> : null}
            <option value="private">Only me</option>
          </select>
          <Button size="sm" variant="primary" type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save scene"}</Button>
        </div>
        <p className="text-[0.6875rem] text-bone-50/45">Saves the map position, projection, layers, selected area, displayed image, chart index, and change filters — not the data. Anyone opening it sees only what their own access allows.</p>
      </form>
      {error ? <p role="alert" className="text-data-amber">{error}</p> : null}

      <section aria-label="Saved scenes" className="flex flex-col gap-1">
        <p className="t-eyebrow mb-1 text-bone-50/45">Saved scenes</p>
        {items === null ? <p className="text-bone-50/45">Loading…</p> : null}
        {items?.length === 0 ? <p className="text-bone-50/45">No saved scenes yet.</p> : null}
        <ul className="flex flex-col">
          {items?.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-2 border-b border-bone-50/[0.05] py-1.5">
              <button className="min-w-0 flex-1 text-left hover:text-bone-50" onClick={() => onApply(s)}>
                <span className="block truncate text-[0.8125rem] text-bone-50/90">{s.name}</span>
                <span className="block text-[0.6875rem] text-bone-50/45">
                  {s.createdByName ?? "Unknown"} · {formatDate(s.createdAt, timeZone)}
                  {s.state.projection === "globe" ? " · globe" : ""}
                  {s.aoiUnavailable ? " · its area is not available to you" : ""}
                </span>
              </button>
              <span className="flex shrink-0 items-center gap-1">
                {s.visibility === "private" ? <Badge tone="muted">Only me</Badge> : null}
                {s.canDelete ? (
                  <button aria-label={`Delete scene ${s.name}`} className="p-1 text-bone-50/40 hover:text-bone-50" onClick={() => remove(s)}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Presets" className="flex flex-col gap-1">
        <p className="t-eyebrow mb-1 text-bone-50/45">Presets</p>
        {SCENE_PRESETS.map((p) => {
          const blocked = p.needsArea && !hasArea;
          return (
            <button
              key={p.id}
              disabled={blocked}
              onClick={() => onPreset(p)}
              className={cn("rounded-[2px] px-2 py-1.5 text-left hover:bg-bone-50/[0.05]", blocked && "cursor-not-allowed opacity-45 hover:bg-transparent")}
            >
              <span className="block text-bone-50/85">{p.label}</span>
              <span className="block text-[0.6875rem] text-bone-50/45">{p.description}{blocked ? " Select an area first." : ""}</span>
            </button>
          );
        })}
      </section>
    </div>
  );
}
