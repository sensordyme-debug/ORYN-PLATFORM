/** Accept only same-site relative paths for post-login redirects (prevents open redirects). */
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.includes("\n")) return fallback;
  if (next.startsWith("/api/")) return fallback;
  return next;
}
