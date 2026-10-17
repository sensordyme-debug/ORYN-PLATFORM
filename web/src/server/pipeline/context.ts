/**
 * aoi.context_sync — weather, official warnings, and news for one AOI, ONE
 * provider per job.
 *
 *  - Each provider (nws, open-meteo, gdelt) is its own job, so a provider
 *    failure fails that job — recorded as failed, retried by the queue with
 *    backoff (or after the provider's cooldown), and visible — instead of
 *    hiding inside another provider's success. Every attempt writes a
 *    provider_sync_runs row: succeeded, failed (with the error), or skipped
 *    (provider not configured / not verified / not selected — nothing was
 *    requested, so nothing is reported as ingested).
 *  - Weather records keep their kind: station observation, forecast, or
 *    model estimate (reanalysis). Re-fetching updates values in place
 *    (forecasts are re-issued; observations can be corrected).
 *  - NWS alerts are stored as official warnings.
 *  - News is stored as claims: each article links to its source, is grouped
 *    into a story by title fingerprint, and a story counts as "corroborated"
 *    only when two or more independent domains carry it. Syndicated copies
 *    of one story are not independent confirmation.
 *  - GDELT's published limit (one request per 5 s per client) is enforced
 *    across processes (request-slots.ts); a rate-limit response puts GDELT in
 *    a shared cooldown and the job is retried after it.
 */
import { jsonb, withTenant, type Tx } from "@/server/db/client";
import { enqueueTx, PermanentJobError } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobContext } from "@/server/jobs/worker";
import { isProviderError } from "@/server/providers/http";
import { categorize, gdeltAvailability, GDELT_MIN_INTERVAL_MS, locationMatch, searchArticles } from "@/server/providers/news/gdelt";
import { acquireProviderSlot, startProviderCooldown } from "@/server/providers/request-slots";
import { recordProviderFailure, recordProviderSuccess } from "@/server/providers/status";
import type { NewsArticle, ProviderAvailability, WeatherRecord, WeatherWarning } from "@/server/providers/types";
import { fetchActiveAlerts, fetchDailyForecast as nwsForecast, fetchRecentObservations, nwsAvailability } from "@/server/providers/weather/nws";
import { fetchDailyHistory, fetchDailyForecast as omForecast, openMeteoAvailability } from "@/server/providers/weather/open-meteo";
import { env } from "@/server/config/env";
import { log, redactString } from "@/server/log";

export const CONTEXT_PROVIDERS = ["nws", "open-meteo", "gdelt"] as const;
export type ContextProvider = (typeof CONTEXT_PROVIDERS)[number];
const isContextProvider = (p: unknown): p is ContextProvider => typeof p === "string" && (CONTEXT_PROVIDERS as readonly string[]).includes(p);

/** Whether a context provider can be called now (configuration, licensing, verification). */
export function contextProviderAvailability(provider: ContextProvider): ProviderAvailability {
  if (provider === "nws") return nwsAvailability();
  if (provider === "open-meteo") return openMeteoAvailability({ apiKey: env.openMeteoApiKey(), allowNonCommercial: env.openMeteoAllowNonCommercial() });
  return gdeltAvailability();
}

/** Context providers an AOI asks for (GDELT only when it has news terms). */
export function contextProvidersFor(aoi: { data_sources: string[]; news_terms: string[] }): ContextProvider[] {
  return CONTEXT_PROVIDERS.filter((p) => aoi.data_sources.includes(p) && (p !== "gdelt" || aoi.news_terms.length > 0));
}

/**
 * Queue one context job per provider. A provider that already has a job
 * waiting for this AOI is not queued again (an AOI created and immediately
 * edited previously produced two simultaneous jobs and duplicate GDELT
 * requests). Unavailable providers are not queued at all; the provider
 * health job records why they are off.
 */
export async function enqueueContextSync(
  tx: Tx,
  o: { orgId: string; aoiId: string; providers: ContextProvider[]; reason: string; priority: number; key: string; createdBy?: string | null },
): Promise<number> {
  let created = 0;
  for (const provider of o.providers) {
    if (contextProviderAvailability(provider).state !== "available") continue;
    const [waiting] = await tx`
      select 1 from jobs
       where type = ${JOB.aoiContextSync} and status = 'queued' and org_id = ${o.orgId}
         and payload->>'aoiId' = ${o.aoiId} and payload->>'provider' = ${provider}
       limit 1`;
    if (waiting) continue;
    const r = await enqueueTx(tx, {
      orgId: o.orgId,
      type: JOB.aoiContextSync,
      payload: { aoiId: o.aoiId, provider, reason: o.reason },
      priority: o.priority,
      timeoutSeconds: 300,
      idempotencyKey: `context:${o.aoiId}:${provider}:${o.key}`,
      createdBy: o.createdBy ?? null,
    });
    if (r.created) created++;
  }
  return created;
}

type AoiCtx = { status: string; name: string; data_sources: string[]; news_terms: string[]; lon: number; lat: number };

async function upsertWeather(tx: Tx, orgId: string, aoiId: string, records: WeatherRecord[]): Promise<number> {
  let inserted = 0;
  for (const r of records) {
    const [row] = await tx<{ inserted: boolean }[]>`
      insert into weather_records (org_id, aoi_id, provider_id, record_kind, variable, value, unit, valid_from, valid_to, issued_at, station_id, station_distance_km, source_url)
      values (${orgId}, ${aoiId}, ${r.providerId}, ${r.recordKind}, ${r.variable}, ${r.value}, ${r.unit}, ${r.validFrom}, ${r.validTo}, ${r.issuedAt},
              ${r.stationId}, ${r.stationDistanceKm}, ${r.sourceUrl})
      on conflict (aoi_id, provider_id, record_kind, variable, valid_from, valid_to) do update set
        value = excluded.value, issued_at = excluded.issued_at, retrieved_at = now(),
        station_id = excluded.station_id, station_distance_km = excluded.station_distance_km
      returning (xmax = 0) as inserted`;
    if (row?.inserted) inserted++;
  }
  return inserted;
}

async function upsertWarnings(tx: Tx, orgId: string, aoiId: string, warnings: WeatherWarning[]): Promise<string[]> {
  const ids: string[] = [];
  for (const w of warnings) {
    const [row] = await tx<{ id: string }[]>`
      insert into external_events (org_id, aoi_id, provider_id, event_kind, external_id, title, description, severity, certainty, urgency, category,
                                   geom, event_start, event_end, published_at, source_url, claim_status)
      values (${orgId}, ${aoiId}, ${w.providerId}, 'weather_warning', ${w.externalId}, ${w.title}, ${w.description}, ${w.severity}, ${w.certainty},
              ${w.urgency}, ${w.category},
              ${w.geometry ? tx`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(w.geometry)}), 4326)` : tx`null`},
              ${w.start}, ${w.end}, ${w.publishedAt}, ${w.sourceUrl}, 'official_warning')
      on conflict (aoi_id, provider_id, external_id) do update set
        title = excluded.title, description = excluded.description, severity = excluded.severity, certainty = excluded.certainty,
        urgency = excluded.urgency, event_end = excluded.event_end, retrieved_at = now()
      returning id`;
    if (row) ids.push(row.id);
  }
  return ids;
}

async function storeNews(tx: Tx, orgId: string, aoiId: string, aoi: AoiCtx, articles: NewsArticle[]): Promise<number> {
  const places = [aoi.name, ...aoi.news_terms];
  const touchedStories = new Set<string>();
  let newMatches = 0;
  for (const a of articles) {
    const [art] = await tx<{ id: string }[]>`
      insert into news_articles (provider_id, url, canonical_url, title, domain, language, source_country, published_at, title_fingerprint)
      values (${a.providerId}, ${a.url}, ${a.canonicalUrl}, ${a.title}, ${a.domain}, ${a.language}, ${a.sourceCountry}, ${a.publishedAt}, ${a.titleFingerprint})
      on conflict (canonical_url) do update set retrieved_at = now()
      returning id`;
    const match = locationMatch(a.title, places, aoi.news_terms);
    const terms = aoi.news_terms.filter((t) => a.title.toLowerCase().includes(t.toLowerCase()));
    const m = await tx`
      insert into aoi_news_matches (org_id, aoi_id, article_id, matched_terms, location_match, category, story_key)
      values (${orgId}, ${aoiId}, ${art!.id}, ${terms}, ${match}, ${categorize(a.title)}, ${a.titleFingerprint})
      on conflict (aoi_id, article_id) do nothing
      returning 1`;
    newMatches += m.length;
    touchedStories.add(a.titleFingerprint);
  }
  // One external event per story; corroborated only with ≥ 2 independent domains.
  for (const story of touchedStories) {
    const [s] = await tx<{ title: string; url: string; published_at: Date | null; domains: number; category: string; articles: number }[]>`
      select (array_agg(n.title order by n.published_at))[1] as title, (array_agg(n.url order by n.published_at))[1] as url,
             min(n.published_at) as published_at, count(distinct n.domain)::int as domains, (array_agg(m.category))[1] as category,
             count(*)::int as articles
        from aoi_news_matches m join news_articles n on n.id = m.article_id
       where m.aoi_id = ${aoiId} and m.story_key = ${story}`;
    if (!s) continue;
    await tx`
      insert into external_events (org_id, aoi_id, provider_id, event_kind, external_id, title, category, published_at, source_url, claim_status, details)
      values (${orgId}, ${aoiId}, 'gdelt', 'news_report', ${story}, ${s.title}, ${s.category}, ${s.published_at}, ${s.url},
              ${s.domains >= 2 ? "corroborated" : "reported"}, ${jsonb({ independent_domains: s.domains, articles: s.articles })}::jsonb)
      on conflict (aoi_id, provider_id, external_id) do update set
        claim_status = case when external_events.claim_status in ('verified', 'disputed') then external_events.claim_status else excluded.claim_status end,
        details = excluded.details, retrieved_at = now()`;
  }
  return newMatches;
}

type Outcome = { summary: string; found: number; inserted: number; warningIds?: string[] };

async function fetchAndStore(provider: ContextProvider, ctx: JobContext, orgId: string, aoiId: string, aoi: AoiCtx): Promise<Outcome> {
  if (provider === "nws") {
    const opts = { signal: ctx.signal, production: process.env.NODE_ENV === "production" };
    const warnings = await fetchActiveAlerts(aoi.lat, aoi.lon, { ...opts, resolveZoneGeometry: true });
    const forecast = await nwsForecast(aoi.lat, aoi.lon, opts);
    const obs = await fetchRecentObservations(aoi.lat, aoi.lon, { ...opts, hours: 72 });
    ctx.checkpoint();
    return withTenant({ orgId }, async (tx) => {
      const inserted = await upsertWeather(tx, orgId, aoiId, [...forecast, ...obs]);
      const warningIds = await upsertWarnings(tx, orgId, aoiId, warnings);
      return {
        summary: `${warnings.length} active warnings, ${forecast.length} forecast and ${obs.length} observation records`,
        found: warnings.length + forecast.length + obs.length,
        inserted,
        warningIds,
      };
    });
  }
  if (provider === "open-meteo") {
    const opts = { apiKey: env.openMeteoApiKey(), allowNonCommercial: env.openMeteoAllowNonCommercial(), signal: ctx.signal };
    const end = new Date(Date.now() - 86_400_000);
    const start = new Date(Date.now() - 45 * 86_400_000);
    const history = await fetchDailyHistory(aoi.lat, aoi.lon, start, end, opts);
    const forecast = await omForecast(aoi.lat, aoi.lon, 7, opts);
    ctx.checkpoint();
    const inserted = await withTenant({ orgId }, (tx) => upsertWeather(tx, orgId, aoiId, [...history, ...forecast]));
    return { summary: `${history.length} reanalysis and ${forecast.length} forecast records`, found: history.length + forecast.length, inserted };
  }
  const articles = await searchArticles({
    terms: aoi.news_terms,
    start: new Date(Date.now() - 14 * 86_400_000),
    end: new Date(),
    maxRecords: 75,
    sourceCountry: "US",
    signal: ctx.signal,
    acquireSlot: (signal) => acquireProviderSlot("gdelt", GDELT_MIN_INTERVAL_MS, signal),
    onRateLimited: (ms, reason) => startProviderCooldown("gdelt", ms, reason),
  });
  ctx.checkpoint();
  const inserted = await withTenant({ orgId }, (tx) => storeNews(tx, orgId, aoiId, aoi, articles));
  return { summary: `${articles.length} articles`, found: articles.length, inserted };
}

async function recordRun(orgId: string, aoiId: string, provider: ContextProvider, status: "succeeded" | "failed" | "skipped", o: { found?: number; inserted?: number; error?: string; details?: Record<string, unknown> }) {
  await withTenant({ orgId }, (tx) => tx`
    insert into provider_sync_runs (provider_id, org_id, aoi_id, product, finished_at, status, items_found, items_new, error, details)
    values (${provider}, ${orgId}, ${aoiId}, ${`${provider}:context`}, now(), ${status}, ${o.found ?? 0}, ${o.inserted ?? 0},
            ${o.error ? redactString(o.error).slice(0, 1000) : null}, ${jsonb(o.details ?? {})}::jsonb)`).catch((err) =>
    // Never mask the job's real outcome because the bookkeeping row failed.
    log.error("context.sync_run_record_failed", { provider, aoiId, err }),
  );
}

const isForeignKeyViolation = (err: unknown) => (err as { code?: string } | null)?.code === "23503";

export async function contextSyncHandler(ctx: JobContext): Promise<unknown> {
  const p = ctx.job.payload as { aoiId: string; provider?: string; reason?: string };
  const orgId = ctx.job.org_id;
  if (!orgId) throw new PermanentJobError("aoi.context_sync requires an organization.");
  const loadAoi = () =>
    withTenant({ orgId }, async (tx) => {
      const [a] = await tx<AoiCtx[]>`
        select status, name, data_sources, news_terms, ST_X(label_point) as lon, ST_Y(label_point) as lat from aois where id = ${p.aoiId} and org_id = ${orgId}`;
      return a;
    });
  const aoi = await loadAoi();
  if (!aoi) return { status: "skipped", reason: "aoi_deleted" };
  if (aoi.status !== "active") return { status: "skipped", reason: "aoi_archived" };

  // Jobs queued before per-provider jobs existed: split them up.
  if (p.provider === undefined) {
    const providers = contextProvidersFor(aoi);
    const queued = await withTenant({ orgId }, (tx) =>
      enqueueContextSync(tx, { orgId, aoiId: p.aoiId, providers, reason: p.reason ?? "split", priority: 90, key: `split:${ctx.job.id}` }),
    );
    return { status: "split", providers, queued };
  }
  if (!isContextProvider(p.provider)) throw new PermanentJobError(`Unknown context provider "${p.provider}".`);
  const provider = p.provider;

  if (!contextProvidersFor(aoi).includes(provider)) {
    await recordRun(orgId, p.aoiId, provider, "skipped", { details: { reason: "not_selected" } });
    return { provider, status: "skipped", reason: "The area no longer uses this source." };
  }
  const availability = contextProviderAvailability(provider);
  if (availability.state !== "available") {
    // Nothing was requested, so nothing is reported as ingested.
    await recordRun(orgId, p.aoiId, provider, "skipped", { details: { reason: availability.state, message: availability.reason } });
    await recordProviderFailure(provider, new Error(availability.reason), availability.state === "unconfigured" ? "unconfigured" : "disabled");
    return { provider, status: "skipped", reason: availability.reason };
  }

  try {
    ctx.checkpoint();
    const out = await fetchAndStore(provider, ctx, orgId, p.aoiId, aoi);
    await recordRun(orgId, p.aoiId, provider, "succeeded", { found: out.found, inserted: out.inserted });
    await recordProviderSuccess(provider);
    // Weather and warnings feed alert rules; no rule type consumes news.
    if (provider !== "gdelt") {
      await withTenant({ orgId }, (tx) =>
        enqueueTx(tx, {
          orgId,
          type: JOB.alertsEvaluate,
          payload: { aoiId: p.aoiId, trigger: { kind: out.warningIds?.length ? "warning" : "weather", ids: out.warningIds ?? [] } },
          priority: 80,
          idempotencyKey: `alerts:context:${p.aoiId}:${provider}:${Math.floor(Date.now() / 3_600_000)}`,
        }),
      );
    }
    return { provider, status: "ingested", summary: out.summary, records: out.found, new: out.inserted };
  } catch (err) {
    // The area was deleted while this job ran: nothing to store, not a failure.
    if (isForeignKeyViolation(err) && !(await loadAoi())) return { provider, status: "skipped", reason: "aoi_deleted" };
    const message = err instanceof Error ? err.message : String(err);
    await recordRun(orgId, p.aoiId, provider, "failed", {
      error: message,
      details: isProviderError(err) ? { code: err.code, status: err.status ?? null, retryable: err.retryable, retry_after_ms: err.retryAfterMs ?? null } : {},
    });
    await recordProviderFailure(provider, err, isProviderError(err) && err.code === "unconfigured" ? "unconfigured" : "degraded");
    throw err; // the queue records the failure and retries (or fails permanently) per jobErrorPolicy
  }
}
