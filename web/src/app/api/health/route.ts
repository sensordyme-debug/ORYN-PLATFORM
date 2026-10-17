import { NextResponse } from "next/server";
import { env } from "@/server/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness: the process is serving requests. No dependencies are touched. */
export function GET() {
  return NextResponse.json({ status: "ok", service: "web", version: env.appVersion() }, { headers: { "Cache-Control": "no-store" } });
}
