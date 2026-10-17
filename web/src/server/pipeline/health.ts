/** provider.health_check — cheap probes of every registered provider; results drive the Data sources page. */
import type { JobContext } from "@/server/jobs/worker";
import { GDELT_ID, GDELT_MIN_INTERVAL_MS, GDELT_RATE_LIMIT_COOLDOWN_MS } from "@/server/providers/news/gdelt";
import { checkProviderHealth, PROVIDERS, providerAvailability } from "@/server/providers/registry";
import { acquireProviderSlot, providerCooldownRemaining, startProviderCooldown } from "@/server/providers/request-slots";
import { recordProviderFailure, recordProviderSuccess } from "@/server/providers/status";

/**
 * Providers with strict per-client limits share the cross-process request
 * slots with ingestion jobs, and are not probed at all while cooling down
 * after a rate limit (a probe would only extend the penalty).
 */
const SLOTTED: Record<string, { intervalMs: number; cooldownMs: number }> = {
  [GDELT_ID]: { intervalMs: GDELT_MIN_INTERVAL_MS, cooldownMs: GDELT_RATE_LIMIT_COOLDOWN_MS },
};

export async function providerHealthHandler(ctx: JobContext): Promise<unknown> {
  const out: Record<string, string> = {};
  for (const p of PROVIDERS) {
    ctx.checkpoint();
    const av = providerAvailability(p.id);
    if (av.state !== "available") {
      out[p.id] = av.state;
      await recordProviderFailure(p.id, new Error(av.reason), av.state);
      continue;
    }
    const slotted = SLOTTED[p.id];
    try {
      if (slotted) {
        const cooldown = await providerCooldownRemaining(p.id);
        if (cooldown.ms > 0) {
          out[p.id] = `not probed: cooling down after a rate limit (${Math.ceil(cooldown.ms / 1000)} s left)`;
          await recordProviderFailure(p.id, new Error(`Rate limited${cooldown.reason ? ` (${cooldown.reason})` : ""}; cooling down`), "degraded");
          continue;
        }
        await acquireProviderSlot(p.id, slotted.intervalMs, ctx.signal);
      }
      const h = await checkProviderHealth(p.id, ctx.signal);
      out[p.id] = h.ok ? `ok ${h.latencyMs} ms` : `failed: ${h.message ?? ""}`;
      if (h.ok) await recordProviderSuccess(p.id, { last_probe_ms: h.latencyMs });
      else {
        if (slotted && /rate limit|429/i.test(h.message ?? "")) await startProviderCooldown(p.id, slotted.cooldownMs, "health probe rate-limited");
        await recordProviderFailure(p.id, new Error(h.message ?? "Probe failed"));
      }
    } catch (err) {
      out[p.id] = `error: ${err instanceof Error ? err.message : String(err)}`;
      await recordProviderFailure(p.id, err);
    }
  }
  return out;
}
