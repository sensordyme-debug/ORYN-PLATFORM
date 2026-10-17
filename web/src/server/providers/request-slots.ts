/**
 * Cross-process request spacing and cooldowns for rate-limited providers.
 *
 * The HTTP client's per-host limiter is in memory, so it cannot stop two
 * worker processes (or a worker and the web service's health probe) from
 * calling the same provider at once. Providers with strict published limits
 * (GDELT: one request every 5 seconds per client address) reserve slots here
 * instead, on the database clock:
 *
 *   await acquireProviderSlot("gdelt", 5_500, signal)   // waits for its turn
 *   await startProviderCooldown("gdelt", 600_000, "429") // after a rate limit
 *
 * A cooldown makes every process skip the provider (fail fast with a
 * retryable rate_limited error) until it ends, instead of making more
 * requests that extend the provider's penalty.
 */
import { withSystem } from "@/server/db/client";
import { ProviderError, sleep } from "@/server/providers/http";

/** Longest wait for a slot before giving up (the job is retried later). */
const MAX_SLOT_WAIT_MS = 60_000;

/** Remaining cooldown in ms (0 when none). */
export async function providerCooldownRemaining(providerId: string): Promise<{ ms: number; reason: string | null }> {
  return withSystem("provider.slots", async (tx) => {
    const [r] = await tx<{ ms: number; reason: string | null }[]>`
      select greatest(0, extract(epoch from (cooldown_until - now())) * 1000)::float8 as ms, cooldown_reason as reason
        from provider_request_slots where provider_id = ${providerId}`;
    return { ms: Math.round(r?.ms ?? 0), reason: r?.reason ?? null };
  });
}

/**
 * Reserve the next request slot for a provider and wait until it arrives.
 * Throws a retryable rate_limited ProviderError while a cooldown is active,
 * or if the queue of reserved slots is longer than MAX_SLOT_WAIT_MS.
 */
export async function acquireProviderSlot(providerId: string, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
  const r = await withSystem("provider.slots", async (tx) => {
    const [row] = await tx<{ wait_ms: number; cooldown_ms: number; reason: string | null }[]>`
      with cur as (
        insert into provider_request_slots (provider_id) values (${providerId})
        on conflict (provider_id) do update set provider_id = excluded.provider_id
        returning next_at, cooldown_until, cooldown_reason
      )
      select greatest(0, extract(epoch from (greatest(cur.next_at, now()) - now())) * 1000)::float8 as wait_ms,
             greatest(0, extract(epoch from (coalesce(cur.cooldown_until, now()) - now())) * 1000)::float8 as cooldown_ms,
             cur.cooldown_reason as reason
        from cur`;
    const cooldownMs = Math.round(row!.cooldown_ms);
    const waitMs = Math.round(row!.wait_ms);
    if (cooldownMs > 0 || waitMs > MAX_SLOT_WAIT_MS) return { cooldownMs, waitMs, reason: row!.reason, reserved: false };
    // Reserve: the next caller may go no earlier than this slot + interval.
    await tx`
      update provider_request_slots
         set next_at = greatest(next_at, now()) + make_interval(secs => ${minIntervalMs / 1000}), updated_at = now()
       where provider_id = ${providerId}`;
    return { cooldownMs, waitMs, reason: row!.reason, reserved: true };
  });
  if (!r.reserved) {
    const retryAfterMs = Math.max(r.cooldownMs, r.waitMs, minIntervalMs);
    throw new ProviderError(
      providerId,
      "rate_limited",
      r.cooldownMs > 0
        ? `${providerId} is cooling down after a rate limit${r.reason ? ` (${r.reason})` : ""}; not calling it for ${Math.ceil(r.cooldownMs / 1000)} s`
        : `${providerId} request queue is full; retry later`,
      { retryable: true, retryAfterMs },
    );
  }
  if (r.waitMs > 0) await sleep(r.waitMs, signal);
}

/** Stop every process from calling a provider until the cooldown ends (never shortens an existing one). */
export async function startProviderCooldown(providerId: string, ms: number, reason: string): Promise<void> {
  await withSystem("provider.slots", (tx) => tx`
    insert into provider_request_slots (provider_id, cooldown_until, cooldown_reason)
    values (${providerId}, now() + make_interval(secs => ${ms / 1000}), ${reason.slice(0, 200)})
    on conflict (provider_id) do update set
      cooldown_until = greatest(coalesce(provider_request_slots.cooldown_until, now()), excluded.cooldown_until),
      cooldown_reason = excluded.cooldown_reason, updated_at = now()`);
}
