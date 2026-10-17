/**
 * Startup safety checks. Production refuses to start (web, worker) or run
 * migrations when the configuration is unsafe — synthetic seeding enabled,
 * development secrets, a database role that can bypass row-level security,
 * local file storage, pending migrations — instead of discovering it later.
 *
 *   checkConfiguration(role)   environment only (synchronous, no network)
 *   checkDatabase(sql, role)   the connected role's privileges, RLS on every
 *                              tenant table, migration state
 *   runStartupPreflight(role)  both; logs every finding; throws on errors in
 *                              production
 *
 * Outside production only a few checks apply and nothing is fatal, so
 * development keeps working. ORYN_LOCAL_REHEARSAL relaxes the checks that
 * cannot pass on a laptop (HTTPS URL, development database passwords, plain
 * HTTP object storage) — and is honoured only when BETTER_AUTH_URL is a
 * localhost URL, which no real user can reach.
 *
 * Findings never include secret values.
 */
import postgres from "postgres";
import { planMigrations } from "@/server/db/migrate";
import { postgresTlsOptions } from "@/server/db/tls";
import { GATED_INTEGRATION_IDS } from "@/server/integrations";
import { log } from "@/server/log";

export type ServiceRole = "web" | "worker" | "migrate" | "cli";
export type PreflightIssue = { level: "error" | "warning"; code: string; message: string };

type Env = Record<string, string | undefined>;

const val = (e: Env, k: string) => {
  const v = e[k];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
};
const truthy = (e: Env, k: string) => ["1", "true", "yes", "on"].includes((val(e, k) ?? "").toLowerCase());
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/** Values that exist in this repository (fixtures, docker-compose, docs) and must never protect a deployment. */
const KNOWN_DEV_VALUES = [
  "test-secret-test-secret-test-secret-0123456789",
  "oryn_owner_dev_only",
  "oryn_app_dev_only",
  "e2e-password-0123456789",
  "dev-admin-password-change-me",
  "oryn-dev-password-2026",
  "choose-a-password",
];
const PLACEHOLDER = /change[-_ ]?me|placeholder|example|dev[-_]?only|insecure|your[-_]/i;

function parseUrl(u: string | undefined): URL | null {
  if (!u) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function isLocalHost(host: string) {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/** Rehearsal mode applies only to a localhost auth URL (production-mode builds on one machine). */
export function rehearsalMode(e: Env = process.env): boolean {
  const auth = parseUrl(val(e, "BETTER_AUTH_URL"));
  return truthy(e, "ORYN_LOCAL_REHEARSAL") && Boolean(auth && isLocalHost(auth.hostname));
}

export function checkConfiguration(role: ServiceRole, e: Env = process.env): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const err = (code: string, message: string) => issues.push({ level: "error", code, message });
  const warn = (code: string, message: string) => issues.push({ level: "warning", code, message });
  const production = e.NODE_ENV === "production";
  const rehearsal = rehearsalMode(e);
  const relaxed = (code: string, message: string) => (rehearsal ? warn(code, `${message} (allowed: local rehearsal)`) : err(code, message));
  const service = role === "web" || role === "worker";

  if (truthy(e, "ORYN_LOCAL_REHEARSAL") && !rehearsal) {
    err("rehearsal_not_local", "ORYN_LOCAL_REHEARSAL is set but BETTER_AUTH_URL is not a localhost URL; it is only for local production-mode rehearsals.");
  }
  if (!production) return issues;

  // ── Synthetic data and one-off secrets ─────────────────────
  if (truthy(e, "ORYN_ALLOW_SYNTHETIC_SEED")) err("synthetic_seed_enabled", "ORYN_ALLOW_SYNTHETIC_SEED must not be enabled in production.");
  for (const k of ["ORYN_DEV_SEED_PASSWORD", "E2E_PASSWORD"]) if (val(e, k)) err("dev_secret_present", `${k} is a development/test variable and must not be set in production.`);
  if (service) {
    for (const k of ["ORYN_ADMIN_PASSWORD", "ORYN_PROVISION_PASSWORD"]) {
      if (val(e, k)) warn("one_off_secret_present", `${k} is for one-off CLI commands; remove it from the ${role} service environment.`);
    }
  }

  // A web deployment without DATABASE_URL serves the marketing site only.
  if (role === "web" && !val(e, "DATABASE_URL")) {
    if (val(e, "NEXT_PUBLIC_PLATFORM_ENABLED") === "true") err("db_url_missing", "NEXT_PUBLIC_PLATFORM_ENABLED=true but DATABASE_URL is not set.");
    else warn("website_only", "DATABASE_URL is not set: serving the public website only (the platform is disabled).");
    return issues;
  }

  // ── Auth ────────────────────────────────────────────────────
  if (role !== "migrate") {
    const secret = val(e, "BETTER_AUTH_SECRET");
    if (!secret) err("auth_secret_missing", "BETTER_AUTH_SECRET is not set.");
    else if (secret.length < 32) err("auth_secret_short", "BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 48).");
    else if (KNOWN_DEV_VALUES.includes(secret) || PLACEHOLDER.test(secret) || new Set(secret).size < 12) {
      err("auth_secret_weak", "BETTER_AUTH_SECRET is a known development value or has too little variety; generate a new one (openssl rand -base64 48).");
    }
    const cron = val(e, "ORYN_CRON_SECRET");
    if (cron && (cron.length < 32 || KNOWN_DEV_VALUES.includes(cron))) err("cron_secret_weak", "ORYN_CRON_SECRET must be at least 32 random characters.");
  }
  if (role === "web") {
    const auth = parseUrl(val(e, "BETTER_AUTH_URL"));
    if (!auth) err("auth_url_missing", "BETTER_AUTH_URL must be set to the public https:// URL of this deployment.");
    else {
      if (auth.protocol !== "https:") relaxed("auth_url_not_https", "BETTER_AUTH_URL must use https:// (session cookies are Secure in production).");
      if (isLocalHost(auth.hostname) && !rehearsal) err("auth_url_localhost", "BETTER_AUTH_URL points at localhost.");
    }
    if (val(e, "NEXT_PUBLIC_PLATFORM_ENABLED") !== "true") warn("platform_link_hidden", "NEXT_PUBLIC_PLATFORM_ENABLED is not \"true\"; the site will not link to sign-in.");
  }

  // ── Database ────────────────────────────────────────────────
  const app = parseUrl(val(e, "DATABASE_URL"));
  const owner = parseUrl(val(e, "DATABASE_OWNER_URL"));
  const checkDbUrl = (name: string, u: URL) => {
    const pw = decodeURIComponent(u.password);
    if (!pw) warn("db_no_password", `${name} has no password (fine only for certificate or IAM authentication).`);
    else if (KNOWN_DEV_VALUES.includes(pw) || PLACEHOLDER.test(pw)) relaxed("db_dev_password", `${name} uses a development password.`);
    const ssl = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl");
    if (!isLocalHost(u.hostname) && !["require", "verify-ca", "verify-full", "true"].includes(ssl ?? "")) {
      warn("db_tls", `${name} does not request TLS (add ?sslmode=verify-full, or require on a private network).`);
    }
    if (val(e, "DATABASE_CA_CERT") && ssl !== "verify-full" && ssl !== "verify-ca") {
      warn("db_ca_unused", `DATABASE_CA_CERT is set but ${name} does not use sslmode=verify-full, so the certificate is not verified.`);
    }
  };
  const ca = val(e, "DATABASE_CA_CERT");
  if (ca && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca.replace(/\\n/g, "\n"))) {
    err("db_ca_invalid", "DATABASE_CA_CERT is not a PEM certificate (expected -----BEGIN CERTIFICATE-----).");
  }
  if (service) {
    if (!app) err("db_url_missing", "DATABASE_URL is not set.");
    else {
      checkDbUrl("DATABASE_URL", app);
      if (owner && decodeURIComponent(owner.username) === decodeURIComponent(app.username)) {
        err("db_same_role", "DATABASE_URL and DATABASE_OWNER_URL use the same role; the application must connect as the least-privilege role (oryn_app).");
      }
    }
    if (owner) warn("owner_url_in_service", `DATABASE_OWNER_URL is set in the ${role} service; only the migration job needs owner credentials.`);
  }
  if (role === "migrate") {
    if (!owner) err("owner_url_missing", "DATABASE_OWNER_URL is not set.");
    else checkDbUrl("DATABASE_OWNER_URL", owner);
  }

  // ── Object storage ──────────────────────────────────────────
  if (service) {
    const driver = val(e, "ORYN_STORAGE_DRIVER") ?? "local";
    if (driver === "local") {
      if (truthy(e, "ORYN_ALLOW_LOCAL_STORAGE_IN_PRODUCTION")) {
        warn("storage_local", "Local file storage: only for a single server with a persistent, backed-up disk shared by web and worker.");
      } else {
        relaxed("storage_local", "ORYN_STORAGE_DRIVER=local in production. Use s3 (or set ORYN_ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true for a deliberate single-server install).");
      }
    } else if (driver === "s3") {
      for (const k of ["ORYN_S3_BUCKET", "ORYN_S3_ACCESS_KEY_ID", "ORYN_S3_SECRET_ACCESS_KEY"]) if (!val(e, k)) err("s3_missing", `${k} is required with ORYN_STORAGE_DRIVER=s3.`);
      const endpoint = parseUrl(val(e, "ORYN_S3_ENDPOINT"));
      if (endpoint && endpoint.protocol !== "https:" && !isLocalHost(endpoint.hostname)) relaxed("s3_plain_http", "ORYN_S3_ENDPOINT must use https://.");
      if (endpoint && endpoint.protocol !== "https:" && isLocalHost(endpoint.hostname) && !rehearsal) err("s3_local_endpoint", "ORYN_S3_ENDPOINT points at a local, unencrypted endpoint.");
      if ((val(e, "ORYN_S3_SSE") ?? "AES256") === "none") warn("s3_no_sse", "ORYN_S3_SSE=none: objects are not encrypted at rest by the storage service unless the bucket enforces it.");
    } else err("storage_driver", `Unknown ORYN_STORAGE_DRIVER "${driver}" (use s3).`);
  }

  // ── Integrations, licensing, provider etiquette ─────────────
  if (service) {
    const verified = (val(e, "ORYN_VERIFIED_INTEGRATIONS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of verified) {
      if (!(GATED_INTEGRATION_IDS as string[]).includes(id)) err("unknown_integration", `ORYN_VERIFIED_INTEGRATIONS lists unknown integration "${id}" (known: ${GATED_INTEGRATION_IDS.join(", ")}).`);
    }
    const needs: Record<string, string[]> = { email: ["RESEND_API_KEY", "ORYN_EMAIL_FROM"], "nasa-hls": ["EARTHDATA_TOKEN"], "ai-summaries": ["ANTHROPIC_API_KEY"] };
    for (const [id, keys] of Object.entries(needs)) {
      const configured = keys.every((k) => val(e, k));
      if (verified.includes(id) && !configured) warn("verified_not_configured", `"${id}" is listed as verified but ${keys.filter((k) => !val(e, k)).join(", ")} is not set.`);
      if (configured && !verified.includes(id)) warn("integration_unverified", `"${id}" is configured but stays off until verified (npm run oryn:verify -- ${id}; then add it to ORYN_VERIFIED_INTEGRATIONS).`);
    }
    const ua = val(e, "NWS_USER_AGENT");
    if (!ua) warn("nws_user_agent", "NWS_USER_AGENT is not set: NWS weather and warnings are off.");
    else if (!/@|https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(ua)) warn("nws_user_agent", "NWS_USER_AGENT has no contact (email or website): NWS weather and warnings are off.");
    if (truthy(e, "OPEN_METEO_ALLOW_NONCOMMERCIAL")) {
      warn("licence_open_meteo", "OPEN_METEO_ALLOW_NONCOMMERCIAL=true uses Open-Meteo's free, NON-COMMERCIAL tier. Only for deployments that are genuinely non-commercial; otherwise set OPEN_METEO_API_KEY.");
    }
    if (!val(e, "OVERPASS_URL") || /overpass-api\.de/.test(val(e, "OVERPASS_URL") ?? "")) {
      warn("overpass_public", "OpenStreetMap imports use the public Overpass instance (fair-use only, results capped and sometimes refused). Point OVERPASS_URL at a dedicated instance for production volume.");
    }
    if ((val(e, "LOG_LEVEL") ?? "info") === "debug") warn("log_debug", "LOG_LEVEL=debug in production writes high-volume logs.");
  }
  return issues;
}

/** Privileges of the connected application role, RLS coverage, and migration state. */
export async function checkDatabase(sql: postgres.Sql, role: ServiceRole): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const [r] = await sql<{ usr: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; in_app_role: boolean }[]>`
    select current_user as usr, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
           exists (select 1 from pg_roles where rolname = 'oryn_app_role') and pg_has_role(current_user, 'oryn_app_role', 'member') as in_app_role
      from pg_roles r where r.rolname = current_user`;
  if (role === "web" || role === "worker") {
    if (r?.rolsuper || r?.rolbypassrls) {
      issues.push({ level: "error", code: "db_role_bypasses_rls", message: `The application database role "${r.usr}" is a superuser or has BYPASSRLS; tenant isolation would not be enforced by the database.` });
    }
    if (!r?.in_app_role) issues.push({ level: "error", code: "db_role_not_app", message: `The application database role "${r?.usr}" is not a member of oryn_app_role.` });
    if (r?.rolcreaterole || r?.rolcreatedb) issues.push({ level: "warning", code: "db_role_privileged", message: `The application database role "${r.usr}" can create roles or databases; it needs neither.` });
  }
  const unprotected = await sql<{ relname: string }[]>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)`;
  if (unprotected.length) {
    issues.push({ level: "error", code: "rls_missing", message: `Tenant tables without row-level security: ${unprotected.map((u) => u.relname).join(", ")}.` });
  }
  try {
    const plan = await planMigrations(sql);
    if (plan.pending.length) issues.push({ level: "error", code: "migrations_pending", message: `Pending migrations (${plan.pending.join(", ")}): run the migration job before starting this release.` });
    if (plan.modified.length) issues.push({ level: "error", code: "migrations_modified", message: `Applied migrations differ from this release: ${plan.modified.join(", ")}.` });
    if (plan.unknown.length) issues.push({ level: "warning", code: "migrations_newer", message: `The database has migrations this release does not know (${plan.unknown.join(", ")}) — expected only during a rollback to an earlier release.` });
  } catch (e) {
    issues.push({ level: "error", code: "migrations_unreadable", message: `Could not read the migration ledger: ${(e as Error).message}` });
  }
  return issues;
}

/** Log findings as structured lines; returns how many are errors. */
export function reportIssues(issues: PreflightIssue[], role: ServiceRole): number {
  for (const i of issues) log[i.level === "error" ? "error" : "warn"]("preflight", { role, code: i.code, detail: i.message });
  return issues.filter((i) => i.level === "error").length;
}

export class PreflightError extends Error {
  constructor(public readonly issues: PreflightIssue[]) {
    super(`Startup refused: ${issues.filter((i) => i.level === "error").map((i) => i.code).join(", ")}. See the preflight log lines above and docs/DEPLOYMENT.md.`);
    this.name = "PreflightError";
  }
}

/**
 * Configuration + database checks at service start. In production, any error
 * throws PreflightError (the caller exits). Outside production it only logs.
 */
export async function runStartupPreflight(role: "web" | "worker", e: Env = process.env): Promise<PreflightIssue[]> {
  const issues = checkConfiguration(role, e);
  const production = e.NODE_ENV === "production";
  if (production && val(e, "DATABASE_URL") && !issues.some((i) => i.level === "error" && i.code.startsWith("db_"))) {
    const sql = postgres(val(e, "DATABASE_URL")!, { ...postgresTlsOptions(val(e, "DATABASE_URL")!), max: 1, onnotice: () => {}, connect_timeout: 10, connection: { application_name: `oryn-preflight-${role}` } });
    try {
      issues.push(...(await checkDatabase(sql, role)));
    } catch (err) {
      issues.push({ level: "error", code: "db_unreachable", message: `Could not connect to the database: ${(err as Error).message}` });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }
  const errors = reportIssues(issues, role);
  if (production && errors > 0) throw new PreflightError(issues);
  log.info("preflight.ok", { role, warnings: issues.length - errors, production });
  return issues;
}
