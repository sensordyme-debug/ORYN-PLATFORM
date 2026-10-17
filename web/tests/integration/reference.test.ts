import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessError, resolveUserOrgAccess } from "@/server/authz/access";
import { importUploadAsLayer, referenceLayerFeatures, requestOsmImport } from "@/server/reference/service";
import { getDetection } from "@/server/results/service";
import { receiveUpload } from "@/server/uploads/service";
import { addMember, closeTestDb, createOrg, createUser, insertAoi, meta, ownerSql, resetDb, SQUARE } from "../helpers/db";

const access = (userId: string, slug: string) => resolveUserOrgAccess({ id: userId, label: "t", isPlatformAdmin: false }, slug, meta);

async function detectionAt(orgId: string, aoiId: string, lon: number, lat: number) {
  const [d] = await ownerSql()<{ id: string }[]>`
    insert into detections (org_id, aoi_id, type, result_class, title, geom, first_observed_at, last_observed_at, evidence_grade, dedupe_key)
    values (${orgId}, ${aoiId}, 'vegetation_decline', 'candidate_change', 'Test candidate',
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(SQUARE(lon, lat, 0.001))}), 4326)), now(), now(), 'moderate', ${`t-${lon}`})
    returning id`;
  return d!.id;
}

describe("reference layers", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("an uploaded permit layer is reported as overlapping context on a candidate change — and stays inside its tenant", async () => {
    const city = await createOrg("city-a", "municipal");
    const other = await createOrg("city-b", "municipal");
    const analyst = await createUser();
    const stranger = await createUser();
    await addMember(city.id, analyst.id, "analyst");
    await addMember(other.id, stranger.id, "org_admin");
    const a = await access(analyst.id, "city-a");
    const aoiId = await insertAoi(city.id, "Downtown", SQUARE(-77.55, 35.88, 0.03));

    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "Permit 2026-114" }, geometry: SQUARE(-77.5405, 35.8905, 0.002) }],
    });
    const up = await receiveUpload(a, { name: "permits.geojson", type: "application/geo+json", bytes: new TextEncoder().encode(geojson) });
    expect(up.status).toBe("validated");
    const layer = await importUploadAsLayer(a, { uploadId: up.uploadId, name: "Building permits", kind: "permits" });
    expect(layer.features).toBe(1);

    const overlapping = await detectionAt(city.id, aoiId, -77.54, 35.891);
    const elsewhere = await detectionAt(city.id, aoiId, -77.53, 35.9);
    const d1 = await getDetection(a, overlapping);
    expect(d1.referenceMatches).toEqual([expect.objectContaining({ layerName: "Building permits", kind: "permits", count: 1, samples: [expect.objectContaining({ name: "Permit 2026-114" })] })]);
    expect((await getDetection(a, elsewhere)).referenceMatches).toEqual([]);

    // Another tenant cannot read the layer by id.
    const b = await access(stranger.id, "city-b");
    await expect(referenceLayerFeatures(b, layer.id)).rejects.toMatchObject({ code: "not_found" });
    const audit = await ownerSql()`select action from audit_events where org_id = ${city.id} order by id`;
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["upload.receive", "reference.layer_import"]));
  });

  it("OpenStreetMap imports are queued for the AOI and need layer permissions", async () => {
    const city = await createOrg("city-a", "municipal");
    const analyst = await createUser();
    const viewer = await createUser();
    await addMember(city.id, analyst.id, "analyst");
    await addMember(city.id, viewer.id, "viewer");
    const aoiId = await insertAoi(city.id, "Downtown", SQUARE(-77.55, 35.88, 0.03));
    const job = await requestOsmImport(await access(analyst.id, "city-a"), aoiId, { categories: ["buildings", "roads"] });
    expect(job.created).toBe(true);
    const [j] = await ownerSql()`select type, payload from jobs where id = ${job.id}`;
    expect(j).toMatchObject({ type: "reference.import", payload: { aoiId, categories: ["buildings", "roads"] } });
    await expect(requestOsmImport(await access(viewer.id, "city-a"), aoiId, { categories: ["roads"] })).rejects.toBeInstanceOf(AccessError);
  });
});
