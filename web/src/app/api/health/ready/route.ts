import { NextResponse } from "next/server";
import { env } from "@/server/config/env";
import { readiness } from "@/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness: database reachable as the application role, migrations match
 * this release, object storage accepts a write/read/delete. 503 otherwise.
 * Only check states are returned; details are in the server log.
 */
export async function GET() {
  const r = await readiness();
  return NextResponse.json(
    { status: r.ready ? "ready" : "not_ready", service: "web", version: env.appVersion(), mode: r.mode, checks: r.checks, ...(r.worker ? { worker: r.worker } : {}) },
    { status: r.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
