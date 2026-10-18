import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allLayersFromEnv, ENGINE_API_PREFIXES, ENGINE_DEV_API_PREFIXES, engineApiPrefixes } from "@/lib/intel/engine";

const proxy = readFileSync(new URL("../../src/proxy.ts", import.meta.url), "utf8");

describe("engine routes forwarded by ORYN", () => {
  it("are the licence-cleared routes by default, and every layer's under ORYN_ALL_LAYERS", () => {
    expect(engineApiPrefixes(false)).toEqual(ENGINE_API_PREFIXES);
    expect(engineApiPrefixes(true)).toEqual([...ENGINE_API_PREFIXES, ...ENGINE_DEV_API_PREFIXES]);
    expect(engineApiPrefixes(true)).toContain("celestrak");
    expect(engineApiPrefixes(false)).not.toContain("celestrak");
  });

  it("never include routes that write engine configuration or call paid services", () => {
    for (const route of ["setup", "openai", "realtime", "google", "tomtom"]) expect(engineApiPrefixes(true)).not.toContain(route);
  });

  it("never collide with ORYN's own API routes", () => {
    for (const route of ["auth", "contact", "cron", "health", "v1"]) expect(engineApiPrefixes(true)).not.toContain(route);
  });

  it("are all in the proxy's static matcher, so each one is session-gated", () => {
    for (const route of engineApiPrefixes(true)) expect(proxy).toMatch(new RegExp(`/api/:engine\\([^)]*\\b${route}\\b[^)]*\\)`));
  });

  it("switch on only outside production", () => {
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "1", NODE_ENV: "development" })).toBe(true);
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "true", NODE_ENV: "development" })).toBe(true);
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "1", NODE_ENV: "production" })).toBe(false);
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "0", NODE_ENV: "development" })).toBe(false);
    expect(allLayersFromEnv({ NODE_ENV: "development" })).toBe(false);
  });
});
