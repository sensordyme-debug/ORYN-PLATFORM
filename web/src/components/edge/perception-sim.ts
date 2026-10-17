/**
 * Deterministic simulation behind the SensorDyme Edge pipeline story.
 *
 * It mirrors the prototype's actual logic, simplified for illustration:
 *   - zone membership is tested at the feet point (bottom-center of the box),
 *   - a track survives a short occlusion (2 s grace),
 *   - an event moves observed → developing → confirmed → resolved, and only
 *     confirms after the condition has persisted for the rule's duration.
 * The scene and timings are illustrative, not recorded data.
 */

export const LOOP_S = 18.5;
export const FPS = 30;
export const PERSIST_S = 10;
export const OCCLUSION_GRACE_S = 2;
/** How long a confirmed event must be absent before it resolves. */
const RESOLVE_AFTER_S = 0.8;

export type Pt = [number, number];
type Key = [t: number, x: number, y: number];

/** Pool zone (restricted), in scene coordinates (viewBox 960 × 600). */
export const ZONE: Pt[] = [
  [362, 286],
  [778, 286],
  [912, 548],
  [268, 548],
];

/** A tall hedge person 1 passes behind — used to show occlusion handling. */
export const HEDGE = { x0: 286, x1: 352, y0: 118, y1: 254 };

/** A static object the detector also reports. */
export const CHAIR_BOX = { x: 150, y: 380, w: 118, h: 78, score: 0.71 };

const paths: Record<1 | 2, Key[]> = {
  1: [
    [0, 108, 246],
    [6, 424, 238],
    [10, 252, 262],
    [14, 92, 252],
    [LOOP_S, 108, 246],
  ],
  2: [
    [0, 1010, 368],
    [3.2, 846, 350],
    [4.6, 756, 340],
    [8, 640, 334],
    [13.8, 604, 344],
    [15.8, 668, 350],
    [16.9, 842, 356],
    [LOOP_S, 1010, 368],
  ],
};

function interp(keys: Key[], t: number): Pt {
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, x0, y0] = keys[i]!;
    const [t1, x1, y1] = keys[i + 1]!;
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0);
      const e = k * k * (3 - 2 * k); // smoothstep: people ease in and out
      return [x0 + (x1 - x0) * e, y0 + (y1 - y0) * e];
    }
  }
  const last = keys[keys.length - 1]!;
  return [last[1], last[2]];
}

export function feetAt(id: 1 | 2, t: number): Pt {
  return interp(paths[id], ((t % LOOP_S) + LOOP_S) % LOOP_S);
}

/** Apparent scale from depth: further up the frame is further away. */
export function depthScale(y: number) {
  return 0.52 + ((y - 150) / 420) * 0.78;
}

export function boxFor([x, y]: Pt) {
  const s = depthScale(y);
  return { x: x - 27 * s, y: y - 160 * s, w: 54 * s, h: 162 * s, s };
}

export function inPolygon([px, py]: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isOccluded(id: 1 | 2, t: number) {
  if (id !== 1) return false;
  const [x] = feetAt(1, t);
  return x > HEDGE.x0 + 6 && x < HEDGE.x1 - 6;
}

export function isVisible(id: 1 | 2, t: number) {
  const [x] = feetAt(id, t);
  return x > -20 && x < 980 && !isOccluded(id, t);
}

/** Detector confidence with a little deterministic frame-to-frame jitter. */
export function confidence(id: 1 | 2, t: number) {
  const base = id === 1 ? 0.88 : 0.91;
  const f = Math.floor(t * FPS);
  return Math.min(0.97, base + 0.025 * Math.sin(f * 0.7 + id * 2.1) + 0.01 * Math.sin(f * 2.3));
}

/** Event timeline for person 2 and the pool zone, precomputed once per loop. */
function computeTimeline() {
  let enter: number | null = null;
  let exit: number | null = null;
  for (let f = 0; f <= LOOP_S * FPS; f++) {
    const t = f / FPS;
    const inside = inPolygon(feetAt(2, t), ZONE);
    if (inside && enter === null) enter = t;
    if (!inside && enter !== null && exit === null) exit = t;
  }
  const enterT = enter ?? 0;
  const exitT = exit ?? LOOP_S;
  return { enterT, exitT, confirmT: enterT + PERSIST_S, resolveT: exitT + RESOLVE_AFTER_S };
}

export const timeline = computeTimeline();

export type EventState = "idle" | "observed" | "developing" | "confirmed" | "resolved";

export function eventAt(t: number): { state: EventState; dwell: number } {
  const { enterT, exitT, confirmT, resolveT } = timeline;
  if (t < enterT) return { state: "idle", dwell: 0 };
  const dwell = Math.min(t, exitT) - enterT;
  const confirmed = exitT >= confirmT;
  if (t < exitT) {
    if (dwell >= PERSIST_S) return { state: "confirmed", dwell };
    return { state: dwell >= PERSIST_S / 2 ? "developing" : "observed", dwell };
  }
  if (confirmed) return { state: t < resolveT ? "confirmed" : "resolved", dwell };
  return { state: "idle", dwell: 0 };
}

/** Which story stage a moment in the loop belongs to, for the auto-narrated mode. */
export function narratedStage(t: number) {
  const { enterT, confirmT } = timeline;
  // Tracking spans person 1's pass behind the hedge; verification spans the persistence window.
  const marks = [1.4, 2.8, 4.8, 7, enterT + PERSIST_S / 2, confirmT];
  let i = 0;
  while (i < marks.length && t >= marks[i]!) i++;
  return i;
}

export function trail(id: 1 | 2, t: number, seconds = 2): Pt[] {
  const pts: Pt[] = [];
  for (let k = seconds; k >= 0; k -= 0.1) {
    const tt = t - k;
    if (tt < 0) continue;
    pts.push(feetAt(id, tt));
  }
  return pts;
}
