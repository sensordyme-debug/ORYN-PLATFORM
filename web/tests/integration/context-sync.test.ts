/**
 * Context sync (weather, warnings, news) runs one job per provider, so a
 * provider failure is recorded as a failed job and retried — never hidden in
 * another provider's success — and GDELT's rate limit is honoured across
 * processes. Provider HTTP is replaced with recorded fixtures.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db/client";
import { claimJobs, enqueue } from "@/server/jobs/queue";
import { buildRegistry } from "@/server/jobs/registry";
import { executeJob } from "@/server/jobs/worker";
import { contextProvidersFor, enqueueContextSync } from "@/server/pipeline/context";
import { resetHostLimiter, setProviderFetch } from "@/server/providers/http";
import { acquireProviderSlot, startProviderCooldown } from "@/server/providers/request-slots";
import { closeTestDb, createOrg, insertAoi, ownerSql, resetDb } from "../helpers/db";

const fixture = (name: string) => readFileSync(path.resolve(__dirname, "../fixtures/providers", name), "utf8");
const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

type Route = (u: URL) => Response | null;
let calls: URL[] = [];
function routeFetch(...routes: Route[]) {
  calls = [];
  setProviderFetch(async (input) => {
    const u = new URL(input);
    calls.push(u);
    for (const r of routes) {
      const res = r(u);
      if (res) return res;
    }
    return new Response("not mocked", { status: 599 });
  });
}
const openMeteoOk: Route = (u) =>
  u.host === "archive-api.open-meteo.com" ? json(fixture("open-meteo-archive.json")) : u.host === "api.open-meteo.com" ? json(fixture("open-meteo-forecast.json")) : null;
const gdelt429: Route = (u) => (u.host === "api.gdeltproject.org" ? new Response(fixture("gdelt-rate-limit.txt"), { status: 429 }) : null);

async function contextAoi(orgId: string, sources: string[], newsTerms: string[] = []) {
  const id = await insertAoi(orgId, "Context field");
  await ownerSql()`update aois set data_sources = ${sources}, news_terms = ${newsTerms} where id = ${id}`;
  return id;
}

async function runReadyContextJobs() {
  const jobs = await claimJobs("test-worker", 20, ["aoi.context_sync"]);
  for (const j of jobs) await executeJob(j, buildRegistry(), "test-worker");
  return jobs.length;
}

const jobsFor = (aoiId: string) =>
  ownerSql()<{ provider: string | null; status: string; attempts: number; last_error: string | null; result: Record<string, unknown> | null; delay_s: number }[]>`
    select payload->>'provider' as provider, status, attempts, last_error, result,
           extract(epoch from (run_after - now()))::int as delay_s
      from jobs where type = 'aoi.context_sync' and payload->>'aoiId' = ${aoiId} order by created_at, payload->>'provider'`;

describe("context sync", () => {
  beforeEach(async () => {
    await resetDb();
    await ownerSql()`truncate provider_request_slots, provider_status`;
    resetHostLimiter();
  });
  afterEach(() => {
    setProviderFetch(null);
    vi.unstubAllEnvs();
  });
  afterAll(closeTestDb);

  it("queues one job per available provider, and none while one is still waiting", async () => {
    const org = await createOrg("org-a");
    const aoi = await contextAoi(org.id, ["nws", "open-meteo", "gdelt", "earth-search:sentinel-2-l2a"], ["Tarboro"]);
    const providers = contextProvidersFor({ data_sources: ["nws", "open-meteo", "gdelt"], news_terms: ["Tarboro"] });
    expect(providers).toEqual(["nws", "open-meteo", "gdelt"]);
    expect(contextProvidersFor({ data_sources: ["nws", "gdelt"], news_terms: [] })).toEqual(["nws"]); // news needs terms
    const enq = (key: string) => withTenant({ orgId: org.id }, (tx) => enqueueContextSync(tx, { orgId: org.id, aoiId: aoi, providers, reason: "test", priority: 90, key }));
    expect(await enq("first")).toBe(3);
    // Created and immediately edited: a second refresh must not queue duplicates.
    expect(await enq("second")).toBe(0);
    expect((await jobsFor(aoi)).map((j) => j.provider).sort()).toEqual(["gdelt", "nws", "open-meteo"]);
  });

  it("a GDELT rate limit fails only the GDELT job — recorded, shared cooldown, retried after it — while weather ingests", async () => {
    routeFetch(openMeteoOk, gdelt429);
    const org = await createOrg("org-a");
    const aoi = await contextAoi(org.id, ["open-meteo", "gdelt"], ["Tarboro"]);
    await withTenant({ orgId: org.id }, (tx) =>
      enqueueContextSync(tx, { orgId: org.id, aoiId: aoi, providers: ["open-meteo", "gdelt"], reason: "test", priority: 90, key: "k" }),
    );
    expect(await runReadyContextJobs()).toBe(2);

    const [gdelt, weather] = [...(await jobsFor(aoi))].sort((a, b) => (a.provider! < b.provider! ? -1 : 1));
    expect(weather).toMatchObject({ provider: "open-meteo", status: "succeeded", result: { provider: "open-meteo", status: "ingested" } });
    expect((weather!.result as { records: number }).records).toBeGreaterThan(0);
    // Not reported as success: the job is queued for retry after the 10-minute cooldown.
    expect(gdelt).toMatchObject({ provider: "gdelt", status: "queued", attempts: 1 });
    expect(gdelt!.last_error).toMatch(/429/);
    expect(gdelt!.delay_s).toBeGreaterThanOrEqual(9 * 60);
    expect(calls.filter((u) => u.host === "api.gdeltproject.org")).toHaveLength(1); // no immediate in-request retry

    const runs = await ownerSql()<{ provider_id: string; status: string; error: string | null; items_found: number }[]>`
      select provider_id, status, error, items_found from provider_sync_runs where aoi_id = ${aoi} order by provider_id`;
    expect(runs).toEqual([
      expect.objectContaining({ provider_id: "gdelt", status: "failed", error: expect.stringMatching(/429/) }),
      expect.objectContaining({ provider_id: "open-meteo", status: "succeeded", error: null }),
    ]);
    expect(runs[1]!.items_found).toBeGreaterThan(0);
    const [w] = await ownerSql()<{ n: number }[]>`select count(*)::int as n from weather_records where aoi_id = ${aoi}`;
    expect(w!.n).toBeGreaterThan(0);

    // Every process now skips GDELT until the cooldown ends — without calling it.
    const [slot] = await ownerSql()<{ ahead_s: number }[]>`
      select extract(epoch from (cooldown_until - now()))::int as ahead_s from provider_request_slots where provider_id = 'gdelt'`;
    expect(slot!.ahead_s).toBeGreaterThanOrEqual(9 * 60);
    await expect(acquireProviderSlot("gdelt", 5_500)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    expect(calls.filter((u) => u.host === "api.gdeltproject.org")).toHaveLength(1);
  });

  it("skips unavailable providers without reporting ingestion, and fails permanently on non-retryable errors", async () => {
    vi.stubEnv("OPEN_METEO_ALLOW_NONCOMMERCIAL", "false"); // no key and no non-commercial allowance
    routeFetch((u) => (u.host === "api.weather.gov" ? json(JSON.stringify({ title: "Bad request", detail: "Invalid point" }), 400) : null));
    const org = await createOrg("org-a");
    const aoi = await contextAoi(org.id, ["open-meteo", "nws"]);
    // Bypass enqueue-time filtering, as a job queued before a configuration change would.
    await enqueue({ orgId: org.id, type: "aoi.context_sync", payload: { aoiId: aoi, provider: "open-meteo" } });
    await enqueue({ orgId: org.id, type: "aoi.context_sync", payload: { aoiId: aoi, provider: "nws" } });
    await runReadyContextJobs();
    const jobs = await jobsFor(aoi);
    expect(jobs.find((j) => j.provider === "open-meteo")).toMatchObject({ status: "succeeded", result: { provider: "open-meteo", status: "skipped" } });
    expect(jobs.find((j) => j.provider === "nws")).toMatchObject({ status: "failed", last_error: expect.stringMatching(/400/) });
    const runs = await ownerSql()<{ provider_id: string; status: string }[]>`select provider_id, status from provider_sync_runs where aoi_id = ${aoi} order by provider_id`;
    expect(runs).toEqual([{ provider_id: "nws", status: "failed" }, { provider_id: "open-meteo", status: "skipped" }]);
    const [w] = await ownerSql()<{ n: number }[]>`select count(*)::int as n from weather_records where aoi_id = ${aoi}`;
    expect(w!.n).toBe(0);
  });

  it("splits jobs queued in the old all-providers format, and skips areas deleted before the job runs", async () => {
    const org = await createOrg("org-a");
    const aoi = await contextAoi(org.id, ["nws", "open-meteo"]);
    await enqueue({ orgId: org.id, type: "aoi.context_sync", payload: { aoiId: aoi, reason: "scheduled" } });
    routeFetch(); // the split itself makes no requests
    await runReadyContextJobs();
    const jobs = await jobsFor(aoi);
    expect(jobs[0]).toMatchObject({ provider: null, status: "succeeded", result: { status: "split", queued: 2 } });
    expect(jobs.filter((j) => j.provider && j.status === "queued").map((j) => j.provider).sort()).toEqual(["nws", "open-meteo"]);
    expect(calls).toHaveLength(0);

    await ownerSql()`delete from aois where id = ${aoi}`;
    await runReadyContextJobs();
    for (const j of (await ownerSql()<{ status: string; result: Record<string, unknown> }[]>`
      select status, result from jobs where type = 'aoi.context_sync' and payload->>'provider' is not null`)) {
      expect(j).toMatchObject({ status: "succeeded", result: { status: "skipped", reason: "aoi_deleted" } });
    }
  });

  it("spaces requests across callers on the database clock, and cooldowns block callers", async () => {
    const t0 = Date.now();
    await acquireProviderSlot("test-provider", 400);
    await acquireProviderSlot("test-provider", 400);
    await acquireProviderSlot("test-provider", 400);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(750);
    await startProviderCooldown("test-provider", 60_000, "test");
    const err = await acquireProviderSlot("test-provider", 400).catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limited", retryable: true });
    expect(err.retryAfterMs).toBeGreaterThan(55_000);
  });
});
