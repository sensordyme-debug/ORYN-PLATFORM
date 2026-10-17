/**
 * An API key acts for its organization only while its creator still belongs
 * to it with the right to manage keys (regression: keys kept working after
 * the creator was removed from the organization or demoted).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { removeMembership } from "@/server/accounts/service";
import { resolveApiKeyAccess } from "@/server/authz/access";
import { createApiKey, removeMember } from "@/server/orgs/service";
import { closeTestDb, createOrg, meta, resetDb } from "../helpers/db";
import { member, rows } from "./alerts.fixtures";

describe("API key lifecycle follows its creator's membership", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  async function setup() {
    const org = await createOrg("keys-org");
    const creator = await member(org, "org_admin");
    const other = await member(org, "org_admin");
    const { key, id } = await createApiKey(creator.access, { name: "integration", scopes: ["aoi.read"] });
    await expect(resolveApiKeyAccess(key, org.slug, meta)).resolves.toMatchObject({ org: { id: org.id } });
    return { org, creator, other, key, id };
  }

  it("removing the creator revokes the key and records why", async () => {
    const s = await setup();
    await removeMember(s.other.access, s.creator.membershipId);
    await expect(resolveApiKeyAccess(s.key, s.org.slug, meta)).rejects.toMatchObject({ status: 401 });
    const [k] = await rows<{ revoked_at: Date | null }>`select revoked_at from api_keys where id = ${s.id}`;
    expect(k?.revoked_at).not.toBeNull();
    const audit = await rows<{ metadata: { reason: string } }>`select metadata from audit_events where action = 'apikey.revoke' and target_id = ${s.id}`;
    expect(audit.map((a) => a.metadata.reason)).toEqual(["creator_removed_from_org"]);
  });

  it("removal through the accounts CLI revokes the key too", async () => {
    const s = await setup();
    await removeMembership({ type: "cli", label: "test" }, s.creator.email, s.org.slug);
    await expect(resolveApiKeyAccess(s.key, s.org.slug, meta)).rejects.toMatchObject({ status: 401 });
  });

  it("a key whose creator left before revocation existed no longer works", async () => {
    const s = await setup();
    await rows`delete from memberships where id = ${s.creator.membershipId}`;
    await expect(resolveApiKeyAccess(s.key, s.org.slug, meta)).rejects.toMatchObject({ status: 401 });
  });

  it("a demoted creator's key stops working while they cannot manage keys", async () => {
    const s = await setup();
    await rows`update memberships set role = 'viewer' where id = ${s.creator.membershipId}`;
    await expect(resolveApiKeyAccess(s.key, s.org.slug, meta)).rejects.toMatchObject({ status: 401 });
    await rows`update memberships set role = 'org_admin' where id = ${s.creator.membershipId}`;
    await expect(resolveApiKeyAccess(s.key, s.org.slug, meta)).resolves.toMatchObject({ org: { id: s.org.id } });
  });
});
