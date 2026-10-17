"use client";

import { ExternalLink } from "lucide-react";
import { RasterLegend } from "@/components/map/legend";
import type { Observation } from "@/components/map/types";
import { Badge, KeyValues, ResultClassBadge } from "@/components/platform/ui";
import { formatDateTime, formatPercent, relativeTime } from "@/lib/format";

/**
 * Everything a reader needs to judge an image: which source, when it was
 * acquired vs. when ORYN saw and processed it, its native resolution, how
 * much of the area it covers and how much was masked, and its licence.
 */
export function ObservationMeta({ o, timeZone, layer }: { o: Observation; timeZone: string; layer: "index" | "true_color" }) {
  const q = o.quality;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <ResultClassBadge resultClass={o.resultClass} />
        {q.flags?.map((f) => <Badge key={f} tone="watch">{f.replace(/_/g, " ")}</Badge>)}
      </div>
      {layer === "index" && o.legend ? <RasterLegend legend={o.legend} /> : null}
      <KeyValues
        items={[
          ["Acquired", <span key="a">{formatDateTime(o.asset.acquiredAt, timeZone)} <span className="text-bone-50/45">({relativeTime(o.asset.acquiredAt)})</span></span>],
          ["Available to ORYN", formatDateTime(o.asset.firstSeenAt, timeZone)],
          ["Processed", formatDateTime(o.processedAt, timeZone)],
          ["Source", `${o.asset.platform ?? ""} · ${o.asset.collection}`],
          ["Item", <code key="i" className="break-all text-[0.6875rem]">{o.asset.externalId}</code>],
          ["Native resolution", o.asset.gsdM ? `${o.asset.gsdM} m per pixel` : `${q.gsd_m ?? "—"} m`],
          ["Scene cloud cover", o.asset.cloudCover !== null ? `${Math.round(o.asset.cloudCover)}% (whole scene)` : "—"],
          ["Area covered", formatPercent(q.coverage_fraction)],
          ["Masked in area", `${formatPercent(q.masked_fraction)} (cloud, shadow, no data)`],
          ["Method", `${o.modelId}@${o.modelVersion}`],
          ["Licence", o.asset.license ?? "See provider terms"],
          ["Attribution", o.asset.attribution ?? "—"],
        ]}
      />
      {o.asset.stacUrl ? (
        <a className="inline-flex items-center gap-1 text-[0.75rem] text-bone-50/60 hover:text-bone-50" href={o.asset.stacUrl} target="_blank" rel="noreferrer">
          Provider catalog record <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      ) : null}
      {o.limitations.length ? (
        <details className="text-[0.75rem] text-bone-50/65">
          <summary className="cursor-pointer text-bone-50/75">Limitations ({o.limitations.length})</summary>
          <ul className="mt-1 list-disc pl-4">{o.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
