import { describe, expect, it } from "vitest";
import { checkConfiguration, rehearsalMode } from "@/server/config/preflight";

const SECRET = "Zq8vN3pL0xR7tY2wK5mB9cH4jF6gD1sA-uE_iO8pQ";
const base = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "https://oryn.example.org",
  NEXT_PUBLIC_PLATFORM_ENABLED: "true",
  DATABASE_URL: "postgres://oryn_app:Kx92-lmQp7Rt3vWz@db.internal:5432/oryn?sslmode=verify-full",
  ORYN_STORAGE_DRIVER: "s3",
  ORYN_S3_BUCKET: "oryn-prod",
  ORYN_S3_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID",
  ORYN_S3_SECRET_ACCESS_KEY: "s3-secret-value-xyz",
  NWS_USER_AGENT: "(oryn.example.org, ops@example.org)",
  OVERPASS_URL: "https://overpass.internal/api/interpreter",
};
const codes = (env: Record<string, string | undefined>, role: "web" | "worker" | "migrate" = "web", level?: "error" | "warning") =>
  checkConfiguration(role, env).filter((i) => !level || i.level === level).map((i) => i.code);

describe("production preflight", () => {
  it("accepts a sound production configuration", () => {
    expect(codes(base, "web", "error")).toEqual([]);
    expect(codes(base, "worker", "error")).toEqual([]);
  });

  it("refuses synthetic seeding and development/test secrets", () => {
    expect(codes({ ...base, ORYN_ALLOW_SYNTHETIC_SEED: "true" }, "web", "error")).toContain("synthetic_seed_enabled");
    expect(codes({ ...base, ORYN_ALLOW_SYNTHETIC_SEED: "true" }, "migrate", "error")).toContain("synthetic_seed_enabled");
    expect(codes({ ...base, ORYN_DEV_SEED_PASSWORD: "x" }, "worker", "error")).toContain("dev_secret_present");
    expect(codes({ ...base, E2E_PASSWORD: "x" }, "web", "error")).toContain("dev_secret_present");
    expect(codes({ ...base, ORYN_PROVISION_PASSWORD: "x" }, "web", "warning")).toContain("one_off_secret_present");
  });

  it("refuses missing, short, placeholder, and known development auth secrets", () => {
    expect(codes({ ...base, BETTER_AUTH_SECRET: undefined }, "web", "error")).toContain("auth_secret_missing");
    expect(codes({ ...base, BETTER_AUTH_SECRET: "short" }, "web", "error")).toContain("auth_secret_short");
    expect(codes({ ...base, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789" }, "web", "error")).toContain("auth_secret_weak");
    expect(codes({ ...base, BETTER_AUTH_SECRET: "please-change-me-please-change-me-0000" }, "web", "error")).toContain("auth_secret_weak");
    expect(codes({ ...base, BETTER_AUTH_SECRET: "a".repeat(40) }, "web", "error")).toContain("auth_secret_weak");
    expect(codes({ ...base, ORYN_CRON_SECRET: "tiny" }, "web", "error")).toContain("cron_secret_weak");
  });

  it("requires an https, non-localhost auth URL", () => {
    expect(codes({ ...base, BETTER_AUTH_URL: "http://oryn.example.org" }, "web", "error")).toContain("auth_url_not_https");
    expect(codes({ ...base, BETTER_AUTH_URL: "https://localhost" }, "web", "error")).toContain("auth_url_localhost");
    expect(codes({ ...base, BETTER_AUTH_URL: undefined }, "web", "error")).toContain("auth_url_missing");
  });

  it("enforces the least-privilege database role and flags development passwords and missing TLS", () => {
    expect(codes({ ...base, DATABASE_OWNER_URL: "postgres://oryn_app:other-pass-123@db.internal/oryn" }, "web", "error")).toContain("db_same_role");
    expect(codes({ ...base, DATABASE_OWNER_URL: "postgres://oryn_owner:Hq81-zzx@db.internal/oryn" }, "worker", "warning")).toContain("owner_url_in_service");
    expect(codes({ ...base, DATABASE_URL: "postgres://oryn_app:oryn_app_dev_only@db.internal/oryn?sslmode=require" }, "web", "error")).toContain("db_dev_password");
    expect(codes({ ...base, DATABASE_URL: "postgres://oryn_app:Kx92-lmQp7Rt3vWz@db.internal/oryn" }, "web", "warning")).toContain("db_tls");
    expect(codes({ ...base, DATABASE_URL: undefined }, "worker", "error")).toContain("db_url_missing");
    expect(codes({ NODE_ENV: "production" }, "migrate", "error")).toContain("owner_url_missing");
  });

  it("checks DATABASE_CA_CERT: must be PEM, and is flagged when no URL verifies against it", () => {
    const pem = "-----BEGIN CERTIFICATE-----\\nMIIBfake\\n-----END CERTIFICATE-----";
    expect(codes({ ...base, DATABASE_CA_CERT: pem }, "web")).not.toContain("db_ca_invalid");
    expect(codes({ ...base, DATABASE_CA_CERT: pem }, "web")).not.toContain("db_ca_unused");
    expect(codes({ ...base, DATABASE_CA_CERT: "not-a-cert" }, "web", "error")).toContain("db_ca_invalid");
    const requireOnly = { ...base, DATABASE_URL: base.DATABASE_URL.replace("verify-full", "require"), DATABASE_CA_CERT: pem };
    expect(codes(requireOnly, "web", "warning")).toContain("db_ca_unused");
  });

  it("requires S3 object storage unless local storage is chosen deliberately", () => {
    expect(codes({ ...base, ORYN_STORAGE_DRIVER: "local" }, "worker", "error")).toContain("storage_local");
    expect(codes({ ...base, ORYN_STORAGE_DRIVER: "local", ORYN_ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true" }, "worker", "error")).toEqual([]);
    expect(codes({ ...base, ORYN_S3_BUCKET: undefined }, "web", "error")).toContain("s3_missing");
    expect(codes({ ...base, ORYN_S3_ENDPOINT: "http://minio.internal:9000" }, "web", "error")).toContain("s3_plain_http");
    expect(codes({ ...base, ORYN_S3_SSE: "none" }, "web", "warning")).toContain("s3_no_sse");
  });

  it("flags licensing and provider-etiquette conditions without blocking", () => {
    const w = codes({ ...base, OPEN_METEO_ALLOW_NONCOMMERCIAL: "true", OVERPASS_URL: undefined, NWS_USER_AGENT: "ORYN" }, "web", "warning");
    expect(w).toEqual(expect.arrayContaining(["licence_open_meteo", "overpass_public", "nws_user_agent"]));
    expect(codes({ ...base, OPEN_METEO_ALLOW_NONCOMMERCIAL: "true" }, "web", "error")).toEqual([]);
  });

  it("validates verified-integration attestations", () => {
    expect(codes({ ...base, ORYN_VERIFIED_INTEGRATIONS: "emial" }, "web", "error")).toContain("unknown_integration");
    expect(codes({ ...base, ORYN_VERIFIED_INTEGRATIONS: "email" }, "web", "warning")).toContain("verified_not_configured");
    expect(codes({ ...base, RESEND_API_KEY: "re_x", ORYN_EMAIL_FROM: "ops@example.org" }, "web", "warning")).toContain("integration_unverified");
  });

  it("allows a local rehearsal only against a localhost URL", () => {
    const rehearsal = { ...base, ORYN_LOCAL_REHEARSAL: "true", BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: "postgres://oryn_app:oryn_app_dev_only@db:5432/oryn", ORYN_S3_ENDPOINT: "http://s3:8333" };
    expect(rehearsalMode(rehearsal)).toBe(true);
    expect(codes(rehearsal, "web", "error")).toEqual([]);
    expect(codes({ ...rehearsal, ORYN_ALLOW_SYNTHETIC_SEED: "true" }, "web", "error")).toContain("synthetic_seed_enabled");
    const notLocal = { ...rehearsal, BETTER_AUTH_URL: "http://oryn.example.org" };
    expect(rehearsalMode(notLocal)).toBe(false);
    expect(codes(notLocal, "web", "error")).toEqual(expect.arrayContaining(["rehearsal_not_local", "auth_url_not_https", "db_dev_password"]));
  });

  it("serves a website-only deployment without platform configuration, and is permissive outside production", () => {
    expect(codes({ NODE_ENV: "production" }, "web", "error")).toEqual([]);
    expect(codes({ NODE_ENV: "production", NEXT_PUBLIC_PLATFORM_ENABLED: "true" }, "web", "error")).toContain("db_url_missing");
    expect(checkConfiguration("web", { NODE_ENV: "development", ORYN_ALLOW_SYNTHETIC_SEED: "true" })).toEqual([]);
  });

  it("never echoes secret values in findings", () => {
    const leaky = { ...base, BETTER_AUTH_SECRET: "short-secret-xyz", DATABASE_URL: "postgres://oryn_app:oryn_app_dev_only@db/oryn", ORYN_CRON_SECRET: "cron-123" };
    const text = JSON.stringify(checkConfiguration("web", leaky));
    for (const secret of ["short-secret-xyz", "oryn_app_dev_only", "cron-123", "s3-secret-value-xyz"]) expect(text).not.toContain(secret);
  });
});
