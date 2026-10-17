/**
 * The only Better Auth endpoints served over HTTP. Everything else Better
 * Auth implements (sign-up, account linking, profile and password changes,
 * username availability, …) answers 404: account creation and changes go
 * through ORYN's own audited server code instead.
 */
import { ConfigError } from "@/server/config/env";

const ALLOWED: Record<string, (path: string) => boolean> = {
  GET: (p) => p === "/get-session" || p === "/ok" || p === "/error" || /^\/reset-password\/[A-Za-z0-9_-]+$/.test(p),
  POST: (p) => ["/sign-in/email", "/sign-in/username", "/sign-out", "/request-password-reset", "/reset-password"].includes(p),
};

export const AUTH_BASE_PATH = "/api/auth";

export function isAllowedAuthRequest(method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const path = pathname.slice(AUTH_BASE_PATH.length).replace(/\/+$/, "");
  return ALLOWED[method.toUpperCase()]?.(path) ?? false;
}

type AuthHandler = { handler: (req: Request) => Promise<Response> };

/**
 * `auth` may be a getter so the allowlist is checked before Better Auth is
 * constructed: a deployment without platform configuration then answers 404
 * for unserved endpoints and 503 for served ones, instead of a 500.
 */
export async function handleAuthRequest(auth: AuthHandler | (() => AuthHandler), req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isAllowedAuthRequest(req.method, new URL(req.url).pathname)) {
    return Response.json({ code: "NOT_FOUND", message: "Not found" }, { status: 404, headers });
  }
  let resolved: AuthHandler;
  try {
    resolved = typeof auth === "function" ? auth() : auth;
  } catch (err) {
    if (err instanceof ConfigError) {
      return Response.json({ code: "PLATFORM_NOT_CONFIGURED", message: "Sign-in is not available on this deployment." }, { status: 503, headers });
    }
    throw err;
  }
  return resolved.handler(req);
}
