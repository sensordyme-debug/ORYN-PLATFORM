import { BoundaryImport } from "@/components/platform/boundary-import";
import { UploadImport } from "@/components/platform/upload-import";
import { LinkButton, Notice, PageHeader, Panel } from "@/components/platform/ui";
import { listAois } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";
import { env } from "@/server/config/env";

export const metadata = { title: "New area" };

export default async function NewAreaPage(props: PageProps<"/app/[org]/areas/new">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  if (!access.can("aoi.write")) return <Notice tone="warn">Your role cannot create areas.</Notice>;
  const { items } = await listAois(access, { limit: 500 });
  const parents = items.filter((a) => ["farm", "municipal_boundary", "region"].includes(a.kind)).map((a) => ({ id: a.id, name: a.name }));
  const isAg = access.org.kind === "agriculture";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Monitoring" title="Add an area of interest" description="Boundaries come from you or from an authoritative public source — ORYN never invents them. Every area records where its boundary came from." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Draw on the map" description="Polygon, rectangle, point (with radius), or corridor (with width).">
          <LinkButton href={`/app/${org}/map?draw=1`} variant="primary">Open the map to draw</LinkButton>
        </Panel>
        <Panel title="Upload GeoJSON" description={isAg ? "Field boundaries exported from your farm-management or GIS software." : "Boundaries, project areas, or permit polygons from your GIS."}>
          <UploadImport slug={org} defaultKind={isAg ? "field" : "region"} parents={parents} maxMb={Math.round(env.maxUploadBytes() / 1e6)} />
        </Panel>
        <Panel title="Import a public boundary" description="Official municipal, place, or county boundaries from the U.S. Census Bureau (TIGERweb, public domain).">
          <BoundaryImport slug={org} />
        </Panel>
      </div>
    </div>
  );
}
