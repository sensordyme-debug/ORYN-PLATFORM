import { describe, expect, it } from "vitest";
import { RasterTooLargeError, UnsupportedCrsError } from "@/server/analytics/errors";
import {
  ellipsoidCellAreaM2,
  gridBounds,
  gridCornersLonLat,
  gridForBounds,
  nominalGsdM,
  pixelAreaM2,
  pixelCenter,
  sameGrid,
  type Grid,
} from "@/server/analytics/raster/grid";
import {
  isSupportedEpsg,
  projDefinition,
  projectMultiPolygon,
  transformPoint,
  unprojectMultiPolygon,
  utmEpsgForLonLat,
} from "@/server/analytics/raster/projection";

const TARBORO: [number, number] = [-77.5358, 35.8968];

describe("projection", () => {
  it("generates definitions for every WGS 84 / UTM zone and rejects others", () => {
    expect(projDefinition(32618)).toContain("+zone=18");
    expect(projDefinition(32733)).toContain("+south");
    for (let z = 1; z <= 60; z++) {
      expect(isSupportedEpsg(32600 + z)).toBe(true);
      expect(isSupportedEpsg(32700 + z)).toBe(true);
    }
    expect(isSupportedEpsg(32661)).toBe(false);
    expect(isSupportedEpsg(27700)).toBe(false);
    expect(() => transformPoint(4326, 27700, TARBORO)).toThrow(UnsupportedCrsError);
  });

  it("maps the central meridian / equator to the UTM false origin", () => {
    const [x, y] = transformPoint(4326, 32618, [-75, 0]);
    expect(x).toBeCloseTo(500_000, 6);
    expect(y).toBeCloseTo(0, 6);
    const [xs, ys] = transformPoint(4326, 32718, [-75, -0.000001]);
    expect(xs).toBeCloseTo(500_000, 3);
    expect(ys).toBeCloseTo(10_000_000, 0);
  });

  it("round-trips UTM ↔ lon/lat within 1 mm", () => {
    const cases: [number, number, number][] = [
      [32618, ...TARBORO],
      [32617, ...TARBORO], // out-of-zone (Sentinel-1 RTC tiles can use the neighbouring zone)
      [32733, 15.3, -12.7],
      [32660, 179.5, 70.1],
    ];
    for (const [epsg, lon, lat] of cases) {
      const xy = transformPoint(4326, epsg, [lon, lat]);
      const back = transformPoint(epsg, 4326, xy);
      const again = transformPoint(4326, epsg, back);
      expect(Math.hypot(again[0] - xy[0], again[1] - xy[1])).toBeLessThan(0.001);
      expect(Math.abs(back[0] - lon)).toBeLessThan(1e-8);
      expect(Math.abs(back[1] - lat)).toBeLessThan(1e-8);
    }
  });

  it("round-trips Web Mercator", () => {
    const xy = transformPoint(4326, 3857, TARBORO);
    const back = transformPoint(3857, 4326, xy);
    expect(back[0]).toBeCloseTo(TARBORO[0], 9);
    expect(back[1]).toBeCloseTo(TARBORO[1], 9);
  });

  it("picks UTM zones from lon/lat", () => {
    expect(utmEpsgForLonLat(...TARBORO)).toBe(32618);
    expect(utmEpsgForLonLat(15, -10)).toBe(32733);
    expect(utmEpsgForLonLat(-180, 10)).toBe(32601);
    expect(utmEpsgForLonLat(180, 10)).toBe(32660);
  });

  it("densifies long lon/lat edges before projecting and unprojects back", () => {
    const ring: [number, number][] = [
      [-77.6, 35.8],
      [-77.5, 35.8],
      [-77.5, 35.9],
      [-77.6, 35.9],
      [-77.6, 35.8],
    ];
    const projected = projectMultiPolygon([[ring]], 32618);
    expect(projected[0]![0]!.length).toBe(41); // 4 edges × 10 steps of 0.01° + closing vertex
    const back = unprojectMultiPolygon(projected, 32618)[0]![0]!;
    expect(back[0]![0]).toBeCloseTo(-77.6, 9);
    expect(back[back.length - 1]![1]).toBeCloseTo(35.8, 9);
    // 4326 is passed through untouched.
    expect(projectMultiPolygon([[ring]], 4326)[0]![0]).toEqual(ring);
  });
});

describe("grid", () => {
  const S2_ORIGIN: [number, number] = [199_980, 4_000_020];

  it("snaps bounds outward onto the source lattice", () => {
    const g = gridForBounds([200_003, 3_990_011, 200_027, 3_990_049], 10, S2_ORIGIN, 32618);
    expect(g.transform).toEqual([200_000, 10, 0, 3_990_050, 0, -10]);
    expect(g.width).toBe(3);
    expect(g.height).toBe(4);
    const [minX, minY, maxX, maxY] = gridBounds(g);
    expect([minX, minY, maxX, maxY]).toEqual([200_000, 3_990_010, 200_030, 3_990_050]);
    // Every analysis pixel edge lies on the 10 m lattice.
    expect((g.transform[0] - S2_ORIGIN[0]) % 10).toBe(0);
    expect((S2_ORIGIN[1] - g.transform[3]) % 10).toBe(0);
  });

  it("does not add a pixel when bounds sit exactly on lattice lines (incl. float noise)", () => {
    const g = gridForBounds([200_000, 3_990_000, 200_030 + 1e-10, 3_990_050], 10, S2_ORIGIN, 32618);
    expect(g.width).toBe(3);
    expect(g.height).toBe(5);
    const coarse = gridForBounds([200_000, 3_990_000, 200_030, 3_990_050], 20, S2_ORIGIN, 32618);
    expect(coarse.transform[0]).toBe(199_980 + 20);
    expect(coarse.width).toBe(2);
  });

  it("enforces the pixel budget", () => {
    expect(() => gridForBounds([0, 0, 100_000, 100_000], 10, [0, 0], 32618, { maxPixels: 1_000_000 })).toThrow(RasterTooLargeError);
  });

  it("returns pixel centres and lon/lat corners TL, TR, BR, BL", () => {
    const g = gridForBounds([500_000, 4_000_000, 501_000, 4_001_000], 10, [0, 0], 32618);
    expect(pixelCenter(g, 0, 0)).toEqual([500_005, 4_000_995]);
    const [tl, tr, br, bl] = gridCornersLonLat(g);
    expect(tl[1]).toBeGreaterThan(bl[1]);
    expect(tr[0]).toBeGreaterThan(tl[0]);
    expect(br[1]).toBeLessThan(tr[1]);
    expect(tl[0]).toBeCloseTo(-75, 6); // x = 500 000 is the central meridian
    expect(sameGrid(g, { ...g, transform: [...g.transform] })).toBe(true);
    expect(sameGrid(g, { ...g, width: g.width + 1 })).toBe(false);
  });

  it("uses constant pixel area for UTM grids", () => {
    const g: Grid = { width: 10, height: 10, epsg: 32618, transform: [0, 10, 0, 0, 0, -10] };
    expect(pixelAreaM2(g, 0)).toBe(100);
    expect(pixelAreaM2(g, 9)).toBe(100);
    expect(nominalGsdM(g)).toBe(10);
  });

  it("computes exact WGS 84 ellipsoid areas for EPSG:4326 rows", () => {
    // Summing 1° bands pole to pole over 360° gives the WGS 84 surface area (510 065 621.7 km²).
    let total = 0;
    for (let lat = -90; lat < 90; lat++) total += ellipsoidCellAreaM2(lat, lat + 1, 360);
    expect(total / 1e6).toBeCloseTo(510_065_621.7, 0);
    // Per-row areas shrink towards the pole, roughly with cos(latitude).
    const g: Grid = { width: 1, height: 2, epsg: 4326, transform: [10, 1 / 12000, 0, 60.0001, 0, -1 / 12000] };
    const equatorial: Grid = { ...g, transform: [10, 1 / 12000, 0, 0.0001, 0, -1 / 12000] };
    const ratio = pixelAreaM2(g, 0) / pixelAreaM2(equatorial, 0);
    expect(ratio).toBeGreaterThan(0.49);
    expect(ratio).toBeLessThan(0.51);
    expect(pixelAreaM2(g, 1)).toBeGreaterThan(pixelAreaM2(g, 0));
  });
});
