/** Small helpers for JSON route handlers. */
import { NextResponse } from "next/server";
import { DomainError } from "@/server/errors";
import { env } from "@/server/config/env";

/**
 * The caller's IP for rate limits and audit records. When the deployment
 * names a proxy-controlled header (ORYN_CLIENT_IP_HEADER, e.g. Railway's
 * X-Real-IP) only that header is trusted; otherwise the first
 * X-Forwarded-For hop, which a client can set — acceptable only behind a
 * proxy that overwrites it.
 */
export function clientIp(h: Headers): string | null {
  const configured = env.authClientIpHeader();
  const ip = configured ? h.get(configured)?.trim() : h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim();
  return ip ? ip.slice(0, 64) : null;
}

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function readJson(req: Request, maxBytes = 2_000_000): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new DomainError("too_large", "Request body is too large.", 422);
  const text = await req.text();
  if (text.length > maxBytes) throw new DomainError("too_large", "Request body is too large.", 422);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DomainError("invalid_json", "Request body must be valid JSON.", 400);
  }
}

export function searchParam(req: Request, name: string): string | undefined {
  const v = new URL(req.url).searchParams.get(name);
  return v === null || v === "" ? undefined : v;
}
