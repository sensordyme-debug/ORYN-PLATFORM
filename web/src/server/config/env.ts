/**
 * Server-side configuration.
 *
 * Every variable is read lazily and validated where it is used, so the public
 * marketing site still builds and runs when the platform is not configured.
 * Nothing in this module is safe to import into client components: it reads
 * secrets. Only variables prefixed NEXT_PUBLIC_ ever reach the browser.
 */
import { z } from "zod";

export class ConfigError extends Error {
  constructor(
    public readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function required(name: string, hint: string): string {
  const v = read(name);
  if (!v) throw new ConfigError(name, `${name} is not set. ${hint}`);
  return v;
}

function bool(name: string, fallback = false): boolean {
  const v = read(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] {
  return (read(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = read(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(name, `${name} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

export const isProduction = () => process.env.NODE_ENV === "production";

export const env = {
  /** Connection string for the least-privilege application role (RLS enforced). */
  databaseUrl: () =>
    required("DATABASE_URL", "Point it at PostgreSQL with PostGIS using the oryn_app role. See README → Platform setup."),
  /** Owner connection used only by migrations and administrative CLI scripts. */
  databaseOwnerUrl: () =>
    required("DATABASE_OWNER_URL", "Required for migrations and admin scripts (the schema owner role)."),
  databaseConfigured: () => Boolean(read("DATABASE_URL")),
  dbPoolMax: () => int("DATABASE_POOL_MAX", 10, 1, 200),

  authSecret: () => {
    const s = required("BETTER_AUTH_SECRET", "Generate one with: openssl rand -base64 48");
    if (s.length < 32) throw new ConfigError("BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET must be at least 32 characters.");
    return s;
  },
  authBaseUrl: () => read("BETTER_AUTH_URL") ?? read("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000",
  /** Comma-separated additional origins allowed to call auth endpoints. */
  authTrustedOrigins: () => (read("ORYN_TRUSTED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /**
   * Reverse proxies (CIDRs) whose X-Forwarded-For entries are trusted when
   * finding the client address for sign-in rate limits. Without it, only a
   * single-address X-Forwarded-For is used (e.g. Vercel); a multi-hop chain
   * would put every client in one shared bucket.
   */
  authTrustedProxies: () => (read("ORYN_TRUSTED_PROXIES") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /**
   * A single-value header that the platform's edge proxy sets to the client
   * address and overwrites on every request (Railway: x-real-ip). Used instead
   * of X-Forwarded-For for sign-in rate limits and audit IPs; Railway's
   * X-Forwarded-For is a multi-hop chain, which otherwise puts every client
   * in one shared rate-limit bucket. Only set it for a header the proxy
   * controls — a client-settable header would let callers pick their bucket.
   */
  authClientIpHeader: () => {
    const h = read("ORYN_CLIENT_IP_HEADER")?.toLowerCase();
    if (h && !/^[a-z0-9-]{1,64}$/.test(h)) throw new ConfigError("ORYN_CLIENT_IP_HEADER", "ORYN_CLIENT_IP_HEADER must be an HTTP header name.");
    return h;
  },
  /** Session lifetime and sliding refresh, in seconds. */
  sessionMaxAgeSeconds: () => int("ORYN_SESSION_MAX_AGE_SECONDS", 60 * 60 * 12, 300, 60 * 60 * 24 * 30),

  storageDriver: () => (read("ORYN_STORAGE_DRIVER") ?? "local") as "local" | "s3",
  storageDir: () => read("ORYN_STORAGE_DIR") ?? "./var/storage",
  /** The local driver is single-node only; production refuses it unless this is set deliberately. */
  allowLocalStorageInProduction: () => bool("ORYN_ALLOW_LOCAL_STORAGE_IN_PRODUCTION", false),
  s3: () => ({
    bucket: required("ORYN_S3_BUCKET", "Required when ORYN_STORAGE_DRIVER=s3."),
    region: read("ORYN_S3_REGION") ?? "us-east-1",
    endpoint: read("ORYN_S3_ENDPOINT"),
    accessKeyId: required("ORYN_S3_ACCESS_KEY_ID", "Required when ORYN_STORAGE_DRIVER=s3."),
    secretAccessKey: required("ORYN_S3_SECRET_ACCESS_KEY", "Required when ORYN_STORAGE_DRIVER=s3."),
    forcePathStyle: bool("ORYN_S3_FORCE_PATH_STYLE", false),
    /** Server-side encryption requested on every PUT: "AES256" (SSE-S3, default) or "none". */
    sse: (read("ORYN_S3_SSE") ?? "AES256") as "AES256" | "none",
  }),

  cronSecret: () => read("ORYN_CRON_SECRET"),
  /**
   * Port for the worker's /healthz and /readyz (0 = disabled). In production
   * it falls back to PORT, which container platforms (Railway) set and probe;
   * outside production it is off unless ORYN_WORKER_HEALTH_PORT is set, so a
   * PORT meant for the dev web server is never taken by the worker.
   */
  workerHealthPort: () => int("ORYN_WORKER_HEALTH_PORT", isProduction() ? int("PORT", 0, 0, 65535) : 0, 0, 65535),
  workerConcurrency: () => int("ORYN_WORKER_CONCURRENCY", 2, 1, 32),
  workerPollMs: () => int("ORYN_WORKER_POLL_MS", 2000, 200, 60000),
  schedulerIntervalMs: () => int("ORYN_SCHEDULER_INTERVAL_MS", 60_000, 5_000, 3_600_000),

  /** Upper bound on an AOI's area, to keep processing tractable. */
  maxAoiAreaKm2: () => int("ORYN_MAX_AOI_AREA_KM2", 2500, 1, 1_000_000),
  /** Upload size limit in bytes. */
  maxUploadBytes: () => int("ORYN_MAX_UPLOAD_BYTES", 15 * 1024 * 1024, 1024, 500 * 1024 * 1024),

  // ── Providers ──────────────────────────────────────────────
  earthSearchUrl: () => read("EARTH_SEARCH_STAC_URL") ?? "https://earth-search.aws.element84.com/v1",
  planetaryComputerUrl: () => read("PLANETARY_COMPUTER_STAC_URL") ?? "https://planetarycomputer.microsoft.com/api/stac/v1",
  planetaryComputerSasUrl: () => read("PLANETARY_COMPUTER_SAS_URL") ?? "https://planetarycomputer.microsoft.com/api/sas/v1",
  planetaryComputerKey: () => read("PLANETARY_COMPUTER_SUBSCRIPTION_KEY"),
  cdseClientId: () => read("CDSE_CLIENT_ID"),
  cdseClientSecret: () => read("CDSE_CLIENT_SECRET"),
  cdseStacUrl: () => read("CDSE_STAC_URL") ?? "https://stac.dataspace.copernicus.eu/v1",
  earthdataToken: () => read("EARTHDATA_TOKEN"),
  cmrStacUrl: () => read("NASA_CMR_STAC_URL") ?? "https://cmr.earthdata.nasa.gov/stac/LPCLOUD",
  /** NWS requires a User-Agent identifying the application and a contact. */
  nwsUserAgent: () => read("NWS_USER_AGENT"),
  openMeteoApiKey: () => read("OPEN_METEO_API_KEY"),
  /** Open-Meteo's free API is licensed for non-commercial use only. */
  openMeteoAllowNonCommercial: () => bool("OPEN_METEO_ALLOW_NONCOMMERCIAL", !isProduction()),
  gdeltEnabled: () => bool("GDELT_ENABLED", true),
  overpassUrl: () => read("OVERPASS_URL") ?? "https://overpass-api.de/api/interpreter",
  contactEmailForApis: () => read("ORYN_API_CONTACT_EMAIL"),

  // ── Notifications ──────────────────────────────────────────
  resendApiKey: () => read("RESEND_API_KEY"),
  emailFrom: () => read("ORYN_EMAIL_FROM"),

  // ── AI summaries (optional) ────────────────────────────────
  anthropicApiKey: () => read("ANTHROPIC_API_KEY"),
  aiModel: () => read("ORYN_AI_MODEL") ?? "claude-opus-5-5",

  // ── Deployment safety ──────────────────────────────────────
  /**
   * Optional integrations an operator has verified live in this deployment
   * (`npm run oryn:verify`). In production every other gated integration
   * stays off — see src/server/integrations.ts.
   */
  verifiedIntegrations: () => list("ORYN_VERIFIED_INTEGRATIONS"),
  /**
   * Run production-mode builds on one machine against localhost (rehearsal).
   * Honoured only when BETTER_AUTH_URL points at localhost, so it can never
   * relax checks for a deployment real users reach.
   */
  localRehearsal: () => bool("ORYN_LOCAL_REHEARSAL", false),

  // ── Development ────────────────────────────────────────────
  allowSyntheticSeed: () => bool("ORYN_ALLOW_SYNTHETIC_SEED", false),
  logLevel: () => (read("LOG_LEVEL") ?? (isProduction() ? "info" : "debug")) as "debug" | "info" | "warn" | "error",
  appVersion: () =>
    read("ORYN_APP_VERSION") ?? read("RAILWAY_GIT_COMMIT_SHA")?.slice(0, 12) ?? read("VERCEL_GIT_COMMIT_SHA")?.slice(0, 12) ?? "dev",
};

export const uuidSchema = z.uuid();
