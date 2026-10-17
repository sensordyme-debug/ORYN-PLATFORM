/**
 * Notes follow the AOI scope of the record they are attached to. A member
 * restricted to some AOIs must get the same 404 from listNotes / addNote as
 * from the record itself (regression: notes used to check org_id only).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addNote, listNotes, type NoteTarget } from "@/server/results/service";
import { closeTestDb, createOrg, insertAoi, resetDb, SQUARE } from "../helpers/db";
import { daysAgo, grantAoi, insertDetection, insertObservation, member, rows } from "./alerts.fixtures";

async function insertReport(orgId: string, aoiId: string | null, createdBy: string, reportType = "aoi") {
  const [r] = await rows<{ id: string }>`
    insert into reports (org_id, aoi_id, report_type, title, status, created_by)
    values (${orgId}, ${aoiId}, ${reportType}, 'Report', 'ready', ${createdBy}) returning id`;
  return r!.id;
}

describe("notes respect AOI restrictions", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  async function world() {
    const org = await createOrg("notes-org");
    const granted = await insertAoi(org.id, "Granted field");
    const other = await insertAoi(org.id, "Other field", SQUARE(-77.5, 35.8));
    const restricted = await member(org, "analyst", true);
    await grantAoi(org.id, restricted.membershipId, granted);
    const admin = await member(org, "org_admin");
    const targets = async (aoiId: string) => ({
      aoi: aoiId,
      detection: await insertDetection(org.id, aoiId),
      observation: (await insertObservation(org.id, aoiId, { observedAt: daysAgo(3) })).id,
      report: await insertReport(org.id, aoiId, admin.id),
    });
    return { org, restricted, admin, granted: await targets(granted), other: await targets(other) };
  }

  it("a restricted member can read and write notes on records in a granted AOI", async () => {
    const w = await world();
    for (const [type, id] of Object.entries(w.granted) as [NoteTarget, string][]) {
      await addNote(w.restricted.access, type, id, `note on ${type}`);
      const notes = await listNotes(w.restricted.access, type, id);
      expect(notes.map((n) => n.body)).toEqual([`note on ${type}`]);
    }
  });

  it("a restricted member gets 404 for notes on any record outside their AOIs", async () => {
    const w = await world();
    for (const [type, id] of Object.entries(w.other) as [NoteTarget, string][]) {
      await addNote(w.admin.access, type, id, "admin note");
      await expect(listNotes(w.restricted.access, type, id)).rejects.toMatchObject({ status: 404 });
      await expect(addNote(w.restricted.access, type, id, "should fail")).rejects.toMatchObject({ status: 404 });
    }
    const [{ n }] = await rows<{ n: number }>`select count(*)::int as n from notes where body = 'should fail'`;
    expect(n).toBe(0);
  });

  it("org-wide reports: a restricted member sees notes only on reports they created", async () => {
    const w = await world();
    const mine = await insertReport(w.org.id, null, w.restricted.id);
    const theirs = await insertReport(w.org.id, null, w.admin.id);
    await addNote(w.restricted.access, "report", mine, "mine");
    expect((await listNotes(w.restricted.access, "report", mine)).length).toBe(1);
    await expect(listNotes(w.restricted.access, "report", theirs)).rejects.toMatchObject({ status: 404 });
  });

  it("audit reports need audit.read for notes too", async () => {
    const w = await world();
    const audit = await insertReport(w.org.id, null, w.admin.id, "audit");
    const analyst = await member(w.org, "analyst");
    await expect(listNotes(analyst.access, "report", audit)).rejects.toMatchObject({ status: 404 });
    await expect(listNotes(w.admin.access, "report", audit)).resolves.toEqual([]);
  });

  it("an unrestricted member reaches every AOI; another org reaches none", async () => {
    const w = await world();
    const analyst = await member(w.org, "analyst");
    for (const [type, id] of Object.entries(w.other) as [NoteTarget, string][]) {
      await expect(listNotes(analyst.access, type, id)).resolves.toEqual([]);
    }
    const otherOrg = await createOrg("notes-other");
    const outsider = await member(otherOrg, "org_admin");
    for (const [type, id] of Object.entries(w.granted) as [NoteTarget, string][]) {
      await expect(listNotes(outsider.access, type, id)).rejects.toMatchObject({ status: 404 });
      await expect(addNote(outsider.access, type, id, "cross-tenant")).rejects.toMatchObject({ status: 404 });
    }
  });
});
