/**
 * The overview page's read model: same-sensor comparison for field health,
 * and AOI scoping for every list and count (regressions: the previous query
 * compared Sentinel-2 with Landsat and same-pass tiles, and listed weather
 * warnings, news and alert/review counts for AOIs a restricted member cannot
 * see).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { overviewData } from "@/server/results/overview";
import { closeTestDb, createOrg, insertAoi, resetDb, SQUARE } from "../helpers/db";
import { daysAgo, grantAoi, insertDetection, insertObservation, insertWarning, member, rows } from "./alerts.fixtures";

const S2 = "sentinel-2-l2a";
const LANDSAT = "landsat-c2-l2";

async function openAlert(orgId: string, aoiId: string) {
  await rows`
    insert into alerts (org_id, aoi_id, title, severity, status, explanation, dedupe_key, observed_at)
    values (${orgId}, ${aoiId}, 'Test alert', 'high', 'open', '{}'::jsonb, ${`t:${aoiId}`}, now())`;
}

describe("overview data", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("compares the latest NDVI only with an earlier pass of the same sensor", async () => {
    const org = await createOrg("ov-sensors");
    const field = await insertAoi(org.id, "Field");
    await insertObservation(org.id, field, { observedAt: daysAgo(20), mean: 0.7, collection: S2 });
    await insertObservation(org.id, field, { observedAt: daysAgo(6), mean: 0.2, collection: LANDSAT });
    const latest = daysAgo(2);
    await insertObservation(org.id, field, { observedAt: new Date(latest.getTime() - 5_000), mean: 0.1, collection: S2 }); // same pass, other tile
    await insertObservation(org.id, field, { observedAt: latest, mean: 0.6, collection: S2 });
    const admin = await member(org, "org_admin");

    const { fields } = await overviewData(admin.access);
    expect(fields).toHaveLength(1);
    const f = fields[0]!;
    expect(f.latest_collection).toBe(S2);
    expect(f.latest_mean).toBeCloseTo(0.6);
    // Not Landsat (0.2, 6 days ago) and not the other tile of the same pass (0.1).
    expect(f.prev_mean).toBeCloseTo(0.7);
  });

  it("has no previous value when only another sensor imaged the field earlier", async () => {
    const org = await createOrg("ov-only-other");
    const field = await insertAoi(org.id, "Field");
    await insertObservation(org.id, field, { observedAt: daysAgo(9), mean: 0.5, collection: LANDSAT });
    await insertObservation(org.id, field, { observedAt: daysAgo(1), mean: 0.6, collection: S2 });
    const admin = await member(org, "org_admin");
    const [f] = (await overviewData(admin.access)).fields;
    expect(f?.prev_mean).toBeNull();
  });

  it("scopes counts and lists to a restricted member's AOIs", async () => {
    const org = await createOrg("ov-scope");
    const granted = await insertAoi(org.id, "Granted field");
    const hidden = await insertAoi(org.id, "Hidden field", SQUARE(-77.5, 35.8));
    for (const aoi of [granted, hidden]) {
      await insertObservation(org.id, aoi, { observedAt: daysAgo(1), collection: S2 });
      await insertDetection(org.id, aoi);
      await insertWarning(org.id, aoi, { title: `Warning for ${aoi === granted ? "granted" : "hidden"}` });
      await openAlert(org.id, aoi);
    }
    const restricted = await member(org, "analyst", true);
    await grantAoi(org.id, restricted.membershipId, granted);
    const admin = await member(org, "org_admin");

    const full = await overviewData(admin.access);
    expect(full.stats).toMatchObject({ aois: 2, open_alerts: 2, unreviewed: 2 });

    const scoped = await overviewData(restricted.access);
    expect(scoped.stats).toMatchObject({ aois: 1, current: 1, open_alerts: 1, unreviewed: 1 });
    expect(scoped.fields.map((f) => f.name)).toEqual(["Granted field"]);
    expect(scoped.alerts.map((a) => a.aoi_name)).toEqual(["Granted field"]);
    expect(scoped.changes.map((c) => c.aoi_name)).toEqual(["Granted field"]);
    expect(scoped.warnings.map((w) => w.aoi_name)).toEqual(["Granted field"]);
  });
});
