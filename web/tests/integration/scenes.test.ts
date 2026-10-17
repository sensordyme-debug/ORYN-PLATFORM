/**
 * Saved map scenes: sharing and privacy, restricted members, tenant
 * isolation, deletion rights, and validation. A scene is view state only and
 * must never reveal an area the viewer cannot see.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SceneInput } from "@/lib/scenes";
import { createScene, deleteScene, listScenes } from "@/server/scenes/service";
import { closeTestDb, createOrg, insertAoi, ownerSql, resetDb, SQUARE } from "../helpers/db";
import { grantAoi, member } from "./alerts.fixtures";

const view = { center: [-77.6, 35.9] as [number, number], zoom: 13 };
const scene = (over: Partial<SceneInput> = {}, state: Partial<SceneInput["state"]> = {}): SceneInput => ({
  name: "North field, July",
  visibility: "org",
  ...over,
  state: { view, basemap: "usgs-imagery", overlays: ["usgs-hydro"], ...state },
});

describe("saved scenes", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("shares organization scenes, keeps private ones private, and lets viewers save only private scenes", async () => {
    const org = await createOrg("farm-a");
    const analyst = await member(org, "analyst");
    const viewer = await member(org, "viewer");
    const shared = await createScene(analyst.access, scene());
    const mine = await createScene(analyst.access, scene({ name: "Draft", visibility: "private" }));
    expect(shared.state).toMatchObject({ view: { center: [-77.6, 35.9], zoom: 13, bearing: 0, pitch: 0 }, projection: "mercator", overlays: ["usgs-hydro"], chartIndex: "ndvi" });

    expect((await listScenes(viewer.access)).map((s) => s.id)).toEqual([shared.id]);
    expect((await listScenes(analyst.access)).map((s) => s.id).sort()).toEqual([shared.id, mine.id].sort());
    await expect(createScene(viewer.access, scene())).rejects.toMatchObject({ status: 403 });
    const own = await createScene(viewer.access, scene({ visibility: "private" }));
    expect((await listScenes(analyst.access)).map((s) => s.id)).not.toContain(own.id);
  });

  it("never reveals an area the viewer cannot see", async () => {
    const org = await createOrg("farm-a");
    const north = await insertAoi(org.id, "North", SQUARE(-77.6, 35.9));
    const south = await insertAoi(org.id, "South", SQUARE(-77.7, 35.8));
    const analyst = await member(org, "analyst");
    const restricted = await member(org, "analyst", true);
    await grantAoi(org.id, restricted.membershipId, north);
    const s = await createScene(analyst.access, scene({}, { aoiId: south, imagery: { kind: "ndvi", observedAt: "2026-07-17T16:13:09.024Z" } }));
    expect(s).toMatchObject({ aoiUnavailable: false, state: { aoiId: south } });
    const seen = (await listScenes(restricted.access)).find((x) => x.id === s.id)!;
    expect(seen).toMatchObject({ aoiUnavailable: true, state: { aoiId: null, imagery: null } });
    // Nor can they save a scene pointing at it.
    await expect(createScene(restricted.access, scene({}, { aoiId: south }))).rejects.toMatchObject({ status: 404 });
  });

  it("isolates organizations and limits deletion to the author or an administrator", async () => {
    const a = await createOrg("farm-a");
    const b = await createOrg("farm-b");
    const author = await member(a, "analyst");
    const colleague = await member(a, "analyst");
    const admin = await member(a, "org_admin");
    const outsider = await member(b, "org_admin");
    const s1 = await createScene(author.access, scene());
    const s2 = await createScene(author.access, scene({ name: "Second" }));

    expect(await listScenes(outsider.access)).toEqual([]);
    await expect(deleteScene(outsider.access, s1.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteScene(colleague.access, s1.id)).rejects.toMatchObject({ status: 403 });
    await deleteScene(author.access, s1.id);
    await deleteScene(admin.access, s2.id);
    expect(await listScenes(author.access)).toEqual([]);
    const audit = await ownerSql()<{ action: string }[]>`select action from audit_events where target_type = 'scene' order by created_at`;
    expect(audit.map((r) => r.action)).toEqual(["scene.create", "scene.create", "scene.delete", "scene.delete"]);
  });

  it("validates the scene: known layers only, no extra fields, bounded view", async () => {
    const org = await createOrg("farm-a");
    const analyst = await member(org, "analyst");
    await expect(createScene(analyst.access, scene({}, { basemap: "not-a-basemap" }))).rejects.toMatchObject({ status: 422 });
    await expect(createScene(analyst.access, scene({}, { overlays: ["secret-layer"] }))).rejects.toMatchObject({ status: 422 });
    await expect(createScene(analyst.access, { ...scene(), state: { ...scene().state, sql: "drop table x" } } as unknown as SceneInput)).rejects.toMatchObject({ status: 422 });
    await expect(createScene(analyst.access, scene({}, { view: { center: [-200, 10], zoom: 3 } }))).rejects.toMatchObject({ status: 422 });
    await expect(createScene(analyst.access, scene({ name: "  " }))).rejects.toMatchObject({ status: 422 });
  });
});
