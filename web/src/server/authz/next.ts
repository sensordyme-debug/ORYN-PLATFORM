import "server-only";
import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Permission } from "@/lib/authz";
import { getSessionUser, loadSessionUser, passwordChangePath, requestMeta, requireUser } from "@/server/auth/session";
import { AccessError, resolveApiKeyAccess, resolveUserOrgAccess, type OrgAccess } from "@/server/authz/access";
import { ConfigError } from "@/server/config/env";
import { DomainError, fromPgError } from "@/server/errors";
import { clientIp } from "@/server/http";
import { log } from "@/server/log";
import { rateLimit } from "@/server/rate-limit";

// ── Pages ─────────────────────────────────────────────────────

/**
 * Resolve access for an org page. Non-members get the 404 page; accounts that
 * must first replace an administrator-issued password are sent to do so.
 */
export async function getOrgPageAccess(slug: string): Promise<OrgAccess> {
  const user = await requireUser(`/app/${slug}`);
  try {
    return await resolveUserOrgAccess({ id: user.id, label: user.label, isPlatformAdmin: user.isPlatformAdmin }, slug, await requestMeta());
  } catch (err) {
    if (err instanceof AccessError && err.status === 404) notFound();
    if (err instanceof AccessError && err.code === "password_change_required") redirect(passwordChangePath(`/app/${slug}`));
    if (err instanceof AccessError && err.status === 401) redirect(`/login?next=${encodeURIComponent(`/app/${slug}`)}`);
    throw err;
  }
}

// ── Server actions ────────────────────────────────────────────

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code: string; fields?: Record<string, string>; ref?: string };

export function toActionError(err: unknown): Extract<ActionResult, { ok: false }> {
  if (err instanceof AccessError) return { ok: false, error: err.message, code: err.code };
  if (err instanceof DomainError) return { ok: false, error: err.message, code: err.code, fields: err.fields };
  if (err instanceof z.ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "form";
      if (!fields[key]) fields[key] = issue.message;
    }
    return { ok: false, error: "Please correct the highlighted fields.", code: "invalid", fields };
  }
  const pg = fromPgError(err);
  if (pg) return { ok: false, error: pg.message, code: pg.code };
  if (err instanceof ConfigError) {
    log.error("config_error", { variable: err.variable, message: err.message });
    return { ok: false, error: "This feature is not configured on the server.", code: "not_configured" };
  }
  const ref = randomUUID().slice(0, 8);
  log.error("action_failed", { ref, err });
  return { ok: false, error: `Something went wrong (reference ${ref}). The error has been logged.`, code: "internal", ref };
}

/** Run a server action as the signed-in user for an org, enforcing a permission. */
export async function orgAction<T>(
  slug: string,
  permission: Permission,
  fn: (access: OrgAccess) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, error: "Your session has expired. Sign in again.", code: "unauthenticated" };
    const access = await resolveUserOrgAccess({ id: user.id, label: user.label, isPlatformAdmin: user.isPlatformAdmin }, slug, await requestMeta());
    access.assert(permission);
    return { ok: true, data: await fn(access) };
  } catch (err) {
    return toActionError(err);
  }
}

// ── Route handlers ────────────────────────────────────────────

export type ApiContext = { access: OrgAccess; requestId: string };

function jsonError(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status, headers: { "Cache-Control": "no-store" } });
}

export function apiErrorResponse(err: unknown, requestId: string): NextResponse {
  if (err instanceof AccessError) return jsonError(err.status, err.code, err.message);
  if (err instanceof DomainError) return jsonError(err.status, err.code, err.message, err.fields ? { fields: err.fields } : undefined);
  if (err instanceof z.ZodError) {
    return jsonError(422, "invalid", "Request validation failed.", {
      issues: err.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const pg = fromPgError(err);
  if (pg) return jsonError(pg.status, pg.code, pg.message);
  if (err instanceof ConfigError) {
    log.error("config_error", { requestId, variable: err.variable });
    return jsonError(503, "not_configured", "This feature is not configured on the server.");
  }
  log.error("api_failed", { requestId, err });
  return jsonError(500, "internal", `Internal error (reference ${requestId.slice(0, 8)}).`);
}

/**
 * Authenticate an /api/v1/orgs/[org]/… request with either a session cookie
 * or `Authorization: Bearer oryn_…`, enforce a permission and rate limit,
 * and run the handler. Errors become JSON responses with safe messages.
 */
export function orgApi<P extends { org: string }>(
  permission: Permission,
  handler: (req: Request, ctx: ApiContext, params: P) => Promise<Response>,
  opts: { rateLimit?: { limit: number; windowMs: number } } = {},
) {
  return async (req: Request, routeCtx: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const params = await routeCtx.params;
      const meta = {
        ip: clientIp(req.headers),
        userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      };
      const authz = req.headers.get("authorization");
      let access: OrgAccess;
      if (authz?.toLowerCase().startsWith("bearer ")) {
        access = await resolveApiKeyAccess(authz.slice(7), params.org, meta);
      } else {
        const user = await loadSessionUser(req.headers);
        if (!user) throw new AccessError(401, "unauthenticated", "Authentication required.");
        access = await resolveUserOrgAccess({ id: user.id, label: user.label, isPlatformAdmin: user.isPlatformAdmin }, params.org, meta);
      }
      const rl = opts.rateLimit ?? { limit: 240, windowMs: 60_000 };
      const principalKey = access.principal.type === "user" ? access.principal.userId : access.principal.type === "api_key" ? access.principal.apiKeyId : "operator";
      const verdict = rateLimit(`api:${principalKey}:${new URL(req.url).pathname}`, rl.limit, rl.windowMs);
      if (!verdict.ok) {
        return NextResponse.json(
          { error: { code: "rate_limited", message: "Too many requests. Slow down and retry." } },
          { status: 429, headers: { "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)) } },
        );
      }
      access.assert(permission);
      const res = await handler(req, { access, requestId }, params);
      res.headers.set("X-Request-Id", requestId);
      if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "private, no-store");
      return res;
    } catch (err) {
      return apiErrorResponse(err, requestId);
    }
  };
}
