/**
 * Runtime provider health, recorded by syncs and periodic probes. Shown on
 * the Data sources page. Credentials are never stored here.
 */
import { jsonb, withSystem } from "@/server/db/client";
import { redactString } from "@/server/log";

export async function recordProviderSuccess(providerId: string, details: Record<string, unknown> = {}) {
  await withSystem("provider.status", (tx) => tx`
    insert into provider_status (provider_id, status, last_success_at, consecutive_failures, request_count_24h, details, updated_at)
    values (${providerId}, 'healthy', now(), 0, 1, ${jsonb(details)}::jsonb, now())
    on conflict (provider_id) do update set
      status = 'healthy', last_success_at = now(), consecutive_failures = 0,
      request_count_24h = case when provider_status.updated_at < now() - interval '24 hours' then 1 else provider_status.request_count_24h + 1 end,
      details = provider_status.details || excluded.details, updated_at = now()`);
}

export async function recordProviderFailure(providerId: string, error: unknown, state: "degraded" | "unavailable" | "unconfigured" | "disabled" = "degraded") {
  const message = redactString(error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await withSystem("provider.status", (tx) => tx`
    insert into provider_status (provider_id, status, last_error_at, last_error, consecutive_failures, request_count_24h, updated_at)
    values (${providerId}, ${state}, now(), ${message}, 1, 1, now())
    on conflict (provider_id) do update set
      status = case when provider_status.consecutive_failures + 1 >= 3 and ${state} = 'degraded' then 'unavailable' else ${state} end,
      last_error_at = now(), last_error = ${message}, consecutive_failures = provider_status.consecutive_failures + 1,
      request_count_24h = case when provider_status.updated_at < now() - interval '24 hours' then 1 else provider_status.request_count_24h + 1 end,
      updated_at = now()`);
}
