import { Badge, KeyValues, PageHeader, Panel, Table, td, th } from "@/components/platform/ui";
import { formatDateTime, relativeTime } from "@/lib/format";
import { getOrgPageAccess } from "@/server/authz/next";
import { db } from "@/server/db/client";
import { PROVIDERS, providerAvailability } from "@/server/providers/registry";

export const metadata = { title: "Data sources" };

const KIND_LABEL: Record<string, string> = { imagery: "Earth observation", weather: "Weather & warnings", news: "News & events", reference: "Reference & boundaries", geocoding: "Search & geocoding", basemap: "Map layers" };
const STATUS_TONE = { healthy: "good", degraded: "watch", unavailable: "alert", unconfigured: "muted", disabled: "muted", unknown: "neutral" } as const;

export default async function SourcesPage(props: PageProps<"/app/[org]/sources">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  const tz = access.org.settings.timezone ?? "UTC";
  const status = await db()<{ provider_id: string; status: keyof typeof STATUS_TONE; last_success_at: Date | null; last_error_at: Date | null; last_error: string | null; consecutive_failures: number; request_count_24h: number }[]>`
    select provider_id, status, last_success_at, last_error_at, last_error, consecutive_failures, request_count_24h from provider_status`;
  const byId = new Map(status.map((s) => [s.provider_id, s]));
  const runs = await access.tx((tx) => tx<{ provider_id: string; product: string | null; aoi_name: string | null; status: string; items_found: number; items_new: number; error: string | null; finished_at: Date | null }[]>`
    select r.provider_id, r.product, a.name as aoi_name, r.status, r.items_found, r.items_new, r.error, r.finished_at
      from provider_sync_runs r left join aois a on a.id = r.aoi_id
     where r.org_id = ${access.org.id} order by r.started_at desc limit 25`);
  const groups = [...new Set(PROVIDERS.map((p) => p.kind))];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Data"
        title="Data sources"
        description="Every external source ORYN can use, whether it is configured and licensed here, and how it is behaving. None of these providers push updates; ORYN polls them on each area's schedule. A source shown as unconfigured or disabled contributes nothing — it is never simulated."
      />
      {groups.map((g) => (
        <section key={g} className="flex flex-col gap-3">
          <h2 className="t-eyebrow text-bone-50/50">{KIND_LABEL[g] ?? g}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {PROVIDERS.filter((p) => p.kind === g).map((p) => {
              const av = providerAvailability(p.id);
              const s = byId.get(p.id);
              return (
                <Panel
                  key={p.id}
                  title={p.name}
                  description={p.operator}
                  actions={
                    av.state !== "available" ? <Badge tone="muted">{av.state}</Badge> : s ? <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge> : <Badge tone="neutral">not used yet</Badge>
                  }
                >
                  {av.state !== "available" ? <p className="mb-3 text-[0.8125rem] text-data-amber">{av.reason}</p> : null}
                  <KeyValues
                    items={[
                      ["Products", p.products.map((x) => x.name).join("; ") || "—"],
                      ["Update cadence", p.updateCadence],
                      ["Delivery", "Polled on schedule (no push notifications)"],
                      ["Credentials", p.credentials.required ? p.credentials.envVars.join(", ") : p.credentials.envVars.length ? `Optional: ${p.credentials.envVars.join(", ")}` : "None required"],
                      ["Licence", p.licensing.summary],
                      ["Commercial use", p.licensing.commercialUse.replace(/_/g, " ")],
                      ["Redistribution", p.licensing.redistribution],
                      ...(p.rateLimit ? [["Rate limit", p.rateLimit] as [string, string]] : []),
                      ["Last success", s?.last_success_at ? `${formatDateTime(s.last_success_at, tz)} (${relativeTime(s.last_success_at)})` : "—"],
                      ...(s?.last_error ? [["Last error", `${s.last_error_at ? relativeTime(s.last_error_at) + ": " : ""}${s.last_error}`] as [string, string]] : []),
                    ]}
                  />
                  {p.docsUrl ? <a className="mt-3 inline-block text-[0.75rem] text-bone-50/55 underline" href={p.docsUrl} target="_blank" rel="noreferrer">Provider documentation</a> : null}
                </Panel>
              );
            })}
          </div>
        </section>
      ))}
      <Panel title="Recent catalog searches for this organization" bodyClassName="p-0">
        <Table>
          <thead><tr><th className={th}>When</th><th className={th}>Source</th><th className={th}>Area</th><th className={th}>Result</th></tr></thead>
          <tbody>
            {runs.map((r, i) => (
              <tr key={i}>
                <td className={td}>{formatDateTime(r.finished_at, tz)}</td>
                <td className={td}>{r.product ?? r.provider_id}</td>
                <td className={td}>{r.aoi_name ?? "—"}</td>
                <td className={td}>{r.status === "succeeded" ? `${r.items_found} items (${r.items_new} new to ORYN)` : <span className="text-data-alert">{r.error}</span>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}
