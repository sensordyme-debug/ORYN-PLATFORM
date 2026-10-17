import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, resetHostLimiter } from "@/server/providers/http";
import {
  buildGdeltQuery,
  canonicalizeUrl,
  categorize,
  domainsPerFingerprint,
  formatGdeltDate,
  independentSourceCount,
  isRateLimitMessage,
  locationMatch,
  parseArtlist,
  parseGdeltDate,
  searchArticles,
  stripSourceSuffix,
  titleFingerprint,
} from "@/server/providers/news/gdelt";
import { fixtureText, mockFetch, textResponse } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
});
beforeEach(() => resetHostLimiter());
afterEach(() => vi.useRealTimers());

const NOW = () => new Date("2026-10-15T20:00:00Z");

describe("GDELT responses", () => {
  it("parses a real artlist: cleaned titles, canonical URLs, outlet, seendate", () => {
    const articles = parseArtlist(fixtureText("gdelt-artlist.json"));
    expect(articles).toHaveLength(20);
    const fox = articles.find((a) => a.title.startsWith("Cold front"))!;
    expect(fox).toMatchObject({
      providerId: "gdelt",
      url: "https://www.fox4news.com/news/cold-front-triggers-widespread-flooding-tornado-across-west-texas",
      canonicalUrl: "https://fox4news.com/news/cold-front-triggers-widespread-flooding-tornado-across-west-texas",
      title: "Cold front triggers widespread flooding, tornado across West Texas",
      domain: "fox4news.com",
      language: "English",
      sourceCountry: "United States",
    });
    expect(fox.publishedAt?.toISOString()).toBe("2026-10-15T18:30:00.000Z");
    expect(fox.titleFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats the literal {} body as no results", () => {
    expect(fixtureText("gdelt-empty.json").trim()).toBe("{}");
    expect(parseArtlist(fixtureText("gdelt-empty.json"))).toEqual([]);
  });

  it("detects the plain-text rate-limit notice and raises a retryable rate_limited error", () => {
    const text = fixtureText("gdelt-rate-limit.txt");
    expect(isRateLimitMessage(text)).toBe(true);
    const err = (() => {
      try {
        parseArtlist(text);
      } catch (e) {
        return e;
      }
    })() as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("raises bad_response for other non-JSON text", () => {
    expect(() => parseArtlist("Your search contained a keyword that was too short.")).toThrow(/non-JSON/);
  });

  it("searchArticles maps a 200 rate-limit notice to rate_limited", async () => {
    const f = mockFetch(() => textResponse(fixtureText("gdelt-rate-limit.txt"), 200));
    await expect(searchArticles({ terms: ["Tarboro"], fetchImpl: f, now: NOW, enabled: true })).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("builds the request with OR'd terms, filters, and a clamped time window", async () => {
    const f = mockFetch(() => textResponse(fixtureText("gdelt-empty.json")));
    await searchArticles({
      terms: ["Tarboro", "Edgecombe County"],
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-10-15T12:00:00Z"),
      maxRecords: 500,
      sourceCountry: "US",
      language: "english",
      fetchImpl: f,
      now: NOW,
      enabled: true,
    });
    const q = new URL(f.calls[0]!.url).searchParams;
    expect(q.get("query")).toBe('(Tarboro OR "Edgecombe County") sourcecountry:US sourcelang:english');
    expect(q.get("mode")).toBe("artlist");
    expect(q.get("format")).toBe("json");
    expect(q.get("maxrecords")).toBe("250");
    expect(q.get("enddatetime")).toBe("20261015120000");
    expect(q.get("startdatetime")).toBe("20260718200000"); // clamped to the 89-day window
  });

  it("is gated by GDELT_ENABLED", async () => {
    const f = mockFetch(() => textResponse("{}"));
    await expect(searchArticles({ terms: ["Tarboro"], fetchImpl: f, now: NOW, enabled: false })).rejects.toMatchObject({ code: "unconfigured" });
    expect(f.calls).toHaveLength(0);
  });

  it("spaces requests at least 5.5 s apart process-wide", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T20:00:00Z") });
    const f = mockFetch(() => textResponse("{}"));
    const a = searchArticles({ terms: ["Tarboro"], fetchImpl: f, now: NOW, enabled: true });
    const b = searchArticles({ terms: ["Princeville"], fetchImpl: f, now: NOW, enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_499);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await Promise.all([a, b]);
  });
});

describe("query and date helpers", () => {
  it("sanitizes terms and rejects unusable ones", () => {
    expect(buildGdeltQuery(['"Tarboro"', "Tar River (NC)"])).toBe('(Tarboro OR "Tar River NC")');
    expect(buildGdeltQuery(["domain:evil.com"])).toBe('"domain evil.com"');
    expect(() => buildGdeltQuery(["ab", "  "])).toThrow(RangeError);
    expect(() => buildGdeltQuery(["Tarboro"], { sourceCountry: "USA" })).toThrow(RangeError);
  });

  it("formats and parses GDELT timestamps", () => {
    expect(formatGdeltDate(new Date("2026-10-15T12:34:56.789Z"))).toBe("20261015123456");
    expect(parseGdeltDate("20261015T120000Z")?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(parseGdeltDate("20261015120000")?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(parseGdeltDate("yesterday")).toBeNull();
  });
});

describe("URL canonicalization", () => {
  it("lowercases the host, strips www., fragments, tracking params, and trailing slashes", () => {
    expect(canonicalizeUrl("https://WWW.Example.com/News/Story/?utm_source=x&id=5&fbclid=abc&gclid=1#comments")).toBe("https://example.com/News/Story?id=5");
    expect(canonicalizeUrl("https://www.wral.com/")).toBe("https://wral.com");
    expect(canonicalizeUrl("https://witn.com:443/a?b=2&a=1")).toBe("https://witn.com/a?a=1&b=2");
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("story fingerprints and corroboration", () => {
  it("collapses syndicated copies and outlet suffixes to one fingerprint", () => {
    const a = titleFingerprint("Flooding closes roads in Tarboro - WRAL");
    expect(a).toBe(titleFingerprint("Flooding Closes Roads in Tarboro | WITN News"));
    expect(a).toBe(titleFingerprint("flooding closes roads in tarboro"));
    expect(titleFingerprint("Café flooding")).toBe(titleFingerprint("Cafe flooding"));
    expect(a).not.toBe(titleFingerprint("Flooding closes schools in Tarboro"));
    expect(stripSourceSuffix("Flood warning issued - residents along the Tar River urged to move to higher ground")).toBe(
      "Flood warning issued - residents along the Tar River urged to move to higher ground",
    );
  });

  it("does not count syndicated copies as independent confirmation", () => {
    const articles = parseArtlist(fixtureText("gdelt-artlist.json"));
    const nursing = articles.filter((a) => a.title.startsWith("These 100 nursing homes"));
    expect(nursing.map((a) => a.domain).sort()).toEqual(["reporterherald.com", "ukiahdailyjournal.com"]);
    expect(nursing[0]!.titleFingerprint).toBe(nursing[1]!.titleFingerprint);
    expect(domainsPerFingerprint(nursing).get(nursing[0]!.titleFingerprint)).toBe(2);
    expect(independentSourceCount(nursing)).toBe(1);

    const koco = articles.find((a) => a.domain === "koco.com")!;
    const fox = articles.find((a) => a.title.startsWith("Cold front"))!;
    expect(independentSourceCount([...nursing, koco, fox])).toBe(3);

    // Two different stories from the same outlet are one source.
    const dailypress = articles.filter((a) => a.domain === "dailypress.com");
    expect(dailypress).toHaveLength(2);
    expect(new Set(dailypress.map((a) => a.titleFingerprint)).size).toBe(2);
    expect(independentSourceCount(dailypress)).toBe(1);
  });
});

describe("categorize", () => {
  it("classifies real headlines", () => {
    const byTitle = new Map(parseArtlist(fixtureText("gdelt-artlist.json")).map((a) => [a.title, categorize(a.title)]));
    expect(byTitle.get("Cold front triggers widespread flooding, tornado across West Texas")).toBe("flood");
    expect(byTitle.get("KCC Says Isaias Insured Losses to Be $3 Billion; AM Best Calls Storm an Earnings Event")).toBe("storm");
    expect(byTitle.get("FORECAST: Stormy weekend ahead, dangerous beach conditions expected")).toBe("storm");
    expect(byTitle.get("Meet the candidates running for Corcoran City Council")).toBe("other");
  });

  it("covers the taxonomy and maps crime to public_safety", () => {
    expect(categorize("Wildfire forces evacuations near Asheville")).toBe("fire");
    expect(categorize("Fired employee sues city")).toBe("other");
    expect(categorize("Ceasefire talks resume")).toBe("other");
    expect(categorize("Crash closes I-95 southbound near Rocky Mount")).toBe("road");
    expect(categorize("Water main break leaves residents without water")).toBe("infrastructure");
    expect(categorize("Groundbreaking held for new data center")).toBe("construction");
    expect(categorize("Drought conditions worsen across eastern NC")).toBe("drought");
    expect(categorize("Farmers race to harvest cotton before rain")).toBe("agriculture");
    expect(categorize("Police arrest suspect after shooting on Main Street")).toBe("public_safety");
    expect(categorize("Flooding closes roads after storm")).toBe("flood");
  });
});

describe("locationMatch", () => {
  it("distinguishes place in title, other term in title, and query-only matches", () => {
    expect(locationMatch("Flooding closes roads in Tarboro", ["Tarboro"], ["Tar River"])).toBe("place_in_title");
    expect(locationMatch("Tar River expected to crest Friday", ["Tarboro"], ["Tar River"])).toBe("term_in_title");
    expect(locationMatch("Storm brings heavy rain to eastern NC", ["Tarboro"], ["Tar River"])).toBe("query_only");
    expect(locationMatch("Tarborough history society meets", ["Tarboro"], [])).toBe("query_only");
  });
});
