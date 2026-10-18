/**
 * The geospatial engine behind the Intelligence globe: God's Eye View, which
 * lives at the root of this repository (ORYN-PLATFORM) and runs as its own
 * Node service. The ORYN app serves it same-origin under /engine/ (see
 * next.config.ts rewrites) so its document can be framed by the intel page
 * while keeping its own Content-Security-Policy, and so its public-data
 * proxies are reachable only behind an ORYN session (see src/proxy.ts).
 *
 * This file is isomorphic: it holds the contract both sides agree on.
 */

/** Where the engine document is served on the ORYN origin. */
export const ENGINE_BASE_PATH = "/engine/";

/** The engine document in ORYN host mode (index.html avoids trailing-slash redirects). */
export const ENGINE_DOCUMENT = `${ENGINE_BASE_PATH}index.html?host=oryn`;

/**
 * Engine API routes the ORYN origin forwards: only the public-data proxies of
 * layers ORYN offers, whose licences permit commercial display (see
 * src/ui/host/hostLicences.js and ORYN_LICENCE_REVIEW.md at the repository
 * root). Not forwarded: `setup` (writes the engine's .env); `openai` and
 * `realtime` (paid voice); `google`, `tomtom`, `mapillary` (keys, paid
 * services); `adsbdb` (route data may not be republished); `celestrak`,
 * `launches`, `fire-perimeters`, `terrain`, `geocode` (terms unpublished
 * or best-effort only); `gbfs`, `transit`, `radio`, `route`, `vessels`,
 * `gnss-integrity`, `local-receivers`, `overpass`, `regional-brief`,
 * `weather-effects` (withheld layers, or non-commercial sources such as
 * Google News and the free Open-Meteo API). None collides with an ORYN route.
 * src/proxy.ts repeats this list in its static matcher.
 */
export const ENGINE_API_PREFIXES = ["cctv", "cyclones", "firms", "flights", "military", "military-installations", "weather", "wind"] as const;

/**
 * Also forwarded with ORYN_ALL_LAYERS (local development, never production):
 * the routes of every withheld layer and of the engine's map, terrain and
 * place search. Still never forwarded: `setup` (writes the engine's .env),
 * `openai` and `realtime` (paid voice), `google` and `tomtom` (paid).
 */
export const ENGINE_DEV_API_PREFIXES = [
  "adsbdb",
  "celestrak",
  "fire-perimeters",
  "gbfs",
  "geocode",
  "gnss-integrity",
  "launches",
  "local-receivers",
  "mapillary",
  "overpass",
  "radio",
  "regional-brief",
  "route",
  "terrain",
  "transit",
  "vessels",
  "weather-effects",
] as const;

/** The engine routes this server forwards. */
export function engineApiPrefixes(allLayers: boolean): readonly string[] {
  return allLayers ? [...ENGINE_API_PREFIXES, ...ENGINE_DEV_API_PREFIXES] : ENGINE_API_PREFIXES;
}

/** ORYN_ALL_LAYERS outside production; read where src/server/config/env.ts cannot be imported (next.config.ts). */
export function allLayersFromEnv(e: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((e.ORYN_ALL_LAYERS ?? "").toLowerCase()) && e.NODE_ENV !== "production";
}

export type EngineFeedState = "current" | "fallback" | "loading" | "stale" | "partial" | "unavailable" | "off";

export type EngineChip = { id: string; label: string; active: boolean; state: string; title: string | null; disabled: boolean };
export type EngineRowControls = {
  chips: EngineChip[];
  legend: { label: string; color: string | null; count: number | null }[];
  items: { id: string; label: string; detail: string | null; active: boolean }[];
  info: string | null;
} | null;

export type EngineLayer = {
  id: string;
  name: string;
  icon: string | null;
  source: string | null;
  enabled: boolean;
  lifecycleState: string | null;
  state: EngineFeedState;
  count: number;
  lastUpdate: number | null;
  ageLabel: string | null;
  error: string | null;
  requiresKeyId: string | null;
  showInTogglePanel: boolean;
  controls: EngineRowControls;
  /** The host licence policy (src/ui/host/hostLicences.js); null outside host mode. */
  licence: EngineLicence | null;
};

export type EngineNature = "observed" | "forecast" | "computed" | "estimated" | "reference" | "simulated";
export type EngineLicenceSource = { name: string; licence: string; attribution: string; terms: string | null };
export type EngineLicence = {
  offered: boolean;
  nature: EngineNature | null;
  /** Why the layer is withheld (null when offered). */
  reason: string | null;
  note: string | null;
  sources: EngineLicenceSource[];
  /** Offered only by a development build (ORYN_ALL_LAYERS): not cleared for commercial use. */
  development?: boolean;
};

/** How each kind of engine data is labelled: never call a model or estimate an observation. */
export const NATURE_LABEL: Record<EngineNature, string> = {
  observed: "Provider-reported observation",
  forecast: "Model forecast",
  computed: "Derived product",
  estimated: "Observed, with estimated geometry",
  reference: "Reference map data",
  simulated: "Simulated, not data",
};

/** Where a statement came from: a data provider, or ORYN's own records. */
export type EngineProvenance = "provider" | "host";

export type EngineRef = {
  kind: string;
  id: string;
  label: string;
  layerId: string | null;
  position: { lat: number; lon: number; height?: number } | null;
  source: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
  retrievedAt: string | null;
  provenance: EngineProvenance;
  fields: Record<string, string | number | boolean>;
};

export type EngineEvent =
  | { type: "layers" }
  | { type: "overlays" }
  | { type: "selection"; ref: EngineRef | null }
  | { type: "status"; status: EngineStatus };

export type EngineStatus = { state: "starting" | "ready" | "failed"; error: string | null };

/** `window.__gevHost` inside the engine document (src/ui/host/hostBridge.js). */
export type EngineBridge = {
  version: number;
  host: string;
  status(): EngineStatus;
  listLayers(): EngineLayer[];
  setLayerEnabled(id: string, enabled: boolean): Promise<boolean>;
  clearLayers(): Promise<unknown>;
  applyRowControl(layerId: string, chipId: string): boolean;
  applyListItem(layerId: string, itemId: string): boolean;
  flyTo(options: { lat: number; lon: number; range?: number; pitch?: number; duration?: number }): boolean;
  setView(options: { lat: number; lon: number; height: number; heading?: number; pitch?: number; duration?: number }): boolean;
  resetView(): boolean;
  getCamera(): { lat: number; lon: number; alt: number; heading: number; pitch: number; roll: number } | null;
  search(query: string): Promise<{ found: boolean; label?: string; lat?: number | null; lon?: number | null }>;
  searchEntities(query: string, options?: { limit?: number }): EngineRef[];
  collectEvents(options?: { limit?: number }): EngineRef[];
  getSelection(): EngineRef | null;
  setOverlay(
    id: string,
    featureCollection: { type: "FeatureCollection"; features: unknown[] },
    options?: { kind?: string; source?: string; stroke?: string; fill?: string; strokeWidth?: number; show?: boolean },
  ): Promise<{ count: number }>;
  setOverlayVisible(id: string, visible: boolean): boolean;
  listOverlays(): { id: string; kind: string; source: string; count: number; visible: boolean; loadedAt: string }[];
  flyToOverlay(id: string): boolean;
  setExternalLayerPanel(external: boolean): boolean;
  subscribe(listener: (event: EngineEvent) => void): () => void;
};

/** Height (m) for a 2D map zoom, and back: the conversion the intel page already uses. */
export const heightForZoom = (zoom: number) => Math.round(35_000_000 / 2 ** zoom) + 2_000;
export const zoomForHeight = (heightM: number) => Math.max(1, Math.min(18, Math.log2(35_000_000 / Math.max(heightM, 50))));
