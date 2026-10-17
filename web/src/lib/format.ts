/**
 * Formatting for timestamps, ages, and numbers. Every time shown in the
 * platform says which clock it is (acquired, processed, …) at the call site;
 * these helpers keep the rendering consistent and always include the zone.
 */

export type Dateish = Date | string | number | null | undefined;

export function toDate(d: Dateish): Date | null {
  if (d === null || d === undefined || d === "") return null;
  const v = d instanceof Date ? d : new Date(d);
  return Number.isNaN(v.getTime()) ? null : v;
}

export function formatDateTime(d: Dateish, timeZone = "UTC"): string {
  const v = toDate(d);
  if (!v) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  }).format(v);
}

export function formatDate(d: Dateish, timeZone = "UTC"): string {
  const v = toDate(d);
  if (!v) return "—";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "2-digit", timeZone }).format(v);
}

/** "3 h ago", "23 days ago", "in 2 days". */
export function relativeTime(d: Dateish, now: Date = new Date()): string {
  const v = toDate(d);
  if (!v) return "—";
  const s = Math.round((now.getTime() - v.getTime()) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let text: string;
  if (abs < 60) text = "moments";
  else if (abs < 3600) text = fmt(Math.round(abs / 60), "minute");
  else if (abs < 86_400) text = fmt(Math.round(abs / 3600), "hour");
  else if (abs < 86_400 * 60) text = fmt(Math.round(abs / 86_400), "day");
  else if (abs < 86_400 * 730) text = fmt(Math.round(abs / (86_400 * 30.44)), "month");
  else text = fmt(Math.round(abs / (86_400 * 365.25)), "year");
  if (abs < 60) return "just now";
  return s >= 0 ? `${text} ago` : `in ${text}`;
}

export type Currency = "current" | "recent" | "aging" | "stale" | "none";

/**
 * How current an observation is. Thresholds suit 5–16 day satellite revisit:
 * within 3 days "current", within 10 "recent", within 30 "aging", else "stale".
 */
export function dataCurrency(d: Dateish, now: Date = new Date()): Currency {
  const v = toDate(d);
  if (!v) return "none";
  const days = (now.getTime() - v.getTime()) / 86_400_000;
  if (days <= 3) return "current";
  if (days <= 10) return "recent";
  if (days <= 30) return "aging";
  return "stale";
}

export function ageInDays(d: Dateish, now: Date = new Date()): number | null {
  const v = toDate(d);
  return v ? Math.floor((now.getTime() - v.getTime()) / 86_400_000) : null;
}

export function formatNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
