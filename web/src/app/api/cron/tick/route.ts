import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/server/config/env";
import { buildRegistry } from "@/server/jobs/registry";
import { schedulerTick } from "@/server/jobs/scheduler";
import { drainOnce } from "@/server/jobs/worker";
import { log } from "@/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduler tick + bounded job drain for hosts without a long-running worker
 * (e.g. a Vercel Cron every minute). Requires `Authorization: Bearer
 * $ORYN_CRON_SECRET`; disabled when the secret is unset.
 */
export async function GET(req: Request) {
  const secret = env.cronSecret();
  if (!secret) return NextResponse.json({ error: "Cron is not configured (ORYN_CRON_SECRET unset)." }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tick = await schedulerTick();
  const drained = await drainOnce(buildRegistry(), { maxJobs: 25, deadlineMs: 240_000, concurrency: 2 });
  log.info("cron.tick", { tick, drained });
  return NextResponse.json({ tick, drained }, { headers: { "Cache-Control": "no-store" } });
}
