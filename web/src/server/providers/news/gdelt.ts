/**
 * GDELT DOC 2.0 article search, plus the story-level helpers ORYN uses to
 * keep news reports honest.
 *
 * A news article is evidence that a source made a claim, not proof that an
 * event happened. These helpers make the claim traceable and stop
 * syndication from looking like corroboration:
 *   canonicalizeUrl         one URL per article (host case, www., fragments,
 *                           tracking parameters, trailing slash)
 *   titleFingerprint        groups copies of the same story (sha1 of the
 *                           normalized, sorted, de-duplicated title tokens)
 *   independentSourceCount  distinct outlets after collapsing each story to
 *                           one outlet — 20 sites running one wire story
 *                           count once
 *   categorize              keyword taxonomy for the headline; crime stories
 *                           map to public_safety without extracting people
 *   locationMatch           how strongly a headline ties to the AOI's place
 *
 * Rate limit: GDELT asks for at most one request every 5 seconds. Requests
 * are spaced ≥ 5.5 s process-wide. When throttled GDELT answers either 429 or
 * 200 with a plain-text notice; both raise a retryable ProviderError
 * "rate_limited". An empty result is the literal body "{}".
 * The DOC API covers a rolling three-month window; earlier start times are
 * clamped to it. publishedAt is GDELT's `seendate` (when GDELT first saw the
 * article), the closest available proxy for publication time.
 */
import { createHash } from "node:crypto";
import { env } from "@/server/config/env";
import { integrationGate, type IntegrationGate } from "@/server/integrations";
import { httpText, ProviderError, type FetchLike } from "@/server/providers/http";
import type { NewsArticle, ProviderAvailability, ProviderDescriptor } from "@/server/providers/types";

export const GDELT_ID = "gdelt";
export const GDELT_MIN_INTERVAL_MS = 5_500;
/**
 * After GDELT says "rate limited", nobody calls it for this long. Retrying
 * within seconds (as the HTTP client's default retry did) only extends the
 * penalty; the job queue retries the work after the cooldown instead.
 */
export const GDELT_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const WINDOW_DAYS = 89;

export const GDELT_DESCRIPTOR: ProviderDescriptor = {
  id: GDELT_ID,
  name: "GDELT DOC 2.0 API",
  kind: "news",
  operator: "The GDELT Project",
  homepage: "https://www.gdeltproject.org/",
  docsUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
  products: [
    {
      id: "gdelt:doc-artlist",
      name: "News article metadata (title, URL, outlet, time first seen)",
      collection: "doc-artlist",
      kind: "news",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: "Metadata only. Articles are claims by their publishers, not verified events. Rolling three-month search window.",
    },
  ],
  licensing: {
    summary:
      "GDELT datasets are available for unlimited and unrestricted use, including commercial, without fee; any use or redistribution must cite the GDELT Project and link to https://www.gdeltproject.org/. Linked articles remain the copyright of their publishers — ORYN stores only titles, URLs, and outlet metadata.",
    url: "https://www.gdeltproject.org/about.html",
    redistribution: "GDELT metadata may be redistributed with a citation and link to the GDELT Project; article text is not redistributed.",
    commercialUse: "allowed",
    attribution: "The GDELT Project (https://www.gdeltproject.org/)",
  },
  credentials: { required: false, envVars: ["GDELT_ENABLED"] },
  updateCadence: "Every 15 minutes.",
  delivery: "polling",
  rateLimit: "One request every 5 seconds (enforced at ≥ 5.5 s process-wide).",
};

export function gdeltAvailability(enabled: boolean = env.gdeltEnabled(), gate: IntegrationGate = integrationGate("gdelt")): ProviderAvailability {
  if (!enabled) return { state: "disabled", reason: "GDELT news search is turned off (GDELT_ENABLED=false)." };
  return gate.enabled ? { state: "available" } : { state: "disabled", reason: gate.reason };
}

// ── Search ────────────────────────────────────────────────────

export type GdeltSearch = {
  terms: string[];
  start?: Date;
  end?: Date;
  maxRecords?: number;
  /** FIPS country code filter, e.g. "US". */
  sourceCountry?: string;
  /** Language filter, e.g. "english". */
  language?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: () => Date;
  enabled?: boolean;
  /** Wait for a cross-process request slot (src/server/providers/request-slots.ts). */
  acquireSlot?: (signal?: AbortSignal) => Promise<void>;
  /** Called when GDELT rate-limits us, so every process backs off. */
  onRateLimited?: (cooldownMs: number, reason: string) => Promise<void>;
  /** Override the production verification gate — only `npm run oryn:verify` does this. */
  gate?: IntegrationGate;
};

type GdeltArticle = {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
};

export function buildGdeltQuery(terms: string[], opts: { sourceCountry?: string; language?: string } = {}): string {
  const clean = [...new Set(terms.map(sanitizeTerm).filter((t): t is string => t !== null))];
  if (clean.length === 0) throw new RangeError("At least one search term of 3–100 characters is required");
  if (clean.length > 20) throw new RangeError("At most 20 search terms");
  const quoted = clean.map((t) => (/\s/.test(t) ? `"${t}"` : t));
  let q = quoted.length === 1 ? quoted[0]! : `(${quoted.join(" OR ")})`;
  if (opts.sourceCountry) {
    if (!/^[A-Z]{2}$/i.test(opts.sourceCountry)) throw new RangeError("sourceCountry must be a 2-letter FIPS code");
    q += ` sourcecountry:${opts.sourceCountry.toUpperCase()}`;
  }
  if (opts.language) {
    if (!/^[a-z]{2,20}$/i.test(opts.language)) throw new RangeError("language must be a language name, e.g. english");
    q += ` sourcelang:${opts.language.toLowerCase()}`;
  }
  return q;
}

function sanitizeTerm(t: string): string | null {
  const s = t
    .normalize("NFKC")
    .replace(/["()<>:\\]/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 3 && s.length <= 100 ? s : null;
}

export function formatGdeltDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14);
}

/** "20261015T120000Z" → Date (UTC). */
export function parseGdeltDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isRateLimitMessage(text: string): boolean {
  return /please limit requests to one every/i.test(text);
}

export async function searchArticles(q: GdeltSearch): Promise<NewsArticle[]> {
  const availability = gdeltAvailability(q.enabled ?? env.gdeltEnabled(), q.gate);
  if (availability.state !== "available") throw new ProviderError(GDELT_ID, "unconfigured", availability.reason, { retryable: false });

  const now = (q.now ?? (() => new Date()))();
  const query = buildGdeltQuery(q.terms, { sourceCountry: q.sourceCountry, language: q.language });
  const maxRecords = Math.max(1, Math.min(q.maxRecords ?? 75, 250));
  const params = new URLSearchParams({ query, mode: "artlist", format: "json", maxrecords: String(maxRecords), sort: "datedesc" });

  const end = q.end && q.end.getTime() < now.getTime() ? q.end : now;
  const earliest = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const start = q.start ? (q.start.getTime() < earliest.getTime() ? earliest : q.start) : new Date(end.getTime() - 7 * 86_400_000);
  if (start.getTime() >= end.getTime()) throw new RangeError("start must be before end");
  params.set("startdatetime", formatGdeltDate(start));
  params.set("enddatetime", formatGdeltDate(end));

  await q.acquireSlot?.(q.signal);
  try {
    const text = await httpText(`${ENDPOINT}?${params.toString()}`, {
      providerId: GDELT_ID,
      signal: q.signal,
      fetchImpl: q.fetchImpl,
      minIntervalMs: GDELT_MIN_INTERVAL_MS,
      // No in-request retries: a 429 must not be retried within seconds, and
      // other transient failures are retried by the job queue with backoff.
      retries: 0,
      timeoutMs: 30_000,
      maxBytes: 5 * 1024 * 1024,
    });
    return parseArtlist(text);
  } catch (err) {
    if (err instanceof ProviderError && err.code === "rate_limited") {
      const cooldown = Math.max(GDELT_RATE_LIMIT_COOLDOWN_MS, err.retryAfterMs ?? 0);
      await q.onRateLimited?.(cooldown, err.status ? `HTTP ${err.status}` : "rate-limit notice");
      throw new ProviderError(GDELT_ID, "rate_limited", `${err.message} — backing off for ${Math.round(cooldown / 60_000)} min`, {
        status: err.status,
        retryable: true,
        retryAfterMs: cooldown,
        cause: err,
      });
    }
    throw err;
  }
}

/** Parse a DOC artlist body: rate-limit notice → ProviderError; "{}" → []; other non-JSON → bad_response. */
export function parseArtlist(text: string): NewsArticle[] {
  const body = text.trim();
  if (isRateLimitMessage(body)) {
    throw new ProviderError(GDELT_ID, "rate_limited", "GDELT asked to limit requests to one every 5 seconds", { retryable: true, retryAfterMs: GDELT_MIN_INTERVAL_MS });
  }
  if (body === "" || body === "{}") return [];
  let parsed: { articles?: GdeltArticle[] };
  try {
    // GDELT occasionally emits raw control characters and \' inside strings.
    parsed = JSON.parse(body.replace(/[\u0000-\u001f]+/g, " ").replace(/\\'/g, "'")) as { articles?: GdeltArticle[] };
  } catch {
    throw new ProviderError(GDELT_ID, "bad_response", `GDELT returned a non-JSON response: ${body.slice(0, 160)}`, { retryable: false });
  }
  if (!parsed || !Array.isArray(parsed.articles)) return [];
  const out: NewsArticle[] = [];
  const seen = new Set<string>();
  for (const a of parsed.articles) {
    if (typeof a.url !== "string" || typeof a.title !== "string") continue;
    const title = cleanTitle(a.title);
    if (!title) continue;
    const canonicalUrl = canonicalizeUrl(a.url);
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    out.push({
      providerId: GDELT_ID,
      url: a.url,
      canonicalUrl,
      title,
      domain: normalizeDomain(a.domain) ?? hostOf(canonicalUrl),
      language: nonEmpty(a.language),
      sourceCountry: nonEmpty(a.sourcecountry),
      publishedAt: parseGdeltDate(a.seendate),
      titleFingerprint: titleFingerprint(title),
    });
  }
  return out;
}

/** Collapse whitespace and the spaces GDELT inserts before punctuation ("flooding , tornado"). */
function cleanTitle(t: string): string {
  return t
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?%)\]])/g, "$1")
    .replace(/([(\[])\s+/g, "$1")
    .trim();
}

// ── URL canonicalization ──────────────────────────────────────

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid)$/i;

export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

function normalizeDomain(d: unknown): string | null {
  return typeof d === "string" && d.trim() ? d.trim().toLowerCase().replace(/^www\./, "") : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ── Story fingerprints ────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an the and or but nor of in on at to for from by with as is are was were be been being after before over under into onto near " +
    "about amid against during since until up down out off this that these those it its they their there here than then so if not no " +
    "has have had will would can could may might must should says say said via vs"
  ).split(" "),
);

/** Normalize text for matching: NFKD, strip diacritics, lowercase, punctuation → spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Drop a trailing outlet name such as " - WRAL" or " | Rocky Mount Telegram" (≤ 4 words after the last separator). */
export function stripSourceSuffix(title: string): string {
  const m = /^(.*\S)\s+(?:-|\||–|—)\s+([^-|–—]+)$/.exec(title.trim());
  if (!m) return title.trim();
  const head = m[1]!;
  const tail = m[2]!.trim();
  const tailWords = tail.split(/\s+/).length;
  const headWords = head.split(/\s+/).length;
  return tailWords <= 4 && headWords >= 3 ? head : title.trim();
}

export function titleFingerprint(title: string): string {
  const tokens = normalizeText(stripSourceSuffix(title))
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
  const canonical = [...new Set(tokens)].sort().join(" ");
  return createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}

/** Distinct outlets carrying each story (fingerprint). Reach, not independence. */
export function domainsPerFingerprint(articles: Pick<NewsArticle, "titleFingerprint" | "domain">[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const a of articles) {
    const set = sets.get(a.titleFingerprint) ?? new Set<string>();
    set.add(a.domain ?? "(unknown)");
    sets.set(a.titleFingerprint, set);
  }
  return new Map([...sets].map(([k, v]) => [k, v.size]));
}

/**
 * Independent sources among articles about one event: each story
 * (fingerprint) is attributed to a single outlet — its earliest-seen copy —
 * and distinct outlets are counted. Syndicated copies of one story therefore
 * count once, and several stories from the same outlet also count once.
 */
export function independentSourceCount(articles: Pick<NewsArticle, "titleFingerprint" | "domain" | "publishedAt" | "canonicalUrl">[]): number {
  const firstByStory = new Map<string, { domain: string; at: number; url: string }>();
  for (const a of articles) {
    const domain = a.domain ?? hostOf(a.canonicalUrl) ?? a.canonicalUrl;
    const at = a.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const prev = firstByStory.get(a.titleFingerprint);
    if (!prev || at < prev.at || (at === prev.at && a.canonicalUrl < prev.url)) {
      firstByStory.set(a.titleFingerprint, { domain, at, url: a.canonicalUrl });
    }
  }
  return new Set([...firstByStory.values()].map((v) => v.domain)).size;
}

// ── Categorization ────────────────────────────────────────────

export const NEWS_CATEGORIES = [
  "flood",
  "storm",
  "fire",
  "road",
  "infrastructure",
  "construction",
  "drought",
  "agriculture",
  "public_safety",
  "other",
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/** First match wins; hazards precede consequences (a flood that closes roads is a flood story). */
const TAXONOMY: [NewsCategory, RegExp][] = [
  ["flood", /\b(floods?|flooded|flooding|flash floods?|floodwaters?|inundat\w*|high water|rising waters?|storm surge|levees?|river crests?|crested|overflow\w*)\b/],
  ["storm", /\b(hurricanes?|tropical (storm|depression)s?|tornado(es|s)?|thunderstorms?|severe weather|hail(storms?)?|storms?|stormy|blizzards?|derechos?|damaging winds?|high winds?|winter weather|ice storms?|nor.?easters?)\b/],
  ["fire", /\b(wild ?fires?|brush ?fires?|forest fires?|house fires?|structure fires?|fires?|blazes?|firefighters?|burn bans?|arson)\b/],
  ["drought", /\b(droughts?|dry conditions|water restrictions?|water shortages?|low water levels?)\b/],
  ["infrastructure", /\b(power outages?|outages?|without power|power restored|water mains?|boil (water )?(advisory|notice)|sewer\w*|wastewater|dams?|bridges?|pipelines?|substations?|utility|utilities|grid|water treatment|broadband|culverts?)\b/],
  ["road", /\b(roads?|roadways?|lane closures?|detours?|traffic|crash(es)?|wrecks?|collisions?|highways?|interstates?|i-\d+|paving|potholes?)\b/],
  ["construction", /\b(construction|groundbreaking|breaks? ground|rezon\w*|permits?|demolition|development|subdivisions?|housing projects?|data cent(er|re)s?|solar farms?|warehouse)\b/],
  ["agriculture", /\b(crops?|harvest\w*|farms?|farmers?|farmland|livestock|cattle|poultry|hogs?|tobacco|cotton|peanuts?|soybeans?|corn|wheat|agricultur\w*|usda)\b/],
  ["public_safety", /\b(police|sheriffs?|deputies|shootings?|arrest\w*|charged|homicides?|murders?|robber(y|ies)|crimes?|stabbings?|assaults?|missing|amber alert|lockdown|evacuat\w*|hazmat|chemical (spill|leak)s?|gas leaks?|explosions?|emergency|rescue[sd]?|drown\w*)\b/],
];

/** Topic of a headline. Crime stories are public_safety; no person-level details are extracted. */
export function categorize(title: string): NewsCategory {
  const t = ` ${title.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()} `;
  for (const [category, re] of TAXONOMY) if (re.test(t)) return category;
  return "other";
}

// ── Location match ────────────────────────────────────────────

export type LocationMatch = "place_in_title" | "term_in_title" | "query_only";

/** Whether the headline names the AOI's place, another query term, or neither (matched only by GDELT's full-text search). */
export function locationMatch(title: string, placeNames: string[], terms: string[]): LocationMatch {
  const hay = ` ${normalizeText(title)} `;
  const contains = (needle: string) => {
    const n = normalizeText(needle);
    return n.length > 0 && hay.includes(` ${n} `);
  };
  if (placeNames.some(contains)) return "place_in_title";
  if (terms.some(contains)) return "term_in_title";
  return "query_only";
}
