/**
 * Import official public boundaries (U.S. Census TIGERweb) as AOIs. The
 * boundary is fetched server-side and stored with its provenance: provider,
 * GEOID, layer, vintage, retrieval time, and licence.
 */
import { z } from "zod";
import type { AoiKind } from "@/lib/aoi-config";
import { createAoi, type AoiDetail } from "@/server/aois/service";
import type { OrgAccess } from "@/server/authz/access";
import { DomainError } from "@/server/errors";
import { isProviderError } from "@/server/providers/http";
import { getCountyBoundary, getPlaceBoundary, searchCounties, searchPlaces, type CensusGeography } from "@/server/providers/reference/tigerweb";

export const boundarySearchSchema = z.object({
  name: z.string().trim().min(2).max(100),
  stateFips: z.string().regex(/^\d{2}$/).optional(),
  level: z.enum(["place", "county"]).default("place"),
});

export async function searchCensusBoundaries(access: OrgAccess, raw: z.input<typeof boundarySearchSchema>): Promise<CensusGeography[]> {
  access.assert("aoi.write");
  const q = boundarySearchSchema.parse(raw);
  try {
    return q.level === "county" ? await searchCounties(q.name, q.stateFips) : await searchPlaces(q.name, q.stateFips);
  } catch (err) {
    if (isProviderError(err)) throw new DomainError("provider_unavailable", `The Census boundary service could not be reached (${err.message}). Try again later.`, 503);
    throw err;
  }
}

export async function importCensusBoundary(
  access: OrgAccess,
  input: { geoid: string; level: "place" | "county"; name: string; kind: AoiKind; newsTerms?: string[] },
): Promise<AoiDetail> {
  access.assert("aoi.write");
  const geoid = z.string().regex(input.level === "county" ? /^\d{5}$/ : /^\d{7}$/).parse(input.geoid);
  let b;
  try {
    b = input.level === "county" ? await getCountyBoundary(geoid) : await getPlaceBoundary(geoid);
  } catch (err) {
    if (isProviderError(err)) throw new DomainError("provider_unavailable", `The boundary could not be retrieved from the Census service (${err.message}).`, 503);
    throw err;
  }
  return createAoi(
    access,
    {
      name: input.name,
      kind: input.kind,
      geometry: b.geometry,
      newsTerms: input.newsTerms ?? [],
      metadata: { census_geoid: geoid, census_layer: b.provenance.layer, census_vintage: b.provenance.vintage },
    },
    {
      boundarySource: {
        method: "imported",
        provider: "U.S. Census Bureau TIGERweb",
        external_id: geoid,
        retrieved_at: b.provenance.retrieved_at,
        license: b.provenance.license,
        note: `${b.provenance.layer}${b.provenance.vintage ? `, ${b.provenance.vintage}` : ""}`,
      },
    },
  );
}
