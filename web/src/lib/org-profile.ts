/**
 * Words and starting choices that depend on the kind of organization, in one
 * place so the navigation, page titles and forms agree for every kind.
 * Pure data — safe for client components.
 */

export const ORG_KINDS = ["agriculture", "municipal", "infrastructure", "enterprise", "public_sector"] as const;
export type OrgKindName = (typeof ORG_KINDS)[number];

export type OrgProfile = {
  /** Eyebrow on the overview page. */
  workspace: string;
  /** Navigation label for the overview. */
  overview: string;
  /** Navigation label and page title for the areas list. */
  areas: string;
  /** Overview statistic for the number of areas. */
  areasStat: string;
  /** Navigation label and page title for candidate changes awaiting review. */
  review: string;
  /** Shown when the areas list is empty. */
  areasEmpty: string;
  /** Description of the GeoJSON upload panel. */
  uploadHint: string;
  /** AOI kind preselected for uploads and drawings. */
  defaultAoiKind: "field" | "region";
  /** Per-field vegetation health on the overview (agriculture only). */
  fieldHealth: boolean;
};

const PUBLIC_BODY = {
  areas: "Areas of interest",
  areasStat: "Areas of interest",
  review: "Inspection queue",
  areasEmpty: "Import a boundary from the U.S. Census, upload GeoJSON, or draw areas on the map.",
  uploadHint: "Boundaries, project areas, or permit polygons from your GIS.",
  defaultAoiKind: "region",
  fieldHealth: false,
} as const;

const PROFILES: Record<OrgKindName, OrgProfile> = {
  agriculture: {
    workspace: "Agricultural workspace",
    overview: "Farm overview",
    areas: "Fields & farms",
    areasStat: "Monitored areas",
    review: "Change review",
    areasEmpty: "Add field boundaries by drawing them, uploading GeoJSON, or importing them.",
    uploadHint: "Field boundaries exported from your farm-management or GIS software.",
    defaultAoiKind: "field",
    fieldHealth: true,
  },
  municipal: {
    ...PUBLIC_BODY,
    workspace: "Municipal workspace",
    overview: "Municipal overview",
    areasEmpty: "Import your municipal boundary from the U.S. Census, upload GeoJSON, or draw areas on the map.",
  },
  public_sector: { ...PUBLIC_BODY, workspace: "Public-sector workspace", overview: "Overview" },
  infrastructure: {
    ...PUBLIC_BODY,
    workspace: "Infrastructure workspace",
    overview: "Overview",
    uploadHint: "Asset, corridor, or project boundaries from your GIS.",
  },
  enterprise: {
    workspace: "Workspace",
    overview: "Overview",
    areas: "Sites & areas",
    areasStat: "Monitored sites and areas",
    review: "Change review",
    areasEmpty: "Upload site or parcel boundaries as GeoJSON, import a public boundary, or draw areas on the map.",
    uploadHint: "Site, parcel, or project boundaries from your GIS.",
    defaultAoiKind: "region",
    fieldHealth: false,
  },
};

/** The profile for an organization kind; unknown kinds get the enterprise wording. */
export function orgProfile(kind: string): OrgProfile {
  return PROFILES[kind as OrgKindName] ?? PROFILES.enterprise;
}
