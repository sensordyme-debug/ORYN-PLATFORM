import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db/client";
import { backoffMs, claimJobs, enqueue, PermanentJobError, reclaimStaleJobs, retryJob } from "@/server/jobs/queue";
import { executeJob, type HandlerRegistry } from "@/server/jobs/worker";
import { closeTestDb, createOrg, ownerSql, resetDb } from "../helpers/db";

const registry = (run: () => Promise<unknown>): HandlerRegistry => new Map([["test.job", { type: "test.job", describe: "test", run }]]);

async function job(id: string) {
  const [j] = await ownerSql()`select * from jobs where id = ${id}`;
  return j!;
}

describe("job queue", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("deduplicates enqueues by idempotency key", async () => {
    const org = await createOrg("org-a");
    const first = await enqueue({ orgId: org.id, type: "test.job", idempotencyKey: "k1" });
    const second = await enqueue({ orgId: org.id, type: "test.job", idempotencyKey: "k1" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const [row] = await ownerSql()<{ n: number }[]>`select count(*)::int as n from jobs`;
    expect(row?.n).toBe(1);
  });

  it("never hands the same job to two workers", async () => {
    const org = await createOrg("org-a");
    for (let i = 0; i < 5; i++) await enqueue({ orgId: org.id, type: "test.job" });
    const [a, b] = await Promise.all([claimJobs("w1", 5), claimJobs("w2", 5)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
  });

  it("a failing handler is retried with backoff, then dead-lettered — never marked succeeded", async () => {
    const org = await createOrg("org-a");
    const { id } = await enqueue({ orgId: org.id, type: "test.job", maxAttempts: 2 });
    const failing = registry(async () => {
      throw new Error("provider unreachable");
    });
    const [claimed] = await claimJobs("w1", 1);
    expect(await executeJob(claimed!, failing, "w1")).toBe("queued");
    let j = await job(id);
    expect(j.status).toBe("queued");
    expect(new Date(j.run_after).getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(j.last_error).toBe("provider unreachable");

    await ownerSql()`update jobs set run_after = now() where id = ${id}`;
    const [again] = await claimJobs("w1", 1);
    expect(await executeJob(again!, failing, "w1")).toBe("dead");
    j = await job(id);
    expect(j.status).toBe("dead");
    expect(j.errors).toHaveLength(2);

    expect(await withSystem("t", (tx) => retryJob(tx, id, "tester"))).toBe(true);
    expect((await job(id)).status).toBe("queued");
  });

  it("permanent errors fail immediately without retry", async () => {
    const org = await createOrg("org-a");
    const { id } = await enqueue({ orgId: org.id, type: "test.job", maxAttempts: 5 });
    const [claimed] = await claimJobs("w1", 1);
    await executeJob(claimed!, registry(async () => { throw new PermanentJobError("AOI archived"); }), "w1");
    expect((await job(id)).status).toBe("failed");
  });

  it("succeeds only when the handler returns, and stores the result", async () => {
    const org = await createOrg("org-a");
    const { id } = await enqueue({ orgId: org.id, type: "test.job" });
    const [claimed] = await claimJobs("w1", 1);
    expect(await executeJob(claimed!, registry(async () => ({ observations: 3 })), "w1")).toBe("succeeded");
    const j = await job(id);
    expect(j.status).toBe("succeeded");
    expect(j.result).toEqual({ observations: 3 });
  });

  it("reclaims jobs whose worker stopped heart-beating and counts the attempt", async () => {
    const org = await createOrg("org-a");
    const { id } = await enqueue({ orgId: org.id, type: "test.job", maxAttempts: 3 });
    await claimJobs("crashed-worker", 1);
    await ownerSql()`update jobs set heartbeat_at = now() - interval '10 minutes' where id = ${id}`;
    expect(await reclaimStaleJobs(120)).toBe(1);
    const j = await job(id);
    expect(j.status).toBe("queued");
    expect(j.attempts).toBe(1);
    expect(j.last_error).toMatch(/stopped responding/);
  });

  it("backoff grows exponentially and is capped", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(3, mid)).toBe(120_000);
    expect(backoffMs(20, mid)).toBe(3_600_000);
  });
});
