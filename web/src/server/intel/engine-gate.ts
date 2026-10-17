import "server-only";
import { createHash } from "node:crypto";
import { loadSessionUser } from "@/server/auth/session";
import { env } from "@/server/config/env";

/**
 * Access to the geospatial engine (its document, assets, and public-data
 * proxies) requires a signed-in ORYN account. The engine holds no ORYN data,
 * but without this gate the ORYN origin would be an open relay for the
 * engine's rate-limited public feeds.
 *
 * The check is the same session validation pages use (Better Auth session
 * plus account controls: a disabled account is refused). Loading the engine
 * fetches dozens of assets, so a successful check is remembered for a short
 * time per session cookie; a revoked session stops working within TTL_MS.
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;
const allowed = new Map<string, number>();

const keyFor = (cookie: string) => createHash("sha256").update(cookie).digest("base64url");

export async function engineAccessAllowed(headers: Headers, sessionCookie: string | null | undefined): Promise<boolean> {
  if (!sessionCookie || !env.databaseConfigured()) return false;
  const key = keyFor(sessionCookie);
  const now = Date.now();
  const until = allowed.get(key);
  if (until && until > now) return true;
  allowed.delete(key);
  let user: Awaited<ReturnType<typeof loadSessionUser>> = null;
  try {
    user = await loadSessionUser(headers);
  } catch {
    return false;
  }
  if (!user) return false;
  if (allowed.size >= MAX_ENTRIES) {
    for (const [k, t] of allowed) if (t <= now) allowed.delete(k);
    if (allowed.size >= MAX_ENTRIES) allowed.clear();
  }
  allowed.set(key, now + TTL_MS);
  return true;
}
