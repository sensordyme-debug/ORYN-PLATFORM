/**
 * Sliding-window rate limiter held in process memory.
 *
 * Scope: per server instance. Authentication endpoints use Better Auth's
 * database-backed limiter, which holds across instances; this limiter
 * protects authenticated API routes from runaway clients. For multi-instance
 * deployments, add an edge/WAF rule as well (see docs/SECURITY.md).
 */
const windows = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return { ok: false, retryAfterMs: windowMs - (now - hits[0]!) };
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > 20_000) {
    for (const [k, v] of windows) if (v.every((t) => now - t >= windowMs)) windows.delete(k);
  }
  return { ok: true };
}
