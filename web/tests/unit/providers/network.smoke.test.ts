/**
 * Live smoke tests against the real provider endpoints. Opt-in:
 *   ORYN_NETWORK_TESTS=1 npx vitest run --project unit tests/unit/providers/network.smoke.test.ts
 * They make a handful of small requests per provider and assert shapes, not
 * values (live data changes). GDELT is skipped when it answers with its
 * rate-limit notice, which happens when the egress IP is shared.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { geocode } from "@/server/providers/geocoding/index";
import { httpRequest, isProviderError } from "@/server/providers/http";
import { getImageryProduct } from "@/server/providers/imagery/index";
import { searchArticles } from "@/server/providers/news/gdelt";
import { fetchOsmFeatures } from "@/server/providers/reference/overpass";
import { getPlaceBoundary, searchPlaces } from "@/server/providers/reference/tigerweb";
import { checkProviderHealth, PROVIDERS } from "@/server/providers/registry";
import { fetchActiveAlerts, fetchDailyForecast as nwsForecast, fetchRecentObservations } from "@/server/providers/weather/nws";
import { fetchDailyForecast, fetchDailyHistory } from "@/server/providers/weather/open-meteo";

const live = process.env.ORYN_NETWORK_TESTS === "1";
const AOI = { type: "Point" as const, coordinates: [-77.5358, 35.8968] as [number, number] };
const LAT = 35.8968;
const LON = -77.5358;
const T = 90_000;

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "warn");
});

async function rangeRead(url: string, headers?: Record<string, string>): Promise<number> {
  const res = await httpRequest(url, { providerId: "smoke", headers: { ...headers, range: "bytes=0-15", accept: "*/*" }, maxBytes: 1 << 20 });
  return res.status;
}

describe.skipIf(!live)("live providers", () => {
  it(
    "Earth Search: search, then read a COG header",
    async () => {
      const { provider } = getImageryProduct("earth-search:sentinel-2-l2a")!;
      const items = await provider.search({ productId: "earth-search:sentinel-2-l2a", intersects: AOI, start: new Date(Date.now() - 30 * 864e5), end: new Date(), limit: 3 });
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]!.assets.red?.bands?.[0]?.scale).toBe(0.0001);
      expect(typeof items[0]!.properties["earthsearch:boa_offset_applied"]).toBe("boolean");
      expect(await rangeRead((await provider.resolveAccess(items[0]!, "red")).url)).toBe(206);
    },
    T,
  );

  it(
    "Planetary Computer: S1 RTC search and SAS-signed range read; WorldCover search",
    async () => {
      const { provider } = getImageryProduct("planetary-computer:sentinel-1-rtc")!;
      const items = await provider.search({ productId: "planetary-computer:sentinel-1-rtc", intersects: AOI, start: new Date(Date.now() - 30 * 864e5), end: new Date(), limit: 2 });
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]!.gridCode).toMatch(/^S1-RELORB-\d{3}$/);
      expect(await rangeRead((await provider.resolveAccess(items[0]!, "vv")).url)).toBe(206);
      const wc = await provider.search({ productId: "planetary-computer:esa-worldcover", intersects: AOI, start: new Date("2021-01-01"), end: new Date("2021-12-31"), limit: 2 });
      expect(wc[0]!.assets.map).toBeDefined();
    },
    T,
  );

  it(
    "Copernicus Data Space and NASA CMR: public catalog search",
    async () => {
      const cdse = await getImageryProduct("copernicus-dataspace:sentinel-2-l2a")!.provider.search({
        productId: "copernicus-dataspace:sentinel-2-l2a",
        intersects: AOI,
        start: new Date(Date.now() - 30 * 864e5),
        end: new Date(),
        limit: 2,
      });
      expect(cdse.length).toBeGreaterThan(0);
      expect(cdse[0]!.epsg).toBe(32618);
      const hls = await getImageryProduct("nasa-cmr:hls")!.provider.search({ productId: "nasa-cmr:hls", intersects: AOI, start: new Date(Date.now() - 30 * 864e5), end: new Date(), limit: 3 });
      expect(hls.length).toBeGreaterThan(0);
      expect(hls[0]!.gridCode).toMatch(/^MGRS-/);
    },
    T,
  );

  it(
    "NWS: alerts, forecast, observations",
    async () => {
      const alerts = await fetchActiveAlerts(LAT, LON);
      expect(Array.isArray(alerts)).toBe(true);
      const fc = await nwsForecast(LAT, LON);
      expect(fc.some((r) => r.variable === "temperature_max_c" || r.variable === "temperature_min_c")).toBe(true);
      const obs = await fetchRecentObservations(LAT, LON, { hours: 6 });
      expect(obs.every((r) => r.recordKind === "observation" && r.stationId)).toBe(true);
    },
    T,
  );

  it(
    "Open-Meteo: history and forecast",
    async () => {
      const hist = await fetchDailyHistory(LAT, LON, "2026-09-01", "2026-09-03", { allowNonCommercial: true });
      expect(hist.length).toBeGreaterThan(0);
      const fc = await fetchDailyForecast(LAT, LON, 2, { allowNonCommercial: true });
      expect(fc.length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "GDELT: article search (skipped when rate-limited)",
    async () => {
      try {
        const a = await searchArticles({ terms: ["flooding"], sourceCountry: "US", maxRecords: 5, enabled: true });
        expect(Array.isArray(a)).toBe(true);
      } catch (e) {
        if (isProviderError(e) && e.code === "rate_limited") return;
        throw e;
      }
    },
    T,
  );

  it(
    "TIGERweb, Overpass, Census geocoder",
    async () => {
      const places = await searchPlaces("Tarboro", "37");
      expect(places[0]!.geoid).toBe("3766700");
      const b = await getPlaceBoundary("3766700");
      expect(b.geometry.type).toBe("MultiPolygon");
      expect(b.provenance.vintage).toMatch(/\d{4}/);
      try {
        const osm = await fetchOsmFeatures([-77.54, 35.895, -77.532, 35.9], ["roads", "buildings"]);
        expect(osm.features.length).toBeGreaterThan(0);
      } catch (e) {
        // The shared public Overpass instance is often overloaded (502 / slot timeouts).
        if (!(isProviderError(e) && (e.code === "unavailable" || e.code === "timeout" || e.code === "rate_limited"))) throw e;
        console.warn(`Overpass unavailable during smoke test: ${e.message}`);
      }
      const g = await geocode("500 N Main St, Tarboro, NC 27886");
      expect(g[0]!.kind).toBe("address");
    },
    3 * T,
  );

  it(
    "health checks never throw",
    async () => {
      for (const p of PROVIDERS) {
        if (p.id === "gdelt") continue;
        const r = await checkProviderHealth(p.id);
        expect(typeof r.ok, p.id).toBe("boolean");
        if (!r.ok) console.warn(`health ${p.id}: ${r.message}`);
      }
    },
    3 * T,
  );
});
