import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessError, resolveApiKeyAccess, resolveUserOrgAccess } from "@/server/authz/access";
import { createAoi, getAoi, listAois, setAoiArchived, updateAoi } from "@/server/aois/service";
import { DomainError } from "@/server/errors";
import {
  acceptInvitation,
  createApiKey,
  createInvitation,
  lookupInvitation,
  removeMember,
  revokeApiKey,
  updateMember,
} from "@/server/orgs/service";
import { addMember, closeTestDb, createOrg, createUser, meta, ownerSql, resetDb, SQUARE } from "../helpers/db";

async function accessFor(userId: string, slug: string) {
  return resolveUserOrgAccess({ id: userId, label: "t", isPlatformAdmin: false }, slug, meta);
}

describe("areas of interest", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("persists an AOI with a geodesic area, audits it, and queues a backfill", async () => {
    const org = await createOrg("farm-a", "agriculture");
    const u = await createUser();
    await addMember(org.id, u.id, "analyst");
    const access = await accessFor(u.id, "farm-a");
    const aoi = await createAoi(access, { name: "North field", kind: "field", geometry: SQUARE(-77.6, 35.9, 0.005) });
    expect(aoi.areaM2).toBeGreaterThan(240_000);
    expect(aoi.areaM2).toBeLessThan(260_000);
    expect(aoi.dataSources).toContain("earth-search:sentinel-2-l2a");
    expect(aoi.boundarySource.method).toBe("drawn");
    const audit = await ownerSql()`select action from audit_events where target_id = ${aoi.id}`;
    expect(audit.map((a) => a.action)).toEqual(["aoi.create"]);
    const jobs = await ownerSql()<{ type: string; provider: string | null }[]>`
      select type, payload->>'provider' as provider from jobs where org_id = ${org.id} order by type, provider`;
    // One imagery backfill, and one context job per weather source the area uses
    // (GDELT news is only queued for areas with news terms; this one has none).
    const contextSources = aoi.dataSources.filter((s) => s === "nws" || s === "open-meteo").sort();
    expect(jobs).toEqual([
      { type: "aoi.catalog_sync", provider: null },
      ...contextSources.map((provider) => ({ type: "aoi.context_sync", provider })),
    ]);
    expect(contextSources.length).toBeGreaterThan(0);
  });

  it("buffers a point into a circle of the requested radius", async () => {
    const org = await createOrg("city-a", "municipal");
    const u = await createUser();
    await addMember(org.id, u.id, "analyst");
    const access = await accessFor(u.id, "city-a");
    const aoi = await createAoi(access, {
      name: "Water tower",
      kind: "public_asset",
      geometry: { type: "Point", coordinates: [-77.5358, 35.8968] },
      bufferM: 100,
    });
    expect(aoi.areaM2).toBeGreaterThan(Math.PI * 100 * 100 * 0.98);
    expect(aoi.areaM2).toBeLessThan(Math.PI * 100 * 100 * 1.01);
    expect(aoi.inputGeometry?.type).toBe("Point");
  });

  it("rejects self-intersecting boundaries with a clear message", async () => {
    const org = await createOrg("farm-a");
    const u = await createUser();
    await addMember(org.id, u.id, "analyst");
    const access = await accessFor(u.id, "farm-a");
    const bowtie = { type: "Polygon" as const, coordinates: [[[-77.6, 35.9], [-77.59, 35.91], [-77.59, 35.9], [-77.6, 35.91], [-77.6, 35.9]]] as [number, number][][] };
    await expect(createAoi(access, { name: "Bad", kind: "field", geometry: bowtie })).rejects.toThrow(/crosses itself/);
  });

  it("enforces role permissions on the server", async () => {
    const org = await createOrg("farm-a");
    const viewer = await createUser();
    await addMember(org.id, viewer.id, "viewer");
    const access = await accessFor(viewer.id, "farm-a");
    await expect(createAoi(access, { name: "x", kind: "field", geometry: SQUARE(-77.6, 35.9) })).rejects.toBeInstanceOf(AccessError);
    expect(access.can("aoi.read")).toBe(true);
    expect(access.can("exports.create")).toBe(false);
  });

  it("does not let another tenant read or modify an AOI by guessing its id", async () => {
    const a = await createOrg("org-a");
    const b = await createOrg("org-b");
    const ua = await createUser();
    const ub = await createUser();
    await addMember(a.id, ua.id, "analyst");
    await addMember(b.id, ub.id, "org_admin");
    const aoi = await createAoi(await accessFor(ua.id, "org-a"), { name: "A", kind: "field", geometry: SQUARE(-77.6, 35.9) });
    const accessB = await accessFor(ub.id, "org-b");
    await expect(getAoi(accessB, aoi.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateAoi(accessB, aoi.id, { name: "pwned" })).rejects.toMatchObject({ code: "not_found" });
    await expect(setAoiArchived(accessB, aoi.id, true)).rejects.toMatchObject({ code: "not_found" });
    expect((await listAois(accessB)).total).toBe(0);
  });

  it("restricted members only see AOIs granted to them", async () => {
    const org = await createOrg("farm-a");
    const admin = await createUser();
    const op = await createUser();
    await addMember(org.id, admin.id, "org_admin");
    const opMembership = await addMember(org.id, op.id, "field_operator", true);
    const adminAccess = await accessFor(admin.id, "farm-a");
    const f1 = await createAoi(adminAccess, { name: "Field 1", kind: "field", geometry: SQUARE(-77.6, 35.9) });
    const f2 = await createAoi(adminAccess, { name: "Field 2", kind: "field", geometry: SQUARE(-77.5, 35.9) });
    await updateMember(adminAccess, opMembership, { grantedAoiIds: [f1.id] });
    const opAccess = await accessFor(op.id, "farm-a");
    expect((await listAois(opAccess)).items.map((a) => a.name)).toEqual(["Field 1"]);
    await expect(getAoi(opAccess, f2.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("archived AOIs stop monitoring and cannot be edited until restored", async () => {
    const org = await createOrg("farm-a");
    const u = await createUser();
    await addMember(org.id, u.id, "analyst");
    const access = await accessFor(u.id, "farm-a");
    const aoi = await createAoi(access, { name: "F", kind: "field", geometry: SQUARE(-77.6, 35.9) });
    const archived = await setAoiArchived(access, aoi.id, true);
    expect(archived.status).toBe("archived");
    expect(archived.monitoringEnabled).toBe(false);
    await expect(updateAoi(access, aoi.id, { name: "G" })).rejects.toBeInstanceOf(DomainError);
  });
});

describe("organization administration", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("keeps at least one administrator", async () => {
    const org = await createOrg("org-a");
    const admin = await createUser();
    const mId = await addMember(org.id, admin.id, "org_admin");
    const access = await accessFor(admin.id, "org-a");
    await expect(updateMember(access, mId, { role: "viewer" })).rejects.toMatchObject({ code: "last_admin" });
    await expect(removeMember(access, mId)).rejects.toMatchObject({ code: "last_admin" });
  });

  it("invitations are single-use and bound to the invited email", async () => {
    const org = await createOrg("org-a");
    const admin = await createUser("admin@example.test");
    await addMember(org.id, admin.id, "org_admin");
    const access = await accessFor(admin.id, "org-a");
    const inv = await createInvitation(access, { email: "Analyst@Example.test", role: "analyst" });
    const token = inv.link.split("/invite/")[1]!;
    expect(await lookupInvitation(token)).toMatchObject({ state: "valid", email: "analyst@example.test", role: "analyst" });

    const stranger = await createUser("someone@example.test");
    await expect(acceptInvitation(token, stranger, meta)).rejects.toMatchObject({ code: "email_mismatch" });

    const invitee = await createUser("analyst@example.test");
    expect(await acceptInvitation(token, invitee, meta)).toBe("org-a");
    const joined = await accessFor(invitee.id, "org-a");
    expect(joined.role).toBe("analyst");
    expect((await lookupInvitation(token)).state).toBe("accepted");
    await expect(acceptInvitation(token, invitee, meta)).rejects.toMatchObject({ code: "invitation_invalid" });
    expect(await lookupInvitation("x".repeat(43))).toEqual({ state: "unknown" });
  });

  it("API keys act for one org with limited scopes and stop working when revoked", async () => {
    const a = await createOrg("org-a");
    await createOrg("org-b");
    const admin = await createUser();
    await addMember(a.id, admin.id, "org_admin");
    const access = await accessFor(admin.id, "org-a");
    const { id, key } = await createApiKey(access, { name: "GIS sync", scopes: ["aoi.read", "results.read"] });
    const viaKey = await resolveApiKeyAccess(key, "org-a", meta);
    expect(viaKey.org.slug).toBe("org-a");
    expect(viaKey.can("aoi.read")).toBe(true);
    expect(viaKey.can("aoi.write")).toBe(false);
    expect(viaKey.can("members.manage")).toBe(false);
    await expect(resolveApiKeyAccess(key, "org-b", meta)).rejects.toMatchObject({ status: 404 });
    await expect(resolveApiKeyAccess(key.slice(0, -2) + "xx", "org-a", meta)).rejects.toMatchObject({ status: 401 });
    await revokeApiKey(access, id);
    await expect(resolveApiKeyAccess(key, "org-a", meta)).rejects.toMatchObject({ status: 401 });
    const [stored] = await ownerSql()`select key_hash from api_keys where id = ${id}`;
    // Format oryn_<8-char prefix>_<secret>; the base64url secret may itself contain "_".
    const secret = key.slice("oryn_".length + 9);
    expect(secret).toHaveLength(43);
    expect(Buffer.from(stored!.key_hash).toString("utf8")).not.toContain(secret);
  });
});
