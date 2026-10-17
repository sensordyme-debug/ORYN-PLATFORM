import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { httpJson, httpRequest, isProviderError, parseRetryAfter, ProviderError, resetHostLimiter, safeUrl } from "@/server/providers/http";
import { jsonResponse, mockFetch, textResponse } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
});

beforeEach(() => resetHostLimiter());
afterEach(() => vi.useRealTimers());

function deps() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => 1_000_000,
  };
}

describe("httpRequest", () => {
  it("returns parsed JSON and sends a descriptive User-Agent", async () => {
    const f = mockFetch(() => jsonResponse({ ok: 1 }));
    const res = await httpJson<{ ok: number }>("https://example.test/a?key=secret", { providerId: "t", fetchImpl: f });
    expect(res.ok).toBe(1);
    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/^ORYN\//);
  });

  it("retries 5xx with exponential backoff and jitter, then succeeds", async () => {
    const d = deps();
    const f = mockFetch((_u, _i, n) => (n < 2 ? textResponse("down", 503) : jsonResponse({ ok: true })));
    const res = await httpJson("https://example.test/x", { providerId: "t", fetchImpl: f, ...d });
    expect(res).toEqual({ ok: true });
    expect(f.calls).toHaveLength(3);
    // base 500 ms: attempt 0 → 250 + 0.5·250, attempt 1 → 500 + 0.5·500
    expect(d.sleeps).toEqual([375, 750]);
  });

  it("honours Retry-After on 429", async () => {
    const d = deps();
    const f = mockFetch((_u, _i, n) => (n === 0 ? textResponse("slow down", 429, { "retry-after": "3" }) : jsonResponse({})));
    await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, ...d });
    expect(d.sleeps).toEqual([3000]);
  });

  it("fails fast with a retryable rate_limited error when Retry-After exceeds the in-process cap", async () => {
    const d = deps();
    const f = mockFetch(() => textResponse("slow down", 429, { "retry-after": "120" }));
    const err = await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, ...d }).catch((e: unknown) => e);
    expect(isProviderError(err)).toBe(true);
    expect((err as ProviderError).code).toBe("rate_limited");
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).retryAfterMs).toBe(120_000);
    expect(f.calls).toHaveLength(1);
    expect(d.sleeps).toEqual([]);
  });

  it("gives up after the retry budget with an unavailable error", async () => {
    const d = deps();
    const f = mockFetch(() => textResponse("bad gateway", 502));
    const err = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, retries: 1, ...d }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("unavailable");
    expect(err.status).toBe(502);
    expect(f.calls).toHaveLength(2);
  });

  it("retries network errors", async () => {
    const d = deps();
    const f = mockFetch((_u, _i, n) => {
      if (n === 0) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true });
    });
    await expect(httpJson("https://example.test/x", { providerId: "t", fetchImpl: f, ...d })).resolves.toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  it("does not retry 404 and maps it to not_found", async () => {
    const f = mockFetch(() => textResponse("nope", 404));
    const err = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, ...deps() }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("not_found");
    expect(err.retryable).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("includes the provider's explanation for 4xx responses", async () => {
    const f = mockFetch(() => jsonResponse({ reason: "Latitude must be in range of -90 to 90°.", error: true }, 400));
    const err = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, ...deps() }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("bad_response");
    expect(err.message).toContain("Latitude must be in range");
  });

  it("maps 401/403 to unconfigured", async () => {
    const f = mockFetch(() => textResponse("forbidden", 403));
    const err = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, ...deps() }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("unconfigured");
  });

  it("times out a hung request, retries it, and reports timeout", async () => {
    const f = mockFetch(
      (_u, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const err = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, timeoutMs: 20, retries: 1, sleep: async () => {} }).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("re-throws a caller abort without retrying", async () => {
    const controller = new AbortController();
    const f = mockFetch(
      (_u, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 5);
        }),
    );
    const err = await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: f, signal: controller.signal, ...deps() }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect((err as DOMException).name).toBe("AbortError");
    expect(f.calls).toHaveLength(1);
  });

  it("caps response size (streamed and declared)", async () => {
    const big = "x".repeat(5000);
    const streamed = mockFetch(() => new Response(new Blob([big]).stream(), { status: 200 }));
    const e1 = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: streamed, maxBytes: 1000 }).catch((e: unknown) => e)) as ProviderError;
    expect(e1.code).toBe("bad_response");
    expect(e1.retryable).toBe(false);
    const declared = mockFetch(() => new Response(big, { status: 200, headers: { "content-length": "5000" } }));
    const e2 = (await httpRequest("https://example.test/x", { providerId: "t", fetchImpl: declared, maxBytes: 1000 }).catch((e: unknown) => e)) as ProviderError;
    expect(e2.message).toContain("exceeds");
  });

  it("raises bad_response for invalid JSON", async () => {
    const f = mockFetch(() => textResponse("<html>oops</html>"));
    await expect(httpJson("https://example.test/x", { providerId: "t", fetchImpl: f })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("spaces requests to the same host by the minimum interval", async () => {
    const d = deps();
    const f = mockFetch(() => jsonResponse({}));
    await Promise.all([
      httpRequest("https://slow.test/a", { providerId: "t", fetchImpl: f, minIntervalMs: 5500, ...d }),
      httpRequest("https://slow.test/b", { providerId: "t", fetchImpl: f, minIntervalMs: 5500, ...d }),
      httpRequest("https://other.test/c", { providerId: "t", fetchImpl: f, minIntervalMs: 5500, ...d }),
    ]);
    expect(d.sleeps).toEqual([5500]);
  });
});

describe("helpers", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(parseRetryAfter("Thu, 15 Oct 2026 20:00:10 GMT", Date.parse("2026-10-15T20:00:00Z"))).toBe(10_000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it("strips query strings before logging", () => {
    expect(safeUrl("https://x.blob.core.windows.net/c/a.tif?st=1&sig=abc")).toBe("https://x.blob.core.windows.net/c/a.tif");
    expect(safeUrl("https://customer-api.open-meteo.com/v1/forecast?apikey=k")).toBe("https://customer-api.open-meteo.com/v1/forecast");
  });
});
