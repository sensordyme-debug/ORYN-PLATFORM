/**
 * Optional integrations whose live behaviour has not been verified.
 *
 * The integration audit found these had never worked end to end against the
 * real service from a deployed ORYN (no credentials, or — GDELT — refused by
 * the provider). Having an adapter and passing mocked tests is not evidence
 * that they work, so in production each stays OFF until an operator has
 * verified it in that deployment:
 *
 *   1. configure its credentials,
 *   2. run `npm run oryn:verify -- <id>` (a single, minimal live call),
 *   3. add the id to ORYN_VERIFIED_INTEGRATIONS (comma-separated).
 *
 * Outside production they follow their normal configuration so they can be
 * developed and tested. Data sources and settings pages show the reason
 * whenever one is off.
 *
 * Not gated here: integrations verified live during the audit (Earth Search,
 * Planetary Computer, NWS, Open-Meteo, TIGERweb, Census geocoder, Overpass,
 * basemaps) and Copernicus downloads, which cannot be enabled at all (ORYN
 * cannot read their JPEG 2000 products).
 */
import { env, isProduction } from "@/server/config/env";

export const GATED_INTEGRATIONS = {
  email: { label: "Email delivery (Resend)", verify: "npm run oryn:verify -- email --to <an address you control>" },
  gdelt: { label: "GDELT news search", verify: "npm run oryn:verify -- gdelt" },
  "nasa-hls": { label: "NASA HLS image reads (Earthdata)", verify: "npm run oryn:verify -- nasa-hls" },
  "ai-summaries": { label: "AI report summaries (Anthropic)", verify: "npm run oryn:verify -- ai-summaries" },
  // Keyless public feeds added after the audit: verified from a developer machine, not yet from a deployment.
  "usgs-earthquakes": { label: "USGS earthquake layer", verify: "npm run oryn:verify -- usgs-earthquakes" },
  "nifc-wildfire-perimeters": { label: "NIFC wildfire perimeter layer", verify: "npm run oryn:verify -- nifc-wildfire-perimeters" },
  celestrak: { label: "Imaging-satellite tracks (CelesTrak orbital elements)", verify: "npm run oryn:verify -- celestrak" },
  "caltrans-cctv": { label: "Caltrans traffic cameras", verify: "npm run oryn:verify -- caltrans-cctv" },
} as const;

export type GatedIntegration = keyof typeof GATED_INTEGRATIONS;

/**
 * Integrations whose provider publishes no terms that permit commercial
 * display (licence review 2026-10-17, ORYN_LICENCE_REVIEW.md at the
 * repository root). Unlike the verification gate, this one applies in EVERY
 * environment: each stays off until an operator who has obtained or confirmed
 * a licence lists its id in ORYN_LICENCE_CLEARED_INTEGRATIONS.
 */
export const LICENCE_WITHHELD: Partial<Record<GatedIntegration, string>> = {
  "nifc-wildfire-perimeters":
    "NIFC publishes no licence or public-domain statement for the WFIGS perimeters (only a disclaimer), and state agencies contribute to them.",
  celestrak: "CelesTrak publishes no terms for reusing its orbital elements, which originate from Space-Track.",
  "caltrans-cctv": "Caltrans' conditions of use do not clearly cover reuse of its camera images (photographs may require additional permissions).",
};

export const GATED_INTEGRATION_IDS = Object.keys(GATED_INTEGRATIONS) as GatedIntegration[];

export type IntegrationGate = { enabled: true } | { enabled: false; reason: string };

export type IntegrationGateConfig = { production?: boolean; verified?: string[]; licenceCleared?: readonly string[]; allLayers?: boolean };

export function integrationGate(id: GatedIntegration, cfg: IntegrationGateConfig = {}): IntegrationGate {
  const withheld = LICENCE_WITHHELD[id];
  // ORYN_ALL_LAYERS (local development only) treats every withheld source as cleared.
  const cleared = (cfg.allLayers ?? env.allLayers()) || (cfg.licenceCleared ?? env.licenceClearedIntegrations()).includes(id);
  if (withheld && !cleared) {
    return {
      enabled: false,
      reason: `${GATED_INTEGRATIONS[id].label} is off: ${withheld} Once a licence is confirmed, add "${id}" to ORYN_LICENCE_CLEARED_INTEGRATIONS.`,
    };
  }
  const production = cfg.production ?? isProduction();
  if (!production) return { enabled: true };
  const verified = cfg.verified ?? env.verifiedIntegrations();
  if (verified.includes(id)) return { enabled: true };
  const g = GATED_INTEGRATIONS[id];
  return {
    enabled: false,
    reason: `${g.label} is off: it has not been verified in this deployment. Configure it, run \`${g.verify}\`, then add "${id}" to ORYN_VERIFIED_INTEGRATIONS.`,
  };
}

export const integrationEnabled = (id: GatedIntegration) => integrationGate(id).enabled;
