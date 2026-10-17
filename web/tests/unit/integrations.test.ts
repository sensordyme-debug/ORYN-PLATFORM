import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobErrorPolicy, PermanentJobError } from "@/server/jobs/queue";
import { integrationGate } from "@/server/integrations";
import { ProviderError, resetHostLimiter } from "@/server/providers/http";
import { createNasaCmrProvider } from "@/server/providers/imagery/nasa-cmr";
import { gdeltAvailability, GDELT_RATE_LIMIT_COOLDOWN_MS, searchArticles } from "@/server/providers/news/gdelt";
import { emailConfigured } from "@/server/email";

afterEach(() => vi.unstubAllEnvs());

describe("verification gates for unverified integrations", () => {
  it("are open outside production and closed in production until attested", () => {
    expect(integrationGate("gdelt", { production: false, verified: [] })).toEqual({ enabled: true });
    const closed = integrationGate("gdelt", { production: true, verified: [] });
    expect(closed.enabled).toBe(false);
    expect(!closed.enabled && closed.reason).toMatch(/npm run oryn:verify -- gdelt/);
    expect(integrationGate("gdelt", { production: true, verified: ["gdelt", "email"] })).toEqual({ enabled: true });
    expect(integrationGate("email", { production: true, verified: ["gdelt"] }).enabled).toBe(false);
  });

  it("turn GDELT, NASA HLS reads, and email off in production without attestation", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ORYN_VERIFIED_INTEGRATIONS", "");
    expect(gdeltAvailability(true)).toMatchObject({ state: "disabled" });
    expect(createNasaCmrProvider({ token: "token-123" }).availability()).toMatchObject({ state: "disabled" });
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("ORYN_EMAIL_FROM", "ops@example.org");
    expect(emailConfigured()).toBe(false);
    vi.stubEnv("ORYN_VERIFIED_INTEGRATIONS", "gdelt,nasa-hls,email");
    expect(gdeltAvailability(true)).toEqual({ state: "available" });
    expect(createNasaCmrProvider({ token: "token-123" }).availability()).toEqual({ state: "available" });
    expect(emailConfigured()).toBe(true);
  });
});

describe("GDELT rate limits", () => {
  // The client's in-process spacing (5.5 s per host) must not carry over between tests.
  beforeEach(() => resetHostLimiter());
  const rateLimited = () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return new Response("Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.", { status: 429 });
    };
    return { calls, fetchImpl };
  };

  it("does not retry a 429 within the request, starts a shared cooldown, and tells the queue when to retry", async () => {
    const { calls, fetchImpl } = rateLimited();
    const cooldowns: { ms: number; reason: string }[] = [];
    let slots = 0;
    const err = await searchArticles({
      terms: ["Tarboro"],
      fetchImpl,
      gate: { enabled: true },
      acquireSlot: async () => void slots++,
      onRateLimited: async (ms, reason) => void cooldowns.push({ ms, reason }),
    }).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(slots).toBe(1);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "rate_limited", retryable: true });
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(GDELT_RATE_LIMIT_COOLDOWN_MS);
    expect(cooldowns).toEqual([{ ms: GDELT_RATE_LIMIT_COOLDOWN_MS, reason: "HTTP 429" }]);
    // The queue waits at least the cooldown before retrying.
    expect(jobErrorPolicy(err)).toEqual({ retryable: true, retryAfterMs: err.retryAfterMs });
  });

  it("treats GDELT's 200-with-notice rate limit the same way", async () => {
    const cooldowns: number[] = [];
    const fetchImpl = async () => new Response("Please limit requests to one every 5 seconds or contact us.", { status: 200 });
    const err = await searchArticles({ terms: ["Tarboro"], fetchImpl, gate: { enabled: true }, onRateLimited: async (ms) => void cooldowns.push(ms) }).catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limited" });
    expect(cooldowns).toEqual([GDELT_RATE_LIMIT_COOLDOWN_MS]);
  });
});

describe("job error policy", () => {
  it("retries transient errors, fails permanent ones, and honours retry-after", () => {
    expect(jobErrorPolicy(new Error("boom"))).toEqual({ retryable: true, retryAfterMs: null });
    expect(jobErrorPolicy(new PermanentJobError("bad"))).toEqual({ retryable: false, retryAfterMs: null });
    expect(jobErrorPolicy(new ProviderError("nws", "bad_response", "400", { status: 400 }))).toMatchObject({ retryable: false });
    expect(jobErrorPolicy(new ProviderError("nws", "unavailable", "503", { status: 503, retryAfterMs: 120_000 }))).toEqual({ retryable: true, retryAfterMs: 120_000 });
  });
});
