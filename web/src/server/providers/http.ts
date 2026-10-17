/**
 * HTTP client shared by every external provider adapter.
 *
 * Guarantees
 *   - Every request has a per-attempt timeout and honours the caller's
 *     AbortSignal. A caller abort is never retried and is re-thrown as-is.
 *   - Network errors, timeouts, HTTP 429 and 5xx are retried with exponential
 *     backoff and jitter. A Retry-After header (seconds or HTTP date) is
 *     honoured; when it asks for longer than `maxRetryAfterMs` the request
 *     fails fast with a retryable ProviderError so the job queue can
 *     reschedule instead of holding a worker.
 *   - Response bodies are capped (`maxBytes`); larger bodies are aborted.
 *   - Every request carries a descriptive User-Agent.
 *   - An optional per-host minimum interval spaces requests process-wide
 *     (e.g. GDELT asks for at most one request every 5 seconds). The limiter
 *     is in-memory: it holds per process, not across instances.
 *   - Failures surface as ProviderError with a stable `code`; adapters map
 *     provider-specific failure shapes onto the same codes.
 *   - Logged URLs never include query strings (they may carry API keys or
 *     SAS signatures), and the logger redacts secret-looking fields as well.
 *
 * Tests (and any caller) can inject a fetch implementation per request via
 * `fetchImpl`, or swap the process default with setProviderFetch().
 */
import { env } from "@/server/config/env";
import { log } from "@/server/log";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProviderErrorCode = "unavailable" | "rate_limited" | "bad_response" | "unconfigured" | "not_found" | "timeout";

export class ProviderError extends Error {
  readonly providerId: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  /** Suggested wait before retrying, when the provider said so. */
  readonly retryAfterMs?: number;

  constructor(
    providerId: string,
    code: ProviderErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (code === "unavailable" || code === "rate_limited" || code === "timeout");
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

// ── Fetch injection ───────────────────────────────────────────

const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
let defaultFetch: FetchLike = globalFetch;

/** Replace the fetch used when a request does not pass `fetchImpl` (tests, proxies). */
export function setProviderFetch(f: FetchLike | null): void {
  defaultFetch = f ?? globalFetch;
}

// ── Helpers ───────────────────────────────────────────────────

/** origin + path, without query string or fragment — safe to log. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

/** Descriptive User-Agent identifying ORYN and a contact, as public APIs request. */
export function orynUserAgent(): string {
  let version = "dev";
  let contact: string | undefined;
  try {
    version = env.appVersion();
    contact = env.contactEmailForApis() ?? env.authBaseUrl();
  } catch {
    /* configuration is optional here */
  }
  return `ORYN/${version} (geospatial monitoring platform${contact ? `; ${contact}` : ""})`;
}

/** Parse Retry-After (delta-seconds or HTTP-date) into milliseconds from `nowMs`. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.max(0, Math.round(Number(v) * 1000));
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, t - nowMs);
  return undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

// ── Per-host minimum interval ─────────────────────────────────

const nextSlotByHost = new Map<string, number>();

/**
 * Reserve the next request slot for `host`. Reservation is synchronous, so
 * concurrent callers queue in order rather than racing for the same slot.
 */
async function waitForHostSlot(host: string, minIntervalMs: number, deps: Deps, signal?: AbortSignal): Promise<void> {
  if (minIntervalMs <= 0) return;
  const now = deps.now();
  const slot = Math.max(now, nextSlotByHost.get(host) ?? 0);
  nextSlotByHost.set(host, slot + minIntervalMs);
  if (slot > now) await deps.sleep(slot - now, signal);
}

/** Forget limiter state (tests). */
export function resetHostLimiter(): void {
  nextSlotByHost.clear();
}

// ── Request ───────────────────────────────────────────────────

export type HttpRequestOptions = {
  providerId: string;
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  /** Raw body (string or form parameters). */
  body?: string | URLSearchParams;
  /** JSON body; sets content-type. */
  json?: unknown;
  signal?: AbortSignal;
  /** Per-attempt timeout, including reading the body. Default 20 s. */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures. Default 2. */
  retries?: number;
  /** Maximum response body size. Default 25 MB. */
  maxBytes?: number;
  /** Process-wide minimum spacing between requests to this URL's host. */
  minIntervalMs?: number;
  /** Longest Retry-After the client will wait in-process. Default 30 s. */
  maxRetryAfterMs?: number;
  /** Base for exponential backoff. Default 500 ms; capped at 8 s. */
  backoffBaseMs?: number;
  userAgent?: string;
  fetchImpl?: FetchLike;
  /** Injection points for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

export type HttpResult = {
  status: number;
  headers: Headers;
  /** Final URL after redirects (may contain secrets — do not log). */
  url: string;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
};

type Deps = { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; now: () => number; random: () => number };

const MAX_BACKOFF_MS = 8_000;

/** A short explanation from a 4xx body ({"reason"}, {"detail"}, {"error":{"message"}}, or plain text), or null. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const bytes = await readBody(res, 4096, "error-body");
    const text = new TextDecoder().decode(bytes).trim();
    if (!text) return "";
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const nested = j.error && typeof j.error === "object" ? (j.error as Record<string, unknown>).message : undefined;
      const pick = [j.reason, j.detail, j.message, j.title, nested, typeof j.error === "string" ? j.error : undefined].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
      if (pick) return pick.slice(0, 200);
    } catch {
      /* not JSON */
    }
    return /<html/i.test(text) ? "" : text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}

function classifyStatus(providerId: string, status: number, statusText: string, retryAfterMs: number | undefined, detail?: string | null): ProviderError {
  const msg = `${providerId} responded ${status}${statusText ? ` ${statusText}` : ""}${detail ? `: ${detail}` : ""}`;
  if (status === 429) return new ProviderError(providerId, "rate_limited", msg, { status, retryable: true, retryAfterMs });
  if (status === 404 || status === 410) return new ProviderError(providerId, "not_found", msg, { status, retryable: false });
  if (status === 401 || status === 403)
    return new ProviderError(providerId, "unconfigured", `${msg} (credentials or identification refused)`, { status, retryable: false });
  if (status === 408) return new ProviderError(providerId, "timeout", msg, { status, retryable: true });
  if (status >= 500) return new ProviderError(providerId, "unavailable", msg, { status, retryable: true, retryAfterMs });
  return new ProviderError(providerId, "bad_response", msg, { status, retryable: false });
}

async function readBody(res: Response, maxBytes: number, providerId: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError(providerId, "bad_response", `Response of ${declared} bytes exceeds the ${maxBytes}-byte limit`, {
      status: res.status,
      retryable: false,
    });
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProviderError(providerId, "bad_response", `Response exceeded the ${maxBytes}-byte limit`, {
        status: res.status,
        retryable: false,
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function makeResult(res: Response, body: Uint8Array, providerId: string): HttpResult {
  let text: string | undefined;
  const getText = () => (text ??= new TextDecoder().decode(body));
  return {
    status: res.status,
    headers: res.headers,
    url: res.url,
    body,
    text: getText,
    json<T>() {
      try {
        return JSON.parse(getText()) as T;
      } catch (e) {
        throw new ProviderError(providerId, "bad_response", `${providerId} returned invalid JSON`, {
          status: res.status,
          retryable: false,
          cause: e,
        });
      }
    },
  };
}

/** Perform a request with timeout, retries, size cap, and per-host spacing. Non-2xx responses throw. */
export async function httpRequest(url: string, opts: HttpRequestOptions): Promise<HttpResult> {
  const providerId = opts.providerId;
  const method = opts.method ?? (opts.json !== undefined || opts.body !== undefined ? "POST" : "GET");
  const retries = Math.max(0, opts.retries ?? 2);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 30_000;
  const backoffBaseMs = opts.backoffBaseMs ?? 500;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const deps: Deps = { sleep: opts.sleep ?? sleep, now: opts.now ?? Date.now, random: opts.random ?? Math.random };
  const callerSignal = opts.signal;

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new ProviderError(providerId, "bad_response", `Invalid request URL for ${providerId}`, { retryable: false });
  }

  const headers: Record<string, string> = { "user-agent": opts.userAgent ?? orynUserAgent(), ...lowerKeys(opts.headers) };
  let body: string | URLSearchParams | undefined = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["content-type"] ??= "application/json";
  }
  headers.accept ??= "application/json";

  const target = safeUrl(url);
  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    await waitForHostSlot(host, opts.minIntervalMs ?? 0, deps, callerSignal);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
    const onCallerAbort = () => controller.abort(abortReason(callerSignal!));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const started = deps.now();
    let failure: ProviderError;
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: "follow" });
      if (res.ok) {
        const bytes = await readBody(res, maxBytes, providerId);
        log.debug("provider request", { provider: providerId, method, url: target, status: res.status, ms: deps.now() - started, attempt });
        return makeResult(res, bytes, providerId);
      }
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), deps.now());
      const detail = res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429 ? await errorDetail(res) : null;
      if (detail === null) await res.body?.cancel().catch(() => {});
      failure = classifyStatus(providerId, res.status, res.statusText, retryAfterMs, detail);
    } catch (e) {
      if (callerSignal?.aborted) throw abortReason(callerSignal);
      if (e instanceof ProviderError) {
        // Body too large and similar: decided, not retried.
        if (!e.retryable) throw e;
        failure = e;
      } else if (timedOut) {
        failure = new ProviderError(providerId, "timeout", `${providerId} did not respond within ${timeoutMs} ms`, { retryable: true, cause: e });
      } else {
        failure = new ProviderError(providerId, "unavailable", `${providerId} request failed: ${errorMessage(e)}`, { retryable: true, cause: e });
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    log.debug("provider request failed", {
      provider: providerId,
      method,
      url: target,
      status: failure.status,
      code: failure.code,
      ms: deps.now() - started,
      attempt,
    });

    if (!failure.retryable || attempt >= retries) throw failure;
    if (failure.retryAfterMs !== undefined && failure.retryAfterMs > maxRetryAfterMs) throw failure;

    const exp = Math.min(MAX_BACKOFF_MS, backoffBaseMs * 2 ** attempt);
    const backoff = Math.round(exp / 2 + (deps.random() * exp) / 2);
    const delay = Math.max(failure.retryAfterMs ?? 0, backoff);
    log.warn("provider request retrying", { provider: providerId, url: target, code: failure.code, status: failure.status, delayMs: delay, attempt });
    await deps.sleep(delay, callerSignal);
  }
}

export async function httpJson<T = unknown>(url: string, opts: HttpRequestOptions): Promise<T> {
  const res = await httpRequest(url, opts);
  return res.json<T>();
}

export async function httpText(url: string, opts: HttpRequestOptions): Promise<string> {
  const res = await httpRequest(url, { ...opts, headers: { accept: "*/*", ...lowerKeys(opts.headers) } });
  return res.text();
}

function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (h) for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
    return code ? `${e.message} (${code})` : e.message;
  }
  return String(e);
}

/** Measure a cheap probe for health checks. Never throws. */
export async function timedProbe(
  probe: () => Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }>,
  now: () => number = Date.now,
): Promise<{ ok: boolean; latencyMs: number; message?: string; details?: Record<string, unknown> }> {
  const started = now();
  try {
    const r = await probe();
    return { ...r, latencyMs: now() - started };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : null;
    return {
      ok: false,
      latencyMs: now() - started,
      message: pe ? pe.message : errorMessage(e),
      details: pe ? { code: pe.code, status: pe.status ?? null, retryable: pe.retryable } : undefined,
    };
  }
}
