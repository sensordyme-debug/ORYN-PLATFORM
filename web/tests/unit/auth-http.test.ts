/**
 * The auth endpoint allowlist, and how a deployment without platform
 * configuration answers: 404 for endpoints ORYN never serves (sign-up), 503
 * for served ones — never a 500 from constructing Better Auth.
 */
import { describe, expect, it } from "vitest";
import { handleAuthRequest, isAllowedAuthRequest } from "@/server/auth/http";
import { ConfigError } from "@/server/config/env";

const req = (method: string, path: string) => new Request(`https://oryn.test/api/auth${path}`, { method });
const unconfigured = () => {
  throw new ConfigError("BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET is not set.");
};

describe("auth HTTP endpoints", () => {
  it("serves only the allowlist; public sign-up is not served", () => {
    expect(isAllowedAuthRequest("POST", "/api/auth/sign-in/username")).toBe(true);
    expect(isAllowedAuthRequest("POST", "/api/auth/sign-up/email")).toBe(false);
    expect(isAllowedAuthRequest("GET", "/api/auth/sign-in/username")).toBe(false);
  });

  it("without platform configuration: 404 for sign-up, 503 for sign-in, no internal detail", async () => {
    const signUp = await handleAuthRequest(unconfigured, req("POST", "/sign-up/email"));
    expect(signUp.status).toBe(404);
    const signIn = await handleAuthRequest(unconfigured, req("POST", "/sign-in/username"));
    expect(signIn.status).toBe(503);
    expect(signIn.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await signIn.json())).not.toMatch(/BETTER_AUTH_SECRET|DATABASE_URL/);
  });

  it("does not construct Better Auth for unserved endpoints, and passes other errors through", async () => {
    let built = 0;
    const auth = () => {
      built++;
      return { handler: async () => new Response("ok") };
    };
    expect((await handleAuthRequest(auth, req("POST", "/sign-up/email"))).status).toBe(404);
    expect(built).toBe(0);
    expect(await (await handleAuthRequest(auth, req("GET", "/ok"))).text()).toBe("ok");
    expect(built).toBe(1);
    await expect(
      handleAuthRequest(() => {
        throw new Error("boom");
      }, req("GET", "/ok")),
    ).rejects.toThrow("boom");
  });
});
