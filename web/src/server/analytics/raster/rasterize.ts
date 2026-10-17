/**
 * Polygon → pixel mask on an analysis grid.
 *
 * Rule: a pixel belongs to the polygon when its CENTRE lies inside, using the
 * even-odd rule per polygon (so holes are excluded); the polygons of a
 * MultiPolygon are OR-ed. Centres exactly on an edge follow a half-open
 * convention (left/bottom edges inclusive, right/top exclusive in scan
 * order), so two polygons sharing an edge never both claim a pixel.
 *
 * Algorithm: scanline fill. Each edge is visited once and contributes one
 * crossing per pixel-centre row it spans; crossings are sorted per row and
 * the spans between pairs are filled. Cost is O(edges + crossings + filled
 * pixels) — no per-pixel point-in-polygon tests.
 */
import type { Ring } from "@/lib/geo";
import type { Grid } from "./grid";

/**
 * Rasterize MultiPolygon coordinates already in the grid's CRS.
 * Returns 1 for pixels whose centre is inside, 0 otherwise.
 */
export function rasterizeMultiPolygon(coords: Ring[][], grid: Grid): Uint8Array {
  const out = new Uint8Array(grid.width * grid.height);
  for (const polygon of coords) fillPolygon(polygon, grid, out);
  return out;
}

export function countInside(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i]!;
  return n;
}

function fillPolygon(rings: Ring[], grid: Grid, out: Uint8Array): void {
  const { width, height } = grid;
  const [ox, pw, , oy, , nph] = grid.transform;
  const ph = -nph;
  const crossings: number[][] = Array.from({ length: height }, () => []);

  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      if (a[1] === b[1]) continue; // horizontal edges never cross a centre line
      const [lo, hi] = a[1] < b[1] ? [a, b] : [b, a];
      // Rows whose centre y satisfies lo.y ≤ y < hi.y (half-open avoids double-counting shared vertices).
      const rFirst = Math.max(0, Math.floor((oy - hi[1]) / ph - 0.5) - 1);
      const rLast = Math.min(height - 1, Math.ceil((oy - lo[1]) / ph - 0.5) + 1);
      const slope = (hi[0] - lo[0]) / (hi[1] - lo[1]);
      for (let r = rFirst; r <= rLast; r++) {
        const yc = oy - (r + 0.5) * ph;
        if (yc < lo[1] || yc >= hi[1]) continue;
        crossings[r]!.push(lo[0] + (yc - lo[1]) * slope);
      }
    }
  }

  for (let r = 0; r < height; r++) {
    const xs = crossings[r]!;
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const rowStart = r * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Columns whose centre x satisfies xa ≤ x < xb.
      const c0 = Math.max(0, Math.ceil((xs[k]! - ox) / pw - 0.5));
      const c1 = Math.min(width - 1, Math.ceil((xs[k + 1]! - ox) / pw - 0.5) - 1);
      for (let c = c0; c <= c1; c++) out[rowStart + c] = 1;
    }
  }
}
