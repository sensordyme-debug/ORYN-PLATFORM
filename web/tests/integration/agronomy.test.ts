/**
 * Field agronomy inputs, the irrigation log and the crop water balance:
 * tenant isolation, area scope, role permissions, and the estimate on stored
 * weather (OPEN_METEO_ALLOW_NONCOMMERCIAL is on in the integration env, so
 * Open-Meteo records count; the licence-gated case is a unit test).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addIrrigationEvent, deleteIrrigationEvent, getAgronomy, saveAgronomy, waterBalance } from "@/server/agronomy/service";
import { closeTestDb, createOrg, insertAoi, ownerSql, resetDb, SQUARE } from "../helpers/db";
import { grantAoi, member, rows } from "./alerts.fixtures";

const INPUTS = { crop: "soybeans", plantingDate: "2026-05-01", stageDays: null, soilTexture: "loam", availableWaterMmPerM: null, rootDepthM: null, notes: "" };

/** Daily Open-Meteo reanalysis records (local midnight at UTC−4) for [from, to]. */
async function insertDailyWeather(orgId: string, aoiId: string, from: string, to: string, et0: number, precip: (d: string) => number = () => 0) {
  const sql = ownerSql();
  for (let t = Date.parse(`${from}T04:00:00Z`); t <= Date.parse(`${to}T04:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    for (const [variable, value] of [["et0_mm", et0], ["precipitation_mm", precip(d)]] as const) {
      await sql`insert into weather_records (org_id, aoi_id, provider_id, record_kind, variable, value, unit, valid_from, valid_to)
                values (${orgId}, ${aoiId}, 'open-meteo', 'model_estimate', ${variable}, ${value}, 'mm', ${new Date(t)}, ${new Date(t + 86_400_000)})`;
    }
  }
}

describe("field agronomy and the crop water balance", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  async function world() {
    const org = await createOrg("farm-a");
    const other = await createOrg("farm-b");
    const field = await insertAoi(org.id, "North field");
    const hidden = await insertAoi(org.id, "South field", SQUARE(-77.5, 35.8));
    const admin = await member(org, "org_admin");
    const analyst = await member(org, "analyst");
    const operator = await member(org, "field_operator");
    const viewer = await member(org, "viewer");
    const restricted = await member(org, "analyst", true);
    await grantAoi(org.id, restricted.membershipId, field);
    const outsider = await member(other, "org_admin");
    return { org, other, field, hidden, admin, analyst, operator, viewer, restricted, outsider };
  }

  it("saves inputs for members who may edit the area, and audits the change", async () => {
    const w = await world();
    const saved = await saveAgronomy(w.analyst.access, w.field, INPUTS);
    expect(saved).toMatchObject({ crop: "soybeans", cropSource: "agronomy", plantingDate: "2026-05-01", soilTexture: "loam" });
    const [audit] = await rows<{ action: string }>`select action from audit_events where action = 'aoi.agronomy.update'`;
    expect(audit?.action).toBe("aoi.agronomy.update");
    // A viewer and a field operator can read the inputs but not change them.
    expect((await getAgronomy(w.viewer.access, w.field)).crop).toBe("soybeans");
    await expect(saveAgronomy(w.viewer.access, w.field, INPUTS)).rejects.toMatchObject({ status: 403 });
    await expect(saveAgronomy(w.operator.access, w.field, INPUTS)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects crops, soils and values outside the documented ranges", async () => {
    const w = await world();
    await expect(saveAgronomy(w.admin.access, w.field, { ...INPUTS, crop: "quinoa" })).rejects.toThrow();
    await expect(saveAgronomy(w.admin.access, w.field, { ...INPUTS, soilTexture: "gravel" })).rejects.toThrow();
    await expect(saveAgronomy(w.admin.access, w.field, { ...INPUTS, availableWaterMmPerM: 900 })).rejects.toThrow();
    await expect(saveAgronomy(w.admin.access, w.field, { ...INPUTS, plantingDate: "May 1st" })).rejects.toThrow();
  });

  it("keeps another organization's fields unreachable, and a restricted member to their granted areas", async () => {
    const w = await world();
    await saveAgronomy(w.admin.access, w.hidden, INPUTS);
    for (const call of [
      () => getAgronomy(w.outsider.access, w.field),
      () => saveAgronomy(w.outsider.access, w.field, INPUTS),
      () => waterBalance(w.outsider.access, w.field),
      () => addIrrigationEvent(w.outsider.access, w.field, { appliedOn: "2026-05-05", amountMm: 10 }),
      () => getAgronomy(w.restricted.access, w.hidden),
      () => waterBalance(w.restricted.access, w.hidden),
      () => addIrrigationEvent(w.restricted.access, w.hidden, { appliedOn: "2026-05-05", amountMm: 10 }),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
    // The restricted member works normally on the granted field.
    await saveAgronomy(w.restricted.access, w.field, INPUTS);
    expect((await getAgronomy(w.restricted.access, w.field)).crop).toBe("soybeans");
    // Row-level security: the other organization's context sees none of these rows.
    const { withTenant } = await import("@/server/db/client");
    const seen = await withTenant({ orgId: w.other.id }, (tx) => tx<{ n: number }[]>`select count(*)::int as n from field_agronomy`);
    expect(seen[0]!.n).toBe(0);
  });

  it("lets a field operator log irrigation, and delete only their own entries", async () => {
    const w = await world();
    const mine = await addIrrigationEvent(w.operator.access, w.field, { appliedOn: "2026-05-05", amountMm: 12.5, note: "pivot" }, new Date("2026-05-10T00:00:00Z"));
    const theirs = await addIrrigationEvent(w.analyst.access, w.field, { appliedOn: "2026-05-06", amountMm: 8 }, new Date("2026-05-10T00:00:00Z"));
    await expect(addIrrigationEvent(w.viewer.access, w.field, { appliedOn: "2026-05-05", amountMm: 10 })).rejects.toMatchObject({ status: 403 });
    await expect(addIrrigationEvent(w.operator.access, w.field, { appliedOn: "2099-01-01", amountMm: 10 })).rejects.toMatchObject({ status: 422 });
    await expect(deleteIrrigationEvent(w.operator.access, w.field, theirs.id)).rejects.toMatchObject({ status: 422 });
    await deleteIrrigationEvent(w.operator.access, w.field, mine.id);
    // Someone who may edit the area can remove any entry.
    await deleteIrrigationEvent(w.admin.access, w.field, theirs.id);
    expect((await getAgronomy(w.admin.access, w.field)).irrigation).toEqual([]);
  });

  it("estimates the balance from stored weather, counting logged irrigation, and reports missing days", async () => {
    const w = await world();
    await saveAgronomy(w.admin.access, w.field, INPUTS);
    const asOf = new Date("2026-05-11T12:00:00Z");
    expect((await waterBalance(w.viewer.access, w.field, { asOf })).status).toBe("insufficient_weather");
    await insertDailyWeather(w.org.id, w.field, "2026-05-01", "2026-05-10", 5);
    await addIrrigationEvent(w.operator.access, w.field, { appliedOn: "2026-05-10", amountMm: 15 }, asOf);
    const r = await waterBalance(w.viewer.access, w.field, { asOf });
    expect(r.status).toBe("estimated");
    // Soybeans, initial stage: Kc 0.4 × ETo 5 = 2 mm/day; 9 days → 18, then −15 + 2 → 5.
    expect(r.current!.depletionMm).toBe(5);
    expect(r.weather!.et0!.provider).toBe("open-meteo");
    expect(r.inputs.irrigation).toMatchObject({ events: 1, totalMm: 15 });
  });
});
