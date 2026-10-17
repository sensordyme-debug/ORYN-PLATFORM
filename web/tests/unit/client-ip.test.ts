/**
 * Client IP for rate limits and audit records: when the deployment names a
 * proxy-controlled header, a client-supplied X-Forwarded-For is ignored.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/server/http";

afterEach(() => vi.unstubAllEnvs());

describe("clientIp", () => {
  it("trusts only the configured header when one is set", () => {
    vi.stubEnv("ORYN_CLIENT_IP_HEADER", "x-real-ip");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6" }))).toBeNull();
  });

  it("falls back to the first forwarded hop when no header is configured", () => {
    vi.stubEnv("ORYN_CLIENT_IP_HEADER", "");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBeNull();
  });
});
