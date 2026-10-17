/** Worker liveness records (table worker_heartbeats, migration 0007). Not tenant data. */
import { hostname } from "node:os";
import { withSystem } from "@/server/db/client";
import type { WorkerStatus } from "@/server/jobs/worker";

export async function recordWorkerHeartbeat(s: WorkerStatus, info: { scheduler: boolean; concurrency: number; version: string }): Promise<void> {
  await withSystem("worker.heartbeat", async (tx) => {
    await tx`
      insert into worker_heartbeats (worker_id, hostname, pid, version, scheduler, concurrency, in_flight, started_at, last_seen_at)
      values (${s.workerId}, ${hostname()}, ${process.pid}, ${info.version}, ${info.scheduler}, ${info.concurrency}, ${s.inFlight},
              to_timestamp(${s.startedAt / 1000}), now())
      on conflict (worker_id) do update set last_seen_at = now(), in_flight = excluded.in_flight`;
    // Keep the table small: forget workers not seen for a week.
    if (Math.random() < 0.05) await tx`delete from worker_heartbeats where last_seen_at < now() - interval '7 days'`;
  });
}

export async function removeWorkerHeartbeat(workerId: string): Promise<void> {
  await withSystem("worker.heartbeat", (tx) => tx`delete from worker_heartbeats where worker_id = ${workerId}`);
}
