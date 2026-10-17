/**
 * Bounded, read-only smoke test of a deployed ORYN web service.
 *
 *   npm run oryn:smoke -- https://oryn.example.org                  # platform deployment
 *   npm run oryn:smoke -- https://oryn.example.org --website-only   # marketing site only
 *
 * About a dozen requests, one at a time, 15 s timeout each. Needs no
 * credentials and changes nothing — except that the deliberately wrong
 * sign-in counts once towards that client's sign-in rate limit. Exits 1 if
 * any check fails. Never prints response bodies beyond short status fields.
 */

const TIMEOUT_MS = 15_000;

type Result = { ok: boolean; name: string; detail: string };
const results: Result[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function request(base: string, path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
}

async function json(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main() {
  const base = process.argv[2]?.replace(/\/$/, "");
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("Usage: npm run oryn:smoke -- <https://deployment-url> [--website-only]");
    process.exit(2);
  }
  const websiteOnly = process.argv.includes("--website-only");
  const origin = new URL(base).origin;
  console.log(`Smoke test ${origin} (${websiteOnly ? "website only" : "platform"})`);

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      check(name, false, (err as Error).name === "TimeoutError" ? `no response within ${TIMEOUT_MS} ms` : (err as Error).message);
    }
  };

  await step("homepage", async () => {
    const res = await request(base, "/");
    const html = await res.text();
    check("homepage", res.status === 200, `HTTP ${res.status}`);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? "";
    check("canonical URL is the public origin, not localhost", canonical.startsWith(origin), canonical || "no canonical link");
    // Marketing pages are static: global headers only (the nonce-based CSP covers platform pages, checked below).
    const missing = ["strict-transport-security", "x-content-type-options", "x-frame-options"].filter((k) => !res.headers.get(k));
    check("security headers on public pages", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "");
  });

  await step("robots.txt", async () => {
    const res = await request(base, "/robots.txt");
    const text = await res.text();
    check("robots.txt points at the public origin", res.status === 200 && text.includes(`${origin}/sitemap.xml`), `HTTP ${res.status}`);
  });

  await step("liveness", async () => {
    const res = await request(base, "/api/health");
    const body = await json(res);
    check("liveness /api/health", res.status === 200 && body?.status === "ok", `HTTP ${res.status}, version ${String(body?.version ?? "?")}`);
  });

  await step("readiness", async () => {
    const res = await request(base, "/api/health/ready");
    const body = await json(res);
    const checks = (body?.checks ?? {}) as Record<string, string>;
    if (websiteOnly) {
      check("readiness (website only)", res.status === 200 && body?.mode === "website_only", `HTTP ${res.status}, mode ${String(body?.mode)}`);
      return;
    }
    const failing = ["database", "migrations", "storage"].filter((k) => checks[k] !== "ok");
    check("readiness: platform mode, database, migrations, storage", res.status === 200 && body?.mode === "platform" && failing.length === 0, `HTTP ${res.status}, mode ${String(body?.mode)}${failing.length ? `, not ok: ${failing.join(", ")}` : ""}`);
    const worker = body?.worker as { live?: number } | undefined;
    check("a worker heartbeat is fresh", (worker?.live ?? 0) >= 1, `live workers: ${worker?.live ?? "unknown"}`);
  });

  await step("login page", async () => {
    const res = await request(base, "/login");
    const html = await res.text();
    const notConfigured = /platform is not configured/i.test(html);
    check("login page", res.status === 200 && (websiteOnly || !notConfigured), `HTTP ${res.status}${notConfigured ? ", says the platform is not configured" : ""}`);
    const policy = res.headers.get("content-security-policy") ?? "";
    check("platform pages carry a nonce-based CSP", /script-src[^;]*'nonce-/.test(policy) && /frame-ancestors 'none'/.test(policy), policy ? "" : "no Content-Security-Policy header");
  });

  await step("app requires a session", async () => {
    const res = await request(base, "/app");
    const location = res.headers.get("location") ?? "";
    check("/app without a session redirects to sign-in", [302, 303, 307, 308].includes(res.status) && location.includes("/login"), `HTTP ${res.status} → ${location || "(none)"}`);
  });

  const post = (path: string, body: unknown) =>
    request(base, path, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

  await step("public sign-up is disabled", async () => {
    const res = await post("/api/auth/sign-up/email", { email: "smoke-test@invalid.example", password: "x".repeat(24), name: "Smoke" });
    check("public sign-up is not served", res.status === 404, `HTTP ${res.status}`);
  });

  await step("sign-in rejects unknown credentials", async () => {
    const res = await post("/api/auth/sign-in/username", { username: `smoke_${Date.now().toString(36)}`, password: "not-a-real-password-0000" });
    const body = await json(res);
    if (websiteOnly) {
      check("sign-in is unavailable without the platform", res.status === 503, `HTTP ${res.status}`);
      return;
    }
    check("sign-in rejects unknown credentials with a generic answer", res.status === 401 && !/not found|no such user/i.test(String(body?.message ?? "")), `HTTP ${res.status}`);
  });

  await step("session endpoint", async () => {
    const res = await request(base, "/api/auth/get-session");
    if (websiteOnly) return check("session endpoint unavailable without the platform", res.status === 503, `HTTP ${res.status}`);
    const text = await res.text();
    check("session endpoint answers without a session", res.status === 200 && (text === "null" || text === ""), `HTTP ${res.status}`);
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
