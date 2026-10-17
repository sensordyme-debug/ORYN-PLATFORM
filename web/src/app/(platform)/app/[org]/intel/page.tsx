import { EngineWorkspaceLoader } from "@/components/intel/engine-loader";
import type { AoiFeatureProps, FC } from "@/components/map/types";
import { aoiFeatureCollection, aoiVisibleTo } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";

export const metadata = { title: "Intelligence globe" };

/**
 * The Intelligence globe runs on the God's Eye View geospatial engine
 * (src/components/intel/engine-workspace.tsx). Access, the organization's
 * areas, and the starting view are resolved here exactly as before; the
 * engine supplies the globe and its public-data layers.
 */
export default async function IntelPage(props: PageProps<"/app/[org]/intel">) {
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
  const at = typeof sp.at === "string" ? sp.at.split(",").map(Number) : [];
  const focusAt =
    at.length === 3 && at.every(Number.isFinite) && Math.abs(at[0]!) <= 180 && Math.abs(at[1]!) <= 90 && at[2]! > 0 && at[2]! < 40_000_000
      ? { lon: at[0]!, lat: at[1]!, heightM: at[2]! }
      : undefined;
  return (
    <EngineWorkspaceLoader
      slug={org}
      timeZone={access.org.settings.timezone ?? "UTC"}
      canNote={access.can("notes.write")}
      initialAois={aois}
      initialBounds={extent}
      focus={{ at: focusAt }}
    />
  );
}
