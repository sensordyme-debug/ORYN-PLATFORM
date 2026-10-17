import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/server/config/env";
import { overpassAvailability } from "@/server/providers/reference/overpass";
import { openMeteoAvailability } from "@/server/providers/weather/open-meteo";

describe("licence defaults for public services", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("Open-Meteo's non-commercial free API is never used by default, in any environment", () => {
    vi.stubEnv("OPEN_METEO_ALLOW_NONCOMMERCIAL", "");
    vi.stubEnv("OPEN_METEO_API_KEY", "");
    expect(env.openMeteoAllowNonCommercial()).toBe(false);
    expect(openMeteoAvailability({ apiKey: null }).state).toBe("disabled");
    expect(openMeteoAvailability({ apiKey: "paid-key" }).state).toBe("available");
    expect(openMeteoAvailability({ apiKey: null, allowNonCommercial: true }).state).toBe("available");
  });

  it("the public Overpass instance never backs production; a configured instance does", () => {
    expect(overpassAvailability({ production: true, configured: false })).toMatchObject({ state: "disabled", reason: expect.stringMatching(/OVERPASS_URL/) });
    expect(overpassAvailability({ production: true, configured: true }).state).toBe("available");
    expect(overpassAvailability({ production: false, configured: false }).state).toBe("available");
  });
});
