/**
 * The organization shell: fixture detection drives the banner wording, and
 * navigation badge counts follow the caller's AOI scope.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PROVIDER_ID } from "@/lib/fixtures";
import { shellSummary } from "@/server/orgs/shell";
import { closeTestDb, createOrg, insertAoi, resetDb, SQUARE } from "../helpers/db";
import { daysAgo, grantAoi, insertAsset, insertDetection, insertObservation, member, rows } from "./alerts.fixtures";

describe("shell summary", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("reports test-fixture measurements only when a fixture asset backs an observation", async () => {
    const org = await createOrg("shell-fixtures");
    const aoi = await insertAoi(org.id);
    const admin = await member(org, "org_admin");
    await insertObservation(org.id, aoi, { observedAt: daysAgo(3) });
    expect((await shellSummary(admin.access, admin.id)).has_fixture_data).toBe(false);

    const fixtureAsset = await insertAsset({ acquiredAt: daysAgo(2), providerId: FIXTURE_PROVIDER_ID });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(2), assetId: fixtureAsset });
    expect((await shellSummary(admin.access, admin.id)).has_fixture_data).toBe(true);

    // Another org's fixtures do not leak into this one.
    const clean = await createOrg("shell-clean");
    const cleanAdmin = await member(clean, "org_admin");
    expect((await shellSummary(cleanAdmin.access, cleanAdmin.id)).has_fixture_data).toBe(false);
  });

  it("navigation badge counts follow AOI restrictions", async () => {
    const org = await createOrg("shell-scope");
    const granted = await insertAoi(org.id, "Granted");
    const hidden = await insertAoi(org.id, "Hidden", SQUARE(-77.5, 35.8));
    for (const aoi of [granted, hidden]) {
      await insertDetection(org.id, aoi);
      await rows`insert into alerts (org_id, aoi_id, title, severity, status, explanation, dedupe_key, observed_at)
                 values (${org.id}, ${aoi}, 'A', 'high', 'open', '{}'::jsonb, ${`s:${aoi}`}, now())`;
    }
    const restricted = await member(org, "analyst", true);
    await grantAoi(org.id, restricted.membershipId, granted);
    const admin = await member(org, "org_admin");
    expect(await shellSummary(admin.access, admin.id)).toMatchObject({ open_alerts: 2, unreviewed: 2 });
    expect(await shellSummary(restricted.access, restricted.id)).toMatchObject({ open_alerts: 1, unreviewed: 1 });
  });
});
