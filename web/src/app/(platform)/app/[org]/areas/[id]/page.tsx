import Link from "next/link";
import { AoiSettingsForm, type SourceAvailability } from "@/components/platform/aoi-settings-form";
import { DeleteLayerButton, OsmImportForm } from "@/components/platform/context-layers";
import { Badge, DataAge, EmptyState, KeyValues, LinkButton, PageHeader, Panel, ResultClassBadge, Table, td, th } from "@/components/platform/ui";
import { AOI_KIND_LABEL } from "@/lib/aoi-config";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { formatArea, formatLatLon } from "@/lib/geo";
import { getAoi } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";
import { listRuns } from "@/server/jobs/views";
import { providerAvailabilityMap } from "@/server/providers/availability";
import { listReferenceLayers } from "@/server/reference/service";
import { listObservations } from "@/server/results/service";

export const metadata = { title: "Area details" };

function keyMetric(kind: string, m: Record<string, unknown>): string {
  if (kind === "ndvi") return `mean ${formatNumber(m.mean as number, 3)}`;
  if (kind === "ndwi" || kind === "s1_water") return `water ${formatArea((m.water_area_m2 as number) ?? 0)} (${formatPercent(m.water_fraction as number, 1)})`;
  if (kind === "landcover") {
    const top = ((m.classes as { label: string; fraction: number }[]) ?? []).slice().sort((a, b) => b.fraction - a.fraction)[0];
    return top ? `${top.label} ${formatPercent(top.fraction)}` : "—";
  }
  return "—";
}

export default async function AreaDetailPage(props: PageProps<"/app/[org]/areas/[id]">) {
  const { org, id } = await props.params;
  const access = await getOrgPageAccess(org);
  const aoi = await getAoi(access, id);
  const [obs, runs, layers] = await Promise.all([
    listObservations(access, id, { limit: 300 }),
    access.can("results.read") ? listRuns(access, { aoiId: id, limit: 30 }) : [],
    listReferenceLayers(access, { aoiId: id }),
  ]);
  const tz = access.org.settings.timezone ?? "UTC";
  const latestValid = obs.find((o) => o.status === "valid");
  const availability: SourceAvailability = access.can("aoi.write") ? await providerAvailabilityMap() : {};
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={`/app/${org}/areas`} className="hover:underline">Areas</Link>}
        title={aoi.name}
        description={aoi.description || undefined}
        actions={
          <>
            <LinkButton href={`/app/${org}/map?aoi=${aoi.id}`} variant="primary">Open on map</LinkButton>
            {access.can("reports.generate") ? <LinkButton href={`/app/${org}/reports?aoi=${aoi.id}`}>Generate report</LinkButton> : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Panel title="Summary">
          <KeyValues
            items={[
              ["Type", AOI_KIND_LABEL[aoi.kind]],
              ["Area", formatArea(aoi.areaM2)],
              ["Location", formatLatLon(aoi.labelPoint, 5)],
              ["Status", <span key="s" className="flex gap-1.5"><Badge tone={aoi.status === "active" ? "good" : "muted"}>{aoi.status}</Badge>{aoi.isSynthetic ? <Badge tone="watch">synthetic boundary</Badge> : null}</span>],
              ["Boundary source", `${aoi.boundarySource.method}${aoi.boundarySource.provider ? ` — ${aoi.boundarySource.provider}` : ""}${aoi.boundarySource.external_id ? ` (${aoi.boundarySource.external_id})` : ""}${aoi.boundarySource.note ? ` — ${aoi.boundarySource.note}` : ""}`],
              ["Boundary licence", aoi.boundarySource.license ?? "—"],
              ["Latest usable data", latestValid ? <DataAge key="d" at={latestValid.observedAt} timeZone={tz} /> : "None yet"],
              ["Last catalog check", aoi.lastCheckedAt ? formatDateTime(aoi.lastCheckedAt, tz) : "Never"],
              ["Created", formatDateTime(aoi.createdAt, tz)],
              ...Object.entries(aoi.metadata).slice(0, 10).map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string]),
            ]}
          />
        </Panel>
        <Panel title="Observation counts">
          <KeyValues
            items={Object.entries(
              obs.reduce<Record<string, { valid: number; unusable: number }>>((acc, o) => {
                acc[o.kind] ??= { valid: 0, unusable: 0 };
                acc[o.kind]![o.status]++;
                return acc;
              }, {}),
            ).map(([k, v]) => [k.toUpperCase().replace("_", " "), `${v.valid} usable · ${v.unusable} unusable`])}
          />
        </Panel>
      </div>
      {access.can("aoi.write") && aoi.status === "active" ? (
        <Panel title="Monitoring configuration">
          <AoiSettingsForm slug={org} aoi={{ ...aoi, description: aoi.description }} availability={availability} />
        </Panel>
      ) : null}
      <Panel title="Context layers" description="Reference data shown on the map and checked against candidate changes. Overlap is context for review, not a finding.">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            {layers.length === 0 ? <p className="text-[0.8125rem] text-bone-50/50">No reference layers for this area yet.</p> : (
              <ul className="flex flex-col gap-2 text-[0.8125rem]">
                {layers.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-2 rounded-[3px] border border-bone-50/[0.07] px-3 py-2">
                    <span>
                      {l.name}
                      <span className="block text-[0.75rem] text-bone-50/45">{l.kind} · {l.featureCount} features · {l.license ?? "licence unknown"}{l.redistribution ? ` · ${l.redistribution}` : ""}</span>
                    </span>
                    {access.can("layers.manage") ? <DeleteLayerButton slug={org} layerId={l.id} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {access.can("layers.manage") ? <OsmImportForm slug={org} aoiId={aoi.id} /> : null}
        </div>
      </Panel>
      <Panel title="Observation history" description="Every analyzed image, including unusable ones. Results from earlier method versions are kept (see ?history)." bodyClassName="p-0">
        {obs.length === 0 ? (
          <EmptyState title="No observations yet" className="m-4">Observations appear after the worker finds and analyzes imagery for this area.</EmptyState>
        ) : (
          <Table>
            <thead><tr><th className={th}>Acquired</th><th className={th}>Measure</th><th className={th}>Result</th><th className={th}>Quality</th><th className={th}>Source</th><th className={th}>Method</th><th className={th}>Processed</th></tr></thead>
            <tbody>
              {obs.map((o) => (
                <tr key={o.id}>
                  <td className={`${td} whitespace-nowrap`}><Link href={`/app/${org}/map?aoi=${aoi.id}&obs=${o.id}`} className="hover:underline">{formatDateTime(o.observedAt, tz)}</Link></td>
                  <td className={td}>{o.kind.toUpperCase().replace("_", " ")}<div className="mt-1"><ResultClassBadge resultClass={o.resultClass} /></div></td>
                  <td className={td}>{o.status === "valid" ? keyMetric(o.kind, o.metrics) : <span className="text-data-amber">Unusable — {o.quality.unusable_reason ?? "insufficient data"}</span>}</td>
                  <td className={td}>covers {formatPercent(o.quality.coverage_fraction)} · masked {formatPercent(o.quality.masked_fraction)}{o.quality.flags?.length ? <span className="block text-[0.6875rem] text-bone-50/45">{o.quality.flags.join(", ")}</span> : null}</td>
                  <td className={td}>{o.asset.platform ?? o.asset.collection}<span className="block text-[0.6875rem] text-bone-50/45">{o.asset.gsdM} m · {o.asset.providerId}</span></td>
                  <td className={td}><code className="text-[0.6875rem]">{o.modelId}@{o.modelVersion}</code></td>
                  <td className={td}>{formatDateTime(o.processedAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {runs.length ? (
        <Panel title="Analysis runs" bodyClassName="p-0">
          <Table>
            <thead><tr><th className={th}>Started</th><th className={th}>Model</th><th className={th}>Outcome</th><th className={th}>Notes</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className={td}>{formatDateTime(r.started_at, tz)}</td>
                  <td className={td}><code className="text-[0.6875rem]">{r.model_id}@{r.model_version}</code></td>
                  <td className={td}><Badge tone={r.status === "succeeded" ? "good" : r.status === "failed" ? "alert" : "watch"}>{r.status.replace("_", " ")}</Badge></td>
                  <td className={`${td} text-bone-50/65`}>{r.error ?? r.messages.join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}
