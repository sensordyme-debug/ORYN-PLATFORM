import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORG_KINDS, orgProfile } from "@/lib/org-profile";

const page = (rel: string) => readFileSync(new URL(`../../src/app/(platform)/app/[org]/${rel}`, import.meta.url), "utf8");

describe("organization vocabulary", () => {
  it("names every part of the workspace for every kind", () => {
    for (const kind of ORG_KINDS) {
      const p = orgProfile(kind);
      for (const [key, value] of Object.entries(p)) if (typeof value === "string") expect(value.trim(), `${kind}.${key}`).not.toBe("");
    }
  });

  it("keeps the established agriculture and municipal wording", () => {
    expect(orgProfile("agriculture")).toMatchObject({ overview: "Farm overview", areas: "Fields & farms", review: "Change review", defaultAoiKind: "field", fieldHealth: true });
    expect(orgProfile("municipal")).toMatchObject({ overview: "Municipal overview", areas: "Areas of interest", review: "Inspection queue", defaultAoiKind: "region", fieldHealth: false });
  });

  it("gives businesses one name for their review queue (it used to differ between the navigation and the page)", () => {
    expect(orgProfile("enterprise").review).toBe("Change review");
    expect(orgProfile("enterprise").areas).toBe("Sites & areas");
    expect(orgProfile("public_sector").overview).not.toMatch(/Municipal/);
    expect(orgProfile("unknown-kind")).toEqual(orgProfile("enterprise"));
  });

  it("is the only source of these labels in the workspace pages", () => {
    // The navigation and page titles used to branch on org kind separately.
    for (const rel of ["layout.tsx", "page.tsx", "areas/page.tsx", "areas/new/page.tsx", "detections/page.tsx"]) {
      const src = page(rel);
      expect(src, rel).toMatch(/orgProfile\(access\.org\.kind\)/);
      expect(src, rel).not.toMatch(/org\.kind (===|!==) "(agriculture|municipal|public_sector|infrastructure|enterprise)"/);
    }
  });
});
