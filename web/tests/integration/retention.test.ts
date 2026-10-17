import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/client";
import { applyRetention, retentionPolicy, retentionPurgeHandler } from "@/server/retention";
import { JOB } from "@/server/jobs/types";
import { claimJobs, enqueue } from "@/server/jobs/queue";
import { executeJob } from "@/server/jobs/worker";
import { orgKey, storage } from "@/server/storage";
import { closeTestDb, createOrg, createUser, insertAoi, ownerSql, resetDb } from "../helpers/db";
import { daysAgo, rows } from "./alerts.fixtures";

async function seedOrg(slug: string) {
  const org = await createOrg(slug);
  const aoi = await insertAoi(org.id, `${slug} field`);
  const user = await createUser();
  const sql = ownerSql();

  for (const d of [200, 100, 60, 5]) {
    await sql`insert into audit_events (org_id, actor_type, action, created_at) values (${org.id}, 'system', ${`test.${d}d`}, ${daysAgo(d)})`;
  }
  for (const d of [30, 3]) {
    const [a] = await sql<{ id: string }[]>`
      insert into news_articles (provider_id, url, canonical_url, title, domain, title_fingerprint)
      values ('gdelt', ${`https://x.test/${randomUUID()}`}, ${`https://x.test/${randomUUID()}`}, 'Story', 'x.test', ${randomUUID()})
      returning id`;
    await sql`insert into aoi_news_matches (org_id, aoi_id, article_id, matched_terms, location_match, category, story_key, created_at)
              values (${org.id}, ${aoi}, ${a!.id}, '{flood}', 'term_in_title', 'flood', 's1', ${daysAgo(d)})`;
  }
  const key = orgKey(org.id, "exports", randomUUID(), "old.csv");
  await storage().put(key, Buffer.from("a,b\r\n"), "text/csv");
  const [expired] = await sql<{ id: string }[]>`
    insert into exports (org_id, export_type, subject, status, storage_key, filename, expires_at)
    values (${org.id}, 'csv', 'aois', 'ready', ${key}, 'old.csv', now() - interval '1 hour') returning id`;
  const [fresh] = await sql<{ id: string }[]>`
    insert into exports (org_id, export_type, subject, status, storage_key, filename, expires_at)
    values (${org.id}, 'csv', 'aois', 'ready', ${orgKey(org.id, "exports", "fresh.csv")}, 'fresh.csv', now() + interval '3 days') returning id`;

  for (const [status, d] of [["succeeded", 40], ["cancelled", 40], ["failed", 40], ["succeeded", 2], ["dead", 90]] as const) {
    await sql`insert into jobs (org_id, type, status, finished_at) values (${org.id}, 'test.job', ${status}, ${daysAgo(d)})`;
  }

  const [rule] = await sql<{ id: string }[]>`insert into alert_rules (org_id, name, rule_type, severity) values (${org.id}, 'r', 'ndvi_below', 'low') returning id`;
  const [alert] = await sql<{ id: string }[]>`
    insert into alerts (org_id, rule_id, aoi_id, severity, title, explanation, dedupe_key)
    values (${org.id}, ${rule!.id}, ${aoi}, 'low', 't', '{}'::jsonb, ${randomUUID()}) returning id`;
  const users = [user.id, (await createUser()).id, (await createUser()).id];
  const reads: (Date | null)[] = [daysAgo(120), daysAgo(10), null];
  for (let i = 0; i < users.length; i++) {
    await sql`insert into notifications (org_id, user_id, alert_id, channel, status, read_at, created_at)
              values (${org.id}, ${users[i]!}, ${alert!.id}, 'in_app', 'sent', ${reads[i] ?? null}, ${daysAgo(130)})`;
  }
  return { org, key, expiredId: expired!.id, freshId: fresh!.id };
}

describe("retention", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("computes the effective policy and never goes below the 90-day audit minimum", () => {
    expect(retentionPolicy({})).toEqual({ auditDays: 365, newsDays: 180, exportsDays: 7, jobsDays: 30, notificationsReadDays: 90 });
    expect(retentionPolicy({ retention: { auditDays: 10, newsDays: 7 } })).toMatchObject({ auditDays: 90, newsDays: 7 });
  });

  it("purges the right rows for one org only, respects the audit minimum, and audits the purge", async () => {
    const a = await seedOrg("org-a");
    const b = await seedOrg("org-b");
    await ownerSql()`update organizations set settings = ${ownerSql().json({ retention: { auditDays: 30, newsDays: 10, jobsDays: 7 } })} where id = ${a.org.id}`;

    const r = await applyRetention(a.org.id);
    expect(r).toMatchObject({ auditEvents: 2, newsMatches: 1, exportsExpired: 1, exportFilesDeleted: 1, jobs: 2, notifications: 1 });
    expect(r.policy.auditDays).toBe(90);

    const audit = await rows<{ action: string }>`select action from audit_events where org_id = ${a.org.id} order by created_at`;
    expect(audit.map((x) => x.action)).toEqual(["test.60d", "test.5d", "retention.purge"]);
    expect(await rows`select created_at from aoi_news_matches where org_id = ${a.org.id}`).toHaveLength(1);
    expect(await rows`select status, storage_key from exports where id = ${a.expiredId}`).toEqual([{ status: "expired", storage_key: null }]);
    expect(await storage().get(a.key)).toBeNull();
    expect(await rows`select status from exports where id = ${a.freshId}`).toEqual([{ status: "ready" }]);
    expect((await rows<{ status: string }>`select status::text as status from jobs where org_id = ${a.org.id} order by status::text`).map((j) => j.status)).toEqual(["dead", "failed", "succeeded"]);
    expect(await rows`select id from notifications where org_id = ${a.org.id}`).toHaveLength(2);
    const [purge] = await rows<{ actor_type: string; metadata: { purged: Record<string, number> } }>`
      select actor_type, metadata from audit_events where org_id = ${a.org.id} and action = 'retention.purge'`;
    expect(purge!.actor_type).toBe("system");
    expect(purge!.metadata.purged).toMatchObject({ audit_events: 2, news_matches: 1, exports_expired: 1, jobs: 2, notifications: 1 });

    // Org B is untouched.
    expect(await rows`select id from audit_events where org_id = ${b.org.id}`).toHaveLength(4);
    expect(await rows`select status from exports where id = ${b.expiredId}`).toEqual([{ status: "ready" }]);
    expect(await storage().get(b.key)).not.toBeNull();
    expect(await rows`select id from jobs where org_id = ${b.org.id}`).toHaveLength(5);
  });

  it("the database refuses purging audit events younger than 90 days", async () => {
    const org = await createOrg("org-a");
    await expect(withTenant({ orgId: org.id }, (tx) => tx`select purge_audit_events(${org.id}, now() - interval '30 days')`)).rejects.toThrow(/at least 90 days/);
  });

  it("the platform job fans out one purge job per organization per day", async () => {
    await createOrg("org-a");
    await createOrg("org-b");
    await enqueue({ orgId: null, type: JOB.retentionPurge });
    const registry = new Map([[retentionPurgeHandler.type, retentionPurgeHandler]]);
    const [platform] = await claimJobs("w1", 1, [JOB.retentionPurge]);
    expect(await executeJob(platform!, registry, "w1")).toBe("succeeded");
    const children = await rows<{ org_id: string; status: string }>`select org_id, status from jobs where type = ${JOB.retentionPurge} and org_id is not null`;
    expect(children).toHaveLength(2);
    for (const j of await claimJobs("w1", 5, [JOB.retentionPurge])) expect(await executeJob(j, registry, "w1")).toBe("succeeded");
    expect(await rows`select id from audit_events where action = 'retention.purge'`).toHaveLength(2);
  });
});
