import { MapWorkspace } from "@/components/map/workspace";
import type { AoiFeatureProps, FC } from "@/components/map/types";
import { mapBasemaps, mapOverlays } from "@/lib/map-layer-adapter";
import { aoiFeatureCollection, aoiVisibleTo } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";

export const metadata = { title: "Map workspace" };

export default async function MapPage(props: PageProps<"/app/[org]/map">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const access = await getOrgPageAccess(org);
  const aois = (await aoiFeatureCollection(access)) as unknown as FC<AoiFeatureProps>;
  const extent = await access.tx(async (tx) => {
    const [r] = await tx<{ b: [number, number, number, number] | null }[]>`
      select case when count(*) = 0 then null else array[ST_XMin(ST_Extent(a.geom)), ST_YMin(ST_Extent(a.geom)), ST_XMax(ST_Extent(a.geom)), ST_YMax(ST_Extent(a.geom))]::float8[] end as b
        from aois a where a.org_id = ${access.org.id} and a.status = 'active' ${aoiVisibleTo(tx, access)}`;
    return r?.b ?? null;
  });
  const str = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? v : undefined);
  const at = typeof sp.at === "string" ? sp.at.split(",").map(Number) : [];
  const initialView =
    at.length === 3 && at.every(Number.isFinite) && Math.abs(at[0]!) <= 180 && Math.abs(at[1]!) <= 85 && at[2]! >= 0 && at[2]! <= 22
      ? { center: [at[0]!, at[1]!] as [number, number], zoom: at[2]! }
      : null;
  return (
    <MapWorkspace
      slug={org}
      orgKind={access.org.kind}
      timeZone={access.org.settings.timezone ?? "UTC"}
      perms={{
        write: access.can("aoi.write"),
        run: access.can("analysis.run"),
        review: access.can("detections.review"),
        notes: access.can("notes.write"),
        reports: access.can("reports.generate"),
      }}
      basemaps={mapBasemaps("usgs-imagery")}
      overlays={mapOverlays()}
      initialAois={aois}
      initialBounds={extent}
      initialView={initialView}
      focus={{ aoi: str(sp.aoi), detection: str(sp.detection), obs: str(sp.obs), draw: sp.draw === "1" }}
    />
  );
}
