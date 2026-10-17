/**
 * Outbound URL guard for URLs that come from external data (STAC asset hrefs).
 * A compromised or misconfigured catalog must not be able to point the server
 * at internal services. Accepts only https URLs whose host is a DNS name or a
 * public IP literal. (DNS rebinding to private addresses is not detected
 * here; see docs/SECURITY.md.)
 */
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Refusing to fetch an invalid URL.");
  }
  if (u.protocol !== "https:") throw new Error(`Refusing to fetch a non-HTTPS asset URL (${u.protocol}).`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Refusing to fetch an internal host.");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((r) => r.test(host))) throw new Error("Refusing to fetch a private address.");
  if (host.includes(":") && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"))) {
    throw new Error("Refusing to fetch a private address.");
  }
  if (u.username || u.password) throw new Error("Refusing to fetch a URL with embedded credentials.");
  return u;
}
