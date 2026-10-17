/**
 * Exact raster → polygon conversion along pixel edges.
 *
 * Boundary edges are generated per foreground pixel side that faces
 * background, directed so the foreground lies to the LEFT (map coordinates,
 * y north). Linking them gives exterior rings counter-clockwise and holes
 * clockwise — the RFC 7946 orientation, preserved by unprojection to lon/lat
 * because both systems are east/north handed.
 *
 * Saddle vertices (two foreground pixels touching only at a corner) are
 * resolved by turning RIGHT, i.e. joining the diagonal at that single point.
 * For a 4-connected component this yields exactly one simple exterior ring
 * and simple holes that may touch the exterior or each other at a single
 * vertex — valid OGC polygons, never self-intersecting rings. Diagonal
 * neighbours from OTHER components are never joined, because each component
 * is traced on its own.
 *
 * Collinear vertices are removed (vertices are emitted only where the
 * direction changes); every ring is closed (first = last position).
 */
import type { MultiPolygonGeometry, Position, Ring } from "@/lib/geo";
import type { Grid } from "./raster/grid";
import { unprojectMultiPolygon } from "./raster/projection";

/** Inclusive pixel bounding box. */
export type PixelBBox = { minCol: number; minRow: number; maxCol: number; maxRow: number };

// Directions in map orientation: 0 = east, 1 = north, 2 = west, 3 = south.
const DX = [1, 0, -1, 0] as const;
const DY_RASTER = [0, -1, 0, 1] as const;

/** Shoelace signed area; positive for counter-clockwise rings (y up). */
export function ringSignedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function pointInRing(p: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Trace a binary mask (local, bw × bh, row-major) into rings in local vertex
 * coordinates converted to map orientation: x = column edge, y = −row edge.
 */
function traceRings(mask: Uint8Array, bw: number, bh: number): Ring[] {
  const vw = bw + 1;
  const out = new Uint8Array(vw * (bh + 1));
  const used = new Uint8Array(out.length);
  const fg = (c: number, r: number) => c >= 0 && r >= 0 && c < bw && r < bh && mask[r * bw + c] === 1;
  const emit = (vertex: number, dir: number) => {
    out[vertex] = out[vertex]! | (1 << dir);
  };
  for (let r = 0; r < bh; r++) {
    for (let c = 0; c < bw; c++) {
      if (!fg(c, r)) continue;
      if (!fg(c, r + 1)) emit((r + 1) * vw + c, 0); // bottom: BL → BR (east)
      if (!fg(c + 1, r)) emit((r + 1) * vw + c + 1, 1); // right: BR → TR (north)
      if (!fg(c, r - 1)) emit(r * vw + c + 1, 2); // top: TR → TL (west)
      if (!fg(c - 1, r)) emit(r * vw + c, 3); // left: TL → BL (south)
    }
  }

  const rings: Ring[] = [];
  for (let start = 0; start < out.length; start++) {
    while (out[start]! & ~used[start]!) {
      const free = out[start]! & ~used[start]!;
      const d0 = free & 1 ? 0 : free & 2 ? 1 : free & 4 ? 2 : 3;
      const ring: Ring = [];
      let v = start;
      let d = d0;
      let prev = -1;
      for (let guard = 0; guard <= out.length * 4; guard++) {
        used[v] = used[v]! | (1 << d);
        if (d !== prev) ring.push([v % vw, -Math.floor(v / vw)]);
        prev = d;
        v += DX[d]! + DY_RASTER[d]! * vw;
        const o = out[v]!;
        // One outgoing edge, or a saddle (two): take the right turn.
        const nd = (o & (o - 1)) === 0 ? 31 - Math.clz32(o) : (d + 3) & 3;
        if (v === start && nd === d0) break;
        d = nd;
      }
      if (d === d0 && ring.length > 1) ring.shift(); // start vertex was mid-edge, not a corner
      ring.push([ring[0]![0], ring[0]![1]]);
      rings.push(ring);
    }
  }
  return rings;
}

/** Group traced rings into polygons [exterior, ...holes]. */
function assemble(rings: Ring[]): Ring[][] {
  const shells: { ring: Ring; area: number; holes: Ring[] }[] = [];
  const holes: Ring[] = [];
  for (const ring of rings) {
    const a = ringSignedArea(ring);
    if (a > 0) shells.push({ ring, area: a, holes: [] });
    else if (a < 0) holes.push(ring);
  }
  for (const hole of holes) {
    if (shells.length === 1) {
      shells[0]!.holes.push(hole);
      continue;
    }
    // Centre of the background pixel to the right of the hole's first edge lies strictly inside the hole.
    const p = hole[0]!;
    const q = hole[1]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dx = (q[0] - p[0]) / len;
    const dy = (q[1] - p[1]) / len;
    const test: Position = [p[0] + dx * 0.5 + dy * 0.5, p[1] + dy * 0.5 - dx * 0.5];
    let owner: (typeof shells)[number] | undefined;
    for (const s of shells) if (pointInRing(test, s.ring) && (!owner || s.area < owner.area)) owner = s;
    (owner ?? shells[0])?.holes.push(hole);
  }
  return shells.map((s) => [s.ring, ...s.holes]);
}

/**
 * Polygons (in the grid's CRS) covering the pixels where `mask` is 1. The mask
 * is `maskWidth` wide and positioned at (colOffset, rowOffset) in `grid`.
 */
export function vectorizeMask(mask: Uint8Array, maskWidth: number, maskHeight: number, grid: Grid, colOffset = 0, rowOffset = 0): Ring[][] {
  const [ox, pw, , oy, , nph] = grid.transform;
  const polys = assemble(traceRings(mask, maskWidth, maskHeight));
  return polys.map((poly) =>
    poly.map((ring) => ring.map(([vx, negVy]): Position => [ox + (colOffset + vx) * pw, oy + (rowOffset - negVy) * nph])),
  );
}

/** Polygons (grid CRS) of the pixels labelled `label`, restricted to its bounding box. */
export function vectorizeComponent(labels: Int32Array, grid: Grid, label: number, bbox: PixelBBox): Ring[][] {
  const bw = bbox.maxCol - bbox.minCol + 1;
  const bh = bbox.maxRow - bbox.minRow + 1;
  const local = new Uint8Array(bw * bh);
  for (let r = 0; r < bh; r++) {
    const src = (bbox.minRow + r) * grid.width + bbox.minCol;
    for (let c = 0; c < bw; c++) if (labels[src + c] === label) local[r * bw + c] = 1;
  }
  return vectorizeMask(local, bw, bh, grid, bbox.minCol, bbox.minRow);
}

/** Unproject grid-CRS polygons to a lon/lat GeoJSON MultiPolygon (orientation preserved). */
export function toLonLatMultiPolygon(polys: Ring[][], epsg: number): MultiPolygonGeometry {
  return { type: "MultiPolygon", coordinates: unprojectMultiPolygon(polys, epsg) };
}
