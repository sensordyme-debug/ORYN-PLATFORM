/**
 * Scheduled alert evaluation (regression: every rule type declared a
 * "schedule" trigger but nothing ever queued one, so a data-gap rule could
 * not fire when imagery stopped arriving altogether, and a new rule waited
 * for new data before it was evaluated at all).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAlertRule, setAlertRuleEnabled, updateAlertRule } from "@/server/alerts/rule-service";
import { evaluateAlertsForAoi } from "@/server/alerts/pipeline";
import { withSystem } from "@/server/db/client";
import { enqueueScheduledEvaluations, scheduledEvaluationKey } from "@/server/jobs/scheduler";
import { closeTestDb, createOrg, insertAoi, resetDb, SQUARE } from "../helpers/db";
import { daysAgo, insertObservation, insertRule, member, rows } from "./alerts.fixtures";

type QueuedEval = { org_id: string; payload: { aoiId: string; trigger: { kind: string } }; idempotency_key: string };
const queuedEvaluations = () =>
  rows<QueuedEval>`select org_id, payload, idempotency_key from jobs where type = 'alerts.evaluate' and status = 'queued' order by idempotency_key`;

async function runQueuedEvaluations() {
  for (const j of await queuedEvaluations()) {
    await evaluateAlertsForAoi({ orgId: j.org_id, aoiId: j.payload.aoiId, trigger: { kind: j.payload.trigger.kind as "schedule" } });
    await rows`update jobs set status = 'succeeded', finished_at = now() where idempotency_key = ${j.idempotency_key}`;
  }
}

describe("scheduled alert evaluation", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("queues one evaluation per monitored AOI with an enabled rule, once per window", async () => {
    const org = await createOrg("sched-a");
    const ruled = await insertAoi(org.id, "Ruled");
    await rows`update aois set monitoring_enabled = true where id = ${ruled}`;
    const unmonitored = await insertAoi(org.id, "Unmonitored", SQUARE(-77.5, 35.8));
    await rows`update aois set monitoring_enabled = false where id = ${unmonitored}`;
    await insertRule(org.id, "stale_observations", { max_age_days: 5, kinds: [] });

    const quiet = await createOrg("sched-quiet");
    const noRules = await insertAoi(quiet.id, "No rules");
    await rows`update aois set monitoring_enabled = true where id = ${noRules}`;

    expect(await withSystem("test", (tx) => enqueueScheduledEvaluations(tx))).toBe(1);
    const queued = await queuedEvaluations();
    expect(queued.map((j) => [j.payload.aoiId, j.payload.trigger.kind, j.idempotency_key])).toEqual([[ruled, "schedule", scheduledEvaluationKey(ruled)]]);
    // Ticking again in the same window queues nothing new.
    expect(await withSystem("test", (tx) => enqueueScheduledEvaluations(tx))).toBe(0);
  });

  it("a data-gap rule fires on schedule when no new imagery arrives at all", async () => {
    const org = await createOrg("sched-gap");
    const aoi = await insertAoi(org.id, "Quiet field");
    await rows`update aois set monitoring_enabled = true, created_at = now() - interval '60 days' where id = ${aoi}`;
    await insertObservation(org.id, aoi, { observedAt: daysAgo(20) });
    await insertRule(org.id, "stale_observations", { max_age_days: 7, kinds: [] });

    await withSystem("test", (tx) => enqueueScheduledEvaluations(tx));
    await runQueuedEvaluations();
    const alerts = await rows<{ title: string; status: string }>`select title, status from alerts where aoi_id = ${aoi}`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toMatch(/^Data gap: no usable imagery for 20 days/);
    expect(alerts[0]!.status).toBe("open");
  });

  it("creating or re-enabling a rule evaluates existing data without waiting for new imagery", async () => {
    const org = await createOrg("sched-new-rule");
    const aoi = await insertAoi(org.id, "Field");
    await rows`update aois set monitoring_enabled = true, created_at = now() - interval '60 days' where id = ${aoi}`;
    await insertObservation(org.id, aoi, { observedAt: daysAgo(30) });
    const admin = await member(org, "org_admin");

    const rule = await createAlertRule(admin.access, {
      name: "Imagery gap",
      ruleType: "stale_observations",
      params: { max_age_days: 10 },
      severity: "moderate",
    } as Parameters<typeof createAlertRule>[1]);
    expect((await queuedEvaluations()).map((j) => j.payload.aoiId)).toEqual([aoi]);
    await runQueuedEvaluations();
    expect(await rows`select 1 from alerts where aoi_id = ${aoi} and rule_id = ${rule.id}`).toHaveLength(1);

    // An immediate edit is evaluated again with the new parameters.
    await updateAlertRule(admin.access, rule.id, { params: { max_age_days: 40 } } as Parameters<typeof updateAlertRule>[2]);
    expect(await queuedEvaluations()).toHaveLength(1);
    await runQueuedEvaluations();

    await setAlertRuleEnabled(admin.access, rule.id, false);
    expect(await queuedEvaluations()).toHaveLength(0);
    await setAlertRuleEnabled(admin.access, rule.id, true);
    expect(await queuedEvaluations()).toHaveLength(1);
  });
});
