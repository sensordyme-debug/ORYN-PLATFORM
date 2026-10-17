import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessError, resolveUserOrgAccess } from "@/server/authz/access";
import { withTenant } from "@/server/db/client";
import { addMember, closeTestDb, createOrg, createUser, insertAoi, meta, resetDb } from "../helpers/db";

describe("tenant isolation", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("a member of org A cannot resolve org B", async () => {
    const a = await createOrg("org-a");
    await createOrg("org-b");
    const u = await createUser();
    await addMember(a.id, u.id, "analyst");
    const access = await resolveUserOrgAccess({ id: u.id, label: u.email, isPlatformAdmin: false }, "org-a", meta);
    expect(access.org.id).toBe(a.id);
    await expect(resolveUserOrgAccess({ id: u.id, label: u.email, isPlatformAdmin: false }, "org-b", meta)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("unknown org and non-member org are indistinguishable", async () => {
    await createOrg("org-b");
    const u = await createUser();
    const e1 = await resolveUserOrgAccess({ id: u.id, label: "", isPlatformAdmin: false }, "org-b", meta).catch((e) => e);
    const e2 = await resolveUserOrgAccess({ id: u.id, label: "", isPlatformAdmin: false }, "no-such-org", meta).catch((e) => e);
    expect(e1).toBeInstanceOf(AccessError);
    expect(e2).toBeInstanceOf(AccessError);
    expect([e1.status, e1.message]).toEqual([e2.status, e2.message]);
  });

  it("platform admins get no implicit tenant access", async () => {
    await createOrg("org-b");
    const u = await createUser();
    await expect(resolveUserOrgAccess({ id: u.id, label: "", isPlatformAdmin: true }, "org-b", meta)).rejects.toMatchObject({ status: 404 });
  });

  it("RLS hides another tenant's rows even when the query omits an org filter", async () => {
    const a = await createOrg("org-a");
    const b = await createOrg("org-b");
    const aoiB = await insertAoi(b.id, "B secret field");
    await insertAoi(a.id, "A field");
    const rows = await withTenant({ orgId: a.id }, (tx) => tx<{ name: string }[]>`select name from aois`);
    expect(rows.map((r) => r.name)).toEqual(["A field"]);
    const byId = await withTenant({ orgId: a.id }, (tx) => tx`select id from aois where id = ${aoiB}`);
    expect(byId).toHaveLength(0);
    const updated = await withTenant({ orgId: a.id }, (tx) => tx`update aois set name = 'pwned' where id = ${aoiB} returning id`);
    expect(updated).toHaveLength(0);
  });

  it("RLS rejects writing a row into another tenant", async () => {
    const a = await createOrg("org-a");
    const b = await createOrg("org-b");
    await expect(
      withTenant({ orgId: a.id }, (tx) => tx`insert into notes (org_id, target_type, target_id, body) values (${b.id}, 'aoi', gen_random_uuid(), 'x')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("the audit trail is append-only for the application role", async () => {
    const a = await createOrg("org-a");
    await withTenant({ orgId: a.id }, (tx) => tx`insert into audit_events (org_id, actor_type, action) values (${a.id}, 'system', 'test')`);
    await expect(withTenant({ orgId: a.id }, (tx) => tx`update audit_events set action = 'tampered'`)).rejects.toThrow(/permission denied/);
    await expect(withTenant({ orgId: a.id }, (tx) => tx`delete from audit_events`)).rejects.toThrow(/permission denied/);
  });
});
