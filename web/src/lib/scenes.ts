/**
 * Saved map scenes — the shape of a saved view of the map workspace, shared
 * by the API (validation) and the map UI (save / restore), and the built-in
 * presets. Pure data; safe for client components.
 *
 * A scene is view state only. Restoring it re-fetches every record through
 * the normal permission-checked APIs; it never carries data or grants access.
 */
import { z } from "zod";
import { PUBLIC_EVENT_LAYER_IDS } from "@/lib/public-events";

const layerId = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const SCENE_IMAGERY_KINDS = ["ndvi", "ndmi", "ndwi", "s1_water", "landcover"] as const;
export const SCENE_DETECTION_GRADES = ["", "weak", "moderate", "strong"] as const;
export const SCENE_VERIFICATION = ["unverified", "needs_field_check", "confirmed", "dismissed"] as const;

export const sceneStateSchema = z.strictObject({
  view: z.strictObject({
    center: z.tuple([z.number().min(-180).max(180), z.number().min(-85.06).max(85.06)]),
    zoom: z.number().min(0).max(22),
    bearing: z.number().min(-180).max(180).default(0),
    pitch: z.number().min(0).max(85).default(0),
  }),
  projection: z.enum(["mercator", "globe"]).default("mercator"),
  basemap: layerId.nullable().default(null),
  overlays: z.array(layerId).max(12).default([]),
  showAois: z.boolean().default(true),
  showDetections: z.boolean().default(true),
  /** Public event layers shown (USGS earthquakes, NIFC wildfire perimeters) and the earthquake look-back. */
  publicEvents: z.array(z.enum(PUBLIC_EVENT_LAYER_IDS)).max(PUBLIC_EVENT_LAYER_IDS.length).default([]),
  eventDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
  /** Selected area (re-checked against the viewer's access on restore). */
  aoiId: z.uuid().nullable().default(null),
  /**
   * Displayed image: the selected area's observation of this kind acquired at
   * this instant (two passes can fall on the same UTC day). Restored only from
   * the area's own permission-checked observation list.
   */
  imagery: z
    .strictObject({ kind: z.enum(SCENE_IMAGERY_KINDS), observedAt: z.iso.datetime({ offset: true }), layer: z.enum(["index", "true_color"]).default("index") })
    .nullable()
    .default(null),
  chartIndex: z.enum(["ndvi", "ndmi"]).default("ndvi"),
  changes: z
    .strictObject({
      verification: z.array(z.enum(SCENE_VERIFICATION)).max(4),
      minGrade: z.enum(SCENE_DETECTION_GRADES),
      types: z.array(z.string().regex(/^[a-z_]{1,64}$/)).max(12),
      /** 0 = all time. */
      days: z.number().int().min(0).max(3650),
    })
    .nullable()
    .default(null),
});
export type SceneState = z.infer<typeof sceneStateSchema>;
export type SceneStateInput = z.input<typeof sceneStateSchema>;

export const sceneInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Give the scene a name.").max(120),
  description: z.string().trim().max(1000).default(""),
  visibility: z.enum(["private", "org"]).default("org"),
  state: sceneStateSchema,
});
export type SceneInput = z.input<typeof sceneInputSchema>;

/**
 * Built-in presets: changes applied on top of the current view. Each only
 * switches functionality that exists — it never moves the map to a place or
 * implies data the organization does not have.
 */
export type ScenePreset = {
  id: string;
  label: string;
  description: string;
  /** Needs a selected area to have any effect. */
  needsArea?: boolean;
  apply: Partial<Pick<SceneState, "basemap" | "overlays" | "showAois" | "showDetections" | "chartIndex" | "changes">> & { latestImagery?: boolean };
};

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: "agriculture-overview",
    label: "Agriculture overview",
    description: "Imagery basemap with areas and findings at moderate or strong evidence from the last year.",
    apply: {
      basemap: "usgs-imagery",
      overlays: [],
      showAois: true,
      showDetections: true,
      changes: { verification: ["unverified", "needs_field_check", "confirmed"], minGrade: "moderate", types: [], days: 365 },
    },
  },
  {
    id: "vegetation-anomalies",
    label: "Vegetation anomalies",
    description: "Only low-vigour zones and vegetation-decline candidates, moderate evidence or stronger.",
    apply: {
      showDetections: true,
      changes: { verification: ["unverified", "needs_field_check", "confirmed"], minGrade: "moderate", types: ["low_vigor_zone", "vegetation_decline"], days: 365 },
    },
  },
  {
    id: "moisture-index",
    label: "Canopy moisture (NDMI)",
    description: "The selected area's trend chart on NDMI — canopy water content, not soil moisture.",
    needsArea: true,
    apply: { chartIndex: "ndmi" },
  },
  {
    id: "latest-acquisition",
    label: "Latest usable image",
    description: "Shows the selected area's most recent usable satellite image (NDVI where available), with its acquisition date.",
    needsArea: true,
    apply: { latestImagery: true },
  },
  {
    id: "flood-context",
    label: "Flood-hazard context",
    description: "FEMA flood-hazard zones (regulatory, not observed flooding) and USGS mapped hydrography over imagery.",
    apply: { basemap: "usgs-imagery", overlays: ["fema-nfhl-flood-zones", "usgs-hydro"] },
  },
];
