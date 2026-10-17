import { IntelWorkspaceLoader } from "@/components/intel/loader";
import type { LayerAvailability } from "@/components/intel/intel-workspace";
import type { AoiFeatureProps, FC } from "@/components/map/types";
import { MAP_LAYERS } from "@/lib/map-layers";
import { aoiFeatureCollection, aoiVisibleTo } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";
import { integrationGate, type GatedIntegration } from "@/server/integrations";

export const metadata = { title: "Intelligence globe" };

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
  // The same production gates the APIs apply, so modes never switch on a layer that is off here.
  const gate = (id: GatedIntegration) => {
    const g = integrationGate(id);
    return g.enabled ? ({ enabled: true } as const) : ({ enabled: false, reason: g.reason } as const);
  };
  const on = { enabled: true } as const;
  const availability: LayerAvailability = {
    aois: on,
    detections: on,
    "usgs-earthquakes": gate("usgs-earthquakes"),
    "nifc-wildfire-perimeters": gate("nifc-wildfire-perimeters"),
    satellites: gate("celestrak"),
    cameras: gate("caltrans-cctv"),
    "viirs-daily": on,
    "usgs-aerial": on,
  };
  const at = typeof sp.at === "string" ? sp.at.split(",").map(Number) : [];
  const focusAt =
    at.length === 3 && at.every(Number.isFinite) && Math.abs(at[0]!) <= 180 && Math.abs(at[1]!) <= 90 && at[2]! > 0 && at[2]! < 40_000_000
      ? { lon: at[0]!, lat: at[1]!, heightM: at[2]! }
      : undefined;
  const aerial = MAP_LAYERS.find((l) => l.id === "usgs-imagery")!;
  return (
    <IntelWorkspaceLoader
      slug={org}
      timeZone={access.org.settings.timezone ?? "UTC"}
      canNote={access.can("notes.write")}
      initialAois={aois}
      initialBounds={extent}
      availability={availability}
      usgsAerialTemplate={aerial.tileUrl!}
      focus={{ at: focusAt }}
    />
  );
}
