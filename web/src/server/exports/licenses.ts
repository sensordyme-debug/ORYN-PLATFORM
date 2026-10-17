/**
 * Licence and attribution notes for exported data.
 *
 * Notes are collected from the rows an export actually contains: the
 * licence / attribution recorded on each source asset, the weather
 * providers involved, AOI boundary sources, and reference layers. Where a
 * provider's terms require specific wording and the stored row lacks it,
 * the standard wording is added (Copernicus attribution, ODbL share-alike
 * for OpenStreetMap-derived data, CC BY 4.0 for ESA WorldCover and
 * Open-Meteo).
 */

export type LicenseAsset = {
  provider_id: string;
  collection: string;
  acquired_at: Date;
  license: string | null;
  license_url: string | null;
  attribution: string | null;
};

export type LicenseInputs = {
  assets?: LicenseAsset[];
  weatherProviders?: string[];
  boundarySources?: Record<string, unknown>[];
  referenceLayers?: { name: string; license: string | null; attribution: string | null; redistribution: string | null; provider?: string | null }[];
  derived?: boolean;
};

const OSM_ODBL =
  "Contains OpenStreetMap data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0). Databases derived from it must be shared under the same licence (share-alike).";

function weatherNote(provider: string): string | null {
  const p = provider.toLowerCase();
  if (p.includes("open-meteo")) return "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed under CC BY 4.0.";
  if (p.includes("nws") || p.includes("noaa") || p.includes("ghcn")) return "US National Weather Service / NOAA data: a work of the US Government, in the public domain.";
  if (p.includes("era5") || p.includes("copernicus") || p.includes("cds")) return "Contains modified Copernicus Climate Change Service information.";
  return null;
}

function assetDefault(a: LicenseAsset, years: string): string | null {
  const c = a.collection.toLowerCase();
  if (c.includes("worldcover")) return "© ESA WorldCover project / Contains modified Copernicus Sentinel data processed by the ESA WorldCover consortium. Licensed under CC BY 4.0.";
  if (c.includes("io-lulc")) return "Impact Observatory, Microsoft, and Esri annual land use / land cover. Licensed under CC BY 4.0.";
  if (c.includes("sentinel")) return `Contains modified Copernicus Sentinel data ${years}.`;
  if (c.includes("landsat")) return "Landsat imagery courtesy of the U.S. Geological Survey (public domain).";
  return null;
}

export function collectLicenseNotes(inputs: LicenseInputs): string[] {
  const notes: string[] = [];
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t && !notes.includes(t)) notes.push(t);
  };

  const byCollection = new Map<string, LicenseAsset[]>();
  for (const a of inputs.assets ?? []) byCollection.set(`${a.provider_id}|${a.collection}`, [...(byCollection.get(`${a.provider_id}|${a.collection}`) ?? []), a]);
  for (const [, group] of byCollection) {
    const a = group[0]!;
    const years = [...new Set(group.map((g) => g.acquired_at.getUTCFullYear()))].sort();
    const yearText = years.length > 1 ? `(${years[0]}–${years[years.length - 1]})` : `(${years[0]})`;
    const licence = a.license ? `${a.collection} (${a.provider_id}): licence ${a.license}${a.license_url ? ` — ${a.license_url}` : ""}.` : `${a.collection} (${a.provider_id}): licence not recorded in the catalog item.`;
    add(licence);
    if (a.attribution) add(a.attribution);
    else add(assetDefault(a, yearText));
    if (/sentinel/i.test(a.collection) && a.attribution && !/copernicus/i.test(a.attribution)) add(`Contains modified Copernicus Sentinel data ${yearText}.`);
  }

  for (const p of [...new Set(inputs.weatherProviders ?? [])].sort()) add(weatherNote(p) ?? `Weather data from ${p}; see the provider's terms.`);

  for (const b of inputs.boundarySources ?? []) {
    const text = JSON.stringify(b).toLowerCase();
    if (text.includes("openstreetmap") || text.includes("osm") || text.includes("odbl")) add(OSM_ODBL);
    else if (typeof b.license === "string") add(`AOI boundary source licence: ${b.license}.`);
  }

  for (const l of inputs.referenceLayers ?? []) {
    const text = `${l.license ?? ""} ${l.provider ?? ""} ${l.attribution ?? ""}`.toLowerCase();
    if (text.includes("openstreetmap") || text.includes("odbl") || text.includes("osm")) add(OSM_ODBL);
    else if (l.license) add(`${l.name}: ${l.license}${l.redistribution ? ` — ${l.redistribution}` : ""}.`);
    if (l.attribution) add(l.attribution);
  }

  if (inputs.derived) add("Derived values (indices, areas, candidate changes) were computed by ORYN from the sources above; they are not provider products.");
  return notes;
}
