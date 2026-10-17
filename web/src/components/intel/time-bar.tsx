"use client";

/**
 * Timeline for the intelligence globe: live clock, play/pause, speed, and a
 * scrubber from 7 days ago to 1 day ahead. Looking back shows earthquakes as
 * they were recorded and satellites where their orbits put them; future
 * times show predicted satellite positions only. Nothing is fabricated for
 * times a source has no record of.
 */
import { useEffect, useState } from "react";
import { Pause, Play, Radio } from "lucide-react";
import type { GlobeScene } from "@/components/intel/globe-scene";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";

const SPEEDS = [1, 10, 60, 600, 3600] as const;
const BACK_MS = 7 * 86_400_000;
const AHEAD_MS = 86_400_000;

export function TimeBar({ scene, timeZone }: { scene: GlobeScene; timeZone: string }) {
  const [{ t, now }, setClock] = useState(() => ({ t: scene.timeMs(), now: Date.now() }));
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [anchor] = useState(() => Date.now());

  useEffect(() => scene.onTick((ms) => setClock({ t: ms, now: Date.now() })), [scene]);

  const live = playing && speed === 1 && Math.abs(t - now) < 15_000;
  const offset = t - now;
  const offsetLabel = Math.abs(offset) < 15_000 ? "now" : `${offset < 0 ? "−" : "+"}${formatOffset(Math.abs(offset))}`;

  const goLive = () => {
    scene.setTime(Date.now());
    scene.setMultiplier(1);
    scene.setPlaying(true);
    setSpeed(1);
    setPlaying(true);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.75rem]" aria-label="Timeline">
      <button onClick={goLive} aria-pressed={live} className={cn("flex items-center gap-1 rounded-[3px] border px-2 py-0.5", live ? "border-data-veg/50 text-data-veg" : "border-bone-50/20 text-bone-50/70 hover:border-bone-50/50")}>
        <Radio className="size-3" aria-hidden="true" /> {live ? "Live" : "Go live"}
      </button>
      <button
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          scene.setPlaying(!playing);
          setPlaying(!playing);
        }}
        className="rounded-[3px] border border-bone-50/20 p-1 hover:border-bone-50/50"
      >
        {playing ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
      </button>
      <label className="flex items-center gap-1 text-bone-50/60">
        Speed
        <select
          aria-label="Playback speed"
          className="rounded-[3px] border border-bone-50/15 bg-ink-950 px-1 py-0.5 text-bone-50"
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value) as (typeof SPEEDS)[number];
            setSpeed(v);
            scene.setMultiplier(v);
          }}
        >
          {SPEEDS.map((s) => <option key={s} value={s}>{s === 1 ? "1× (real time)" : `${s}×`}</option>)}
        </select>
      </label>
      <span className="t-mono text-bone-50/85" aria-live="off">{formatDateTime(new Date(t), timeZone)}</span>
      <span className="text-bone-50/45">({offsetLabel})</span>
      <input
        type="range"
        aria-label="Shown time"
        className="min-w-[160px] flex-1"
        min={anchor - BACK_MS}
        max={anchor + AHEAD_MS}
        step={60_000}
        value={Math.min(anchor + AHEAD_MS, Math.max(anchor - BACK_MS, t))}
        onChange={(e) => scene.setTime(Number(e.target.value))}
      />
    </div>
  );
}

function formatOffset(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 6) / 10;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 2.4) / 10} d`;
}
