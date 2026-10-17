import Link from "next/link";
import { Badge, DataAge, EmptyState, LinkButton, PageHeader, Panel, Table, td, th } from "@/components/platform/ui";
import { AOI_KIND_LABEL } from "@/lib/aoi-config";
import { formatNumber } from "@/lib/format";
import { formatArea } from "@/lib/geo";
import { aoiVisibleTo } from "@/server/aois/service";
import { currentModelKeys } from "@/server/analytics/registry";
import { getOrgPageAccess } from "@/server/authz/next";

export const metadata = { title: "Areas of interest" };

type Row = {
  id: string; name: string; kind: keyof typeof AOI_KIND_LABEL; status: string; area_m2: number; is_synthetic: boolean; monitoring_enabled: boolean;
  parent_name: string | null; latest_valid: Date | null; latest_ndvi: number | null; open_alerts: number; unreviewed: number; crop: string | null;
};

export default async function AreasPage(props: PageProps<"/app/[org]/areas">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const access = await getOrgPageAccess(org);
  const status = sp.status === "archived" ? "archived" : "active";
  const rows = await access.tx((tx) => tx<Row[]>`
    select a.id, a.name, a.kind, a.status, a.area_m2, a.is_synthetic, a.monitoring_enabled, p.name as parent_name,
           a.metadata->>'crop' as crop,
           (select max(o.observed_at) from observations o where o.aoi_id = a.id and o.status = 'valid' and o.is_current) as latest_valid,
           (select (o.metrics->>'mean')::float8 from observations o where o.aoi_id = a.id and o.kind = 'ndvi' and o.status = 'valid' and o.is_current order by o.observed_at desc limit 1) as latest_ndvi,
           (select count(*)::int from alerts al where al.aoi_id = a.id and al.status in ('open','acknowledged')) as open_alerts,
           (select count(*)::int from detections d where d.aoi_id = a.id and d.verification_status = 'unverified'
              and d.evidence_grade in ('moderate', 'strong') and d.model_id || '@' || d.model_version = any(${currentModelKeys()})) as unreviewed
      from aois a left join aois p on p.id = a.parent_id
     where a.org_id = ${access.org.id} and a.status = ${status} ${aoiVisibleTo(tx, access)}
     order by coalesce(p.name, a.name), a.name`);
  const isAg = access.org.kind === "agriculture";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Monitoring"
        title={isAg ? "Fields & farms" : "Areas of interest"}
        description="Every area is monitored on its own schedule. Data age shows how recent the latest usable satellite observation is — not how recently ORYN checked."
        actions={
          <>
            <LinkButton href={`/app/${org}/areas?status=${status === "active" ? "archived" : "active"}`} variant="ghost" size="sm">{status === "active" ? "Show archived" : "Show active"}</LinkButton>
            {access.can("aoi.write") ? <LinkButton href={`/app/${org}/areas/new`} variant="primary">New area</LinkButton> : null}
          </>
        }
      />
      <Panel bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState title={status === "active" ? "No areas yet" : "No archived areas"} className="m-4" action={access.can("aoi.write") && status === "active" ? <LinkButton href={`/app/${org}/areas/new`} variant="primary">Add the first area</LinkButton> : undefined}>
            {isAg ? "Add field boundaries by drawing them, uploading GeoJSON, or importing them." : "Import your municipal boundary from the U.S. Census, upload GeoJSON, or draw areas on the map."}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><th className={th}>Name</th><th className={th}>Type</th><th className={th}>Area</th><th className={th}>Latest usable data</th>{isAg ? <th className={th}>NDVI (mean)</th> : null}<th className={th}>Attention</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <Link href={`/app/${org}/areas/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                    <span className="block text-[0.75rem] text-bone-50/45">{[r.parent_name, r.crop].filter(Boolean).join(" · ")}</span>
                    {r.is_synthetic ? <Badge tone="watch" className="mt-1">Synthetic boundary</Badge> : null}
                    {!r.monitoring_enabled && r.status === "active" ? <Badge tone="muted" className="ml-1 mt-1">Monitoring off</Badge> : null}
                  </td>
                  <td className={td}>{AOI_KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className={`${td} whitespace-nowrap`}>{formatArea(r.area_m2)}</td>
                  <td className={td}>{r.latest_valid ? <DataAge at={r.latest_valid} /> : <span className="text-bone-50/45">None yet</span>}</td>
                  {isAg ? <td className={`${td} tabular-nums`}>{formatNumber(r.latest_ndvi, 2)}</td> : null}
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {r.open_alerts ? <Badge tone="alert">{r.open_alerts} open alert{r.open_alerts > 1 ? "s" : ""}</Badge> : null}
                      {r.unreviewed ? <Badge tone="watch">{r.unreviewed} to review</Badge> : null}
                      <Link href={`/app/${org}/map?aoi=${r.id}`} className="text-[0.75rem] text-bone-50/55 underline-offset-2 hover:underline">Map</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
