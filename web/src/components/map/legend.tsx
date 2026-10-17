import type { RasterRef } from "@/server/analytics/types";

/**
 * Detection identity colors — fixed categorical order from the validated
 * dark palette (lightness band, chroma, CVD and contrast checks pass on the
 * map surface). Every swatch is paired with a text label; color is never the
 * only cue.
 */
export const DETECTION_COLORS: Record<string, { color: string; label: string; dashed?: boolean }> = {
  vegetation_decline: { color: "#d95926", label: "Vegetation decline (candidate)" },
  vegetation_gain: { color: "#199e70", label: "Vegetation gain (candidate)" },
  new_water_candidate: { color: "#3987e5", label: "New surface water (candidate)" },
  water_loss: { color: "#c98500", label: "Surface water loss (candidate)" },
  // Not another hue: the categorical palette has no sixth colour that stays
  // distinguishable from all five on a map (checked with the palette
  // validator), and zones are a different kind of finding (one date, not a
  // change). They are drawn as a dashed neutral outline instead.
  low_vigor_zone: { color: "#f2f1ed", label: "Low-vigour zone (within-field, one date)", dashed: true },
  other: { color: "#9085e9", label: "Other" },
};

/** Legend / inspector swatch: filled square, or a dashed outline for dashed types. */
export function DetectionSwatch({ type }: { type: string }) {
  const e = DETECTION_COLORS[type] ?? DETECTION_COLORS.other!;
  return e.dashed ? (
    <span aria-hidden="true" className="size-2.5 rounded-[1px] border border-dashed" style={{ borderColor: e.color, background: "rgba(242, 241, 237, 0.14)" }} />
  ) : (
    <span aria-hidden="true" className="size-2.5 rounded-[1px]" style={{ background: e.color }} />
  );
}

export function detectionColor(type: string): string {
  return (DETECTION_COLORS[type] ?? DETECTION_COLORS.other!).color;
}

export function DetectionLegend({ types }: { types?: string[] }) {
  const entries = Object.entries(DETECTION_COLORS).filter(([t]) => !types || types.includes(t));
  return (
    <ul className="flex flex-col gap-1">
      {entries.map(([t, v]) => (
        <li key={t} className="flex items-center gap-2 text-[0.75rem] text-bone-50/75">
          <DetectionSwatch type={t} />
          {v.label}
        </li>
      ))}
    </ul>
  );
}

/** Continuous legend for a rendered raster (NDVI, ΔNDVI, water…). */
export function RasterLegend({ legend }: { legend: RasterRef["legend"] }) {
  const stops = legend.stops ?? [];
  if (stops.length === 0) return null;
  if (legend.kind === "landcover" || legend.kind === "water_mask" || legend.kind === "true_color") {
    return (
      <div className="flex flex-col gap-1">
        {stops.map((s) => (
          <div key={`${s.label}-${s.value}`} className="flex items-center gap-2 text-[0.6875rem] text-bone-50/65">
            <span aria-hidden="true" className="size-2.5 rounded-[1px] border border-bone-50/20" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      </div>
    );
  }
  const continuous = stops.filter((s) => !/mask|no data|cloud|excluded/i.test(s.label ?? ""));
  const categorical = stops.filter((s) => /mask|no data|cloud|excluded/i.test(s.label ?? ""));
  const min = continuous[0]?.value ?? 0;
  const max = continuous.at(-1)?.value ?? 1;
  const gradient = continuous.length > 1
    ? `linear-gradient(to right, ${continuous.map((s) => `${s.color} ${(((s.value - min) / (max - min || 1)) * 100).toFixed(1)}%`).join(", ")})`
    : continuous[0]?.color;
  return (
    <div className="flex flex-col gap-1.5">
      {continuous.length > 1 ? (
        <>
          <div className="h-2 rounded-[1px]" style={{ background: gradient }} aria-hidden="true" />
          <div className="t-mono flex justify-between text-[0.625rem] text-bone-50/55">
            <span>{continuous[0]?.label ?? min}</span>
            {continuous.length > 2 ? <span>{continuous[Math.floor(continuous.length / 2)]?.label ?? ""}</span> : null}
            <span>{continuous.at(-1)?.label ?? max}</span>
          </div>
        </>
      ) : null}
      {categorical.concat(continuous.length <= 1 ? continuous : []).map((s) => (
        <div key={`${s.label}-${s.value}`} className="flex items-center gap-2 text-[0.6875rem] text-bone-50/65">
          <span aria-hidden="true" className="size-2.5 rounded-[1px] border border-bone-50/20" style={{ background: s.color }} />
          {s.label}
        </div>
      ))}
    </div>
  );
}
