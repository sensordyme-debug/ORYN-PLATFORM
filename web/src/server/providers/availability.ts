import { PROVIDERS, providerAvailability } from "@/server/providers/registry";

/** Availability of every registered provider, keyed by provider id (no secrets). */
export async function providerAvailabilityMap(): Promise<Record<string, { state: string; reason?: string }>> {
  const out: Record<string, { state: string; reason?: string }> = {};
  for (const p of PROVIDERS) {
    const a = providerAvailability(p.id);
    out[p.id] = a.state === "available" ? { state: "available" } : { state: a.state, reason: a.reason };
  }
  return out;
}
