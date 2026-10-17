/**
 * Sensor (imagery collection) helpers shared by charts and summaries.
 *
 * Index values from different collections are not comparable: Sentinel-2 and
 * Landsat differ in band response, resolution, and atmospheric correction.
 * A time series therefore follows one collection, and observations of the
 * same satellite pass (several tiles over one area) count as one point.
 */

const LABELS: Record<string, string> = {
  "sentinel-2-l2a": "Sentinel-2",
  "landsat-c2-l2": "Landsat",
  "sentinel-1-rtc": "Sentinel-1",
  "esa-worldcover": "ESA WorldCover",
  "io-lulc-annual-v02": "IO land cover",
};

export function sensorLabel(collection: string | null | undefined): string {
  if (!collection) return "unknown sensor";
  return LABELS[collection] ?? collection;
}

/** Observations closer together than this are one satellite pass. */
export const SAME_PASS_MS = 60 * 60 * 1000;

type SeriesObservation = {
  observedAt: string;
  status: "valid" | "unusable";
  asset: { collection: string };
  metrics: Record<string, unknown>;
  quality: { valid_fraction?: number } & Record<string, unknown>;
};

const usableShare = (o: SeriesObservation): number =>
  o.status !== "valid" ? -1 : ((o.metrics.valid_fraction as number | undefined) ?? o.quality.valid_fraction ?? 0);

/** Collections present, most recent valid observation's collection first. */
export function sensorsIn<T extends SeriesObservation>(observations: T[]): string[] {
  const ordered = [...observations].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const valid = ordered.filter((o) => o.status === "valid").map((o) => o.asset.collection);
  const rest = ordered.map((o) => o.asset.collection);
  return [...new Set([...valid, ...rest])];
}

/**
 * One collection's observations in time order, one per satellite pass: of
 * observations within SAME_PASS_MS of each other, the one with the largest
 * usable share is kept (a valid image always beats an unusable one).
 */
export function sensorSeries<T extends SeriesObservation>(observations: T[], collection: string): T[] {
  const own = observations
    .filter((o) => o.asset.collection === collection)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const out: T[] = [];
  let passStart = Number.NEGATIVE_INFINITY;
  for (const o of own) {
    const t = Date.parse(o.observedAt);
    const last = out[out.length - 1];
    if (last && t - passStart < SAME_PASS_MS) {
      if (usableShare(o) > usableShare(last)) out[out.length - 1] = o;
      continue;
    }
    passStart = t;
    out.push(o);
  }
  return out;
}
