/**
 * SensorDyme Edge — procedural blueprint model (Three.js).
 *
 * Proportions are 4 wide × 3 tall × 6 deep (illustrative, not a published
 * dimension). The camera sits on the 4 × 3 front face and looks forward
 * along +Z; the body runs 6 units back. Internals follow the prototype's
 * documented build: Camera Module 3 Wide NoIR, IR illuminator, Raspberry
 * Pi 5 with active cooler and microSD, AI HAT+ (Hailo-8L), buzzer, status
 * light, and USB-C power.
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { createPartKit, ProductStage, type LabelSink, type Look, type ProductModel, type StageConfig } from "@/components/explorer/product-stage";
import type { EdgeSystemId } from "@/content/sensordyme";

const U = 0.3; // one proportion unit
export const W = 4 * U; // width  (X)
export const H = 3 * U; // height (Y)
export const D = 6 * U; // depth  (Z) — camera face at +D/2
const FRONT = D / 2;
const LENS: [number, number, number] = [-0.3, 0.1, FRONT + 0.03];
const LID_H = 0.16;

const C = {
  body: 0x15181b,
  lid: 0x1b1f22,
  glass: 0x05070a,
  pcb: 0x1e2925,
  pcbDark: 0x172019,
  chip: 0x0c0d0e,
  silver: 0x9fa4ab,
  alu: 0xb8bcc2,
  ribbon: 0xd9d2c0,
  ir: 0x2a0d10,
  light: 0x5fb4d6,
  signal: 0xff6a2b,
  amber: 0xe9b949,
  water: 0x5fb4d6,
  bone: 0xf2f1ed,
};

export function buildEdge(): ProductModel {
  const kit = createPartKit(["enclosure", "lid", "camera", "night", "compute", "accelerator", "alerts", "power"]);
  const { root, groups, materials, edges, disposables, add, line, overlay, overlayMats } = kit;
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const zRot: [number, number, number] = [Math.PI / 2, 0, 0]; // cylinder axis → Z (facing forward)

  /* ── Enclosure: body + removable lid ───────────────────────── */
  const bodyH = H - LID_H;
  add("enclosure", new RoundedBoxGeometry(W, bodyH, D, 4, 0.06), C.body, { pos: [0, -H / 2 + bodyH / 2, 0], rough: 0.62, metal: 0.3 });
  add("lid", new RoundedBoxGeometry(W, LID_H, D, 4, 0.05), C.lid, { pos: [0, H / 2 - LID_H / 2, 0], rough: 0.55, metal: 0.3 });
  for (let i = 0; i < 6; i++) {
    add("lid", box(0.5, 0.008, 0.035), C.chip, { pos: [0.1, H / 2 + 0.002, -0.35 - i * 0.08], outline: false });
  }
  // Front sensor-glass strip and rear vents
  add("enclosure", new RoundedBoxGeometry(W - 0.16, 0.34, 0.02, 2, 0.008), C.glass, { pos: [0, 0.1, FRONT + 0.004], rough: 0.12, metal: 0.4 });
  for (let i = 0; i < 5; i++) add("enclosure", box(0.6, 0.016, 0.01), C.chip, { pos: [0.15, 0.05 - i * 0.05, -FRONT - 0.002], outline: false });

  /* ── Camera: lens on the 4 × 3 face, module, ribbon ────────── */
  add("camera", new THREE.CylinderGeometry(0.11, 0.12, 0.05, 48), 0x0b0d10, { pos: LENS, rot: zRot, rough: 0.3, metal: 0.6 });
  add("camera", new THREE.TorusGeometry(0.11, 0.007, 12, 64), 0x8f959b, { pos: [LENS[0], LENS[1], LENS[2] + 0.026], rough: 0.3, metal: 0.9 });
  add("camera", new THREE.CircleGeometry(0.085, 40), 0x020304, { pos: [LENS[0], LENS[1], LENS[2] + 0.027], rough: 0.05, metal: 0.6, outline: false });
  add("camera", box(0.26, 0.26, 0.016), C.pcb, { pos: [LENS[0], LENS[1], FRONT - 0.1], rough: 0.6, metal: 0.1 });
  add("camera", box(0.09, 0.09, 0.05), C.chip, { pos: [LENS[0], LENS[1], FRONT - 0.06], rough: 0.4, metal: 0.4 });
  add("camera", box(0.14, 0.004, 0.36), C.ribbon, { pos: [LENS[0], -0.03, FRONT - 0.12], rot: [Math.PI / 2, 0, 0], rough: 0.8, metal: 0 });
  add("camera", box(0.14, 0.004, 0.5), C.ribbon, { pos: [LENS[0], -0.21, FRONT - 0.37], rough: 0.8, metal: 0 });

  /* ── Night vision: IR board behind flush windows ───────────── */
  add("night", box(0.42, 0.2, 0.016), C.pcbDark, { pos: [0.24, 0.1, FRONT - 0.09], rough: 0.6, metal: 0.1 });
  [0.12, 0.36].forEach((x) => {
    add("night", new THREE.CircleGeometry(0.055, 32), C.ir, { pos: [x, 0.1, FRONT + 0.016], rough: 0.2, metal: 0.3, emissive: 0x3a0606, emissiveIntensity: 0.5, outline: false });
    add("night", new THREE.SphereGeometry(0.045, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), 0x3a1418, { pos: [x, 0.1, FRONT - 0.07], rot: [Math.PI / 2, 0, 0], rough: 0.2, metal: 0.2 });
  });

  /* ── Compute: Raspberry Pi 5, active cooler, microSD ───────── */
  const piY = -0.33;
  add("compute", box(0.56, 0.022, 0.85), C.pcb, { pos: [0, piY, -0.25], rough: 0.6, metal: 0.1 });
  add("compute", box(0.14, 0.02, 0.14), C.silver, { pos: [0.08, piY + 0.02, -0.3], rough: 0.3, metal: 0.9 });
  add("compute", box(0.12, 0.016, 0.09), C.chip, { pos: [-0.12, piY + 0.02, -0.3], rough: 0.4, metal: 0.3 });
  [-0.17, 0, 0.17].forEach((x) => add("compute", box(0.13, 0.1, 0.16), C.silver, { pos: [x, piY + 0.06, -0.6], rough: 0.3, metal: 0.85 }));
  add("compute", box(0.11, 0.008, 0.13), 0x3a3f43, { pos: [0, piY - 0.012, 0.18], rough: 0.4, metal: 0.5 });
  for (let k = 0; k < 7; k++) add("compute", box(0.006, 0.05, 0.16), C.alu, { pos: [0.02 + k * 0.022, piY + 0.06, -0.3], rough: 0.3, metal: 0.9, outline: false });
  add("compute", new THREE.CylinderGeometry(0.07, 0.07, 0.016, 32), 0x1b1c20, { pos: [0.09, piY + 0.095, -0.3], rough: 0.45, metal: 0.4 });

  /* ── Accelerator: AI HAT+ stacked above the Pi ─────────────── */
  const accel = new THREE.Group();
  groups.accelerator!.add(accel);
  const hatY = -0.15;
  add("accelerator", box(0.56, 0.018, 0.62), C.pcbDark, { parent: accel, pos: [0, hatY, -0.12], rough: 0.6, metal: 0.1 });
  add("accelerator", box(0.12, 0.02, 0.12), C.chip, { parent: accel, pos: [0.06, hatY + 0.018, -0.05], rough: 0.35, metal: 0.4 });
  add("accelerator", box(0.06, 0.004, 0.06), C.signal, { parent: accel, pos: [0.06, hatY + 0.03, -0.05], rough: 0.5, metal: 0.2, outline: false });
  [[-0.24, 0.15], [0.24, 0.15], [-0.24, -0.39], [0.24, -0.39]].forEach(([x, z]) =>
    add("accelerator", new THREE.CylinderGeometry(0.012, 0.012, 0.16, 10), 0xc9a13b, { parent: accel, pos: [x!, (piY + hatY) / 2, z!], rough: 0.35, metal: 0.9, outline: false }),
  );

  /* ── Alerts: buzzer behind the grille, status light bar ────── */
  add("alerts", new THREE.CylinderGeometry(0.075, 0.075, 0.06, 32), 0x101114, { pos: [0.38, -0.25, FRONT - 0.07], rot: zRot, rough: 0.5, metal: 0.3 });
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) add("alerts", new THREE.CircleGeometry(0.008, 8), 0x050607, { pos: [0.28 + c * 0.03, -0.22 - r * 0.035, FRONT + 0.001], outline: false });
  }
  add("alerts", box(0.42, 0.018, 0.01), 0x0a1014, { pos: [-0.1, -0.25, FRONT + 0.004], emissive: C.light, emissiveIntensity: 0.9, rough: 0.3, metal: 0.1 });

  /* ── Power: USB-C on the rear face ─────────────────────────── */
  add("power", box(0.12, 0.045, 0.04), 0x2b2f33, { pos: [-0.38, -0.3, -FRONT - 0.005], rough: 0.4, metal: 0.8 });
  add("power", box(0.1, 0.034, 0.12), 0x1a1c1f, { pos: [-0.38, -0.3, -FRONT - 0.08], rough: 0.5, metal: 0.3 });
  add("power", new THREE.CylinderGeometry(0.018, 0.018, 0.45, 12), 0x0f1012, { pos: [-0.38, -0.3, -FRONT - 0.36], rot: zRot, rough: 0.6, metal: 0.1 });

  /* ── SensorDyme overlay: the camera's view and what it understands ── */
  const lens = new THREE.Vector3(...LENS);
  const dist = 2.1;
  const hw = 1.45;
  const hh = 0.85;
  const pz = LENS[2] + dist;
  const cx = LENS[0];
  const cy = LENS[1] - 0.15;
  const corners = [
    new THREE.Vector3(cx - hw, cy - hh, pz),
    new THREE.Vector3(cx + hw, cy - hh, pz),
    new THREE.Vector3(cx + hw, cy + hh, pz),
    new THREE.Vector3(cx - hw, cy + hh, pz),
  ];
  const loop = (pts: THREE.Vector3[]) => pts.flatMap((p, i) => [p, pts[(i + 1) % pts.length]!]);
  line(corners.flatMap((c) => [lens, c]), C.water, 0.45);
  line(loop(corners), C.water, 0.9);
  // A zone on the floor of the scene, a tracked person, and a second detection
  const zone = [
    [-0.55, -0.95],
    [0.75, -0.95],
    [0.95, -0.35],
    [-0.75, -0.35],
  ].map(([x, y]) => new THREE.Vector3(cx + x!, cy + y! * 0.9, pz));
  line(loop(zone), C.amber, 0.85);
  const person = (x: number, y: number, w: number, h: number, color: number) => {
    const p = [
      new THREE.Vector3(cx + x, cy + y, pz),
      new THREE.Vector3(cx + x + w, cy + y, pz),
      new THREE.Vector3(cx + x + w, cy + y + h, pz),
      new THREE.Vector3(cx + x, cy + y + h, pz),
    ];
    line(loop(p), color, 0.95);
    line([new THREE.Vector3(cx + x + w / 2, cy + y, pz), new THREE.Vector3(cx + x + w / 2 - 0.6, cy + y + 0.05, pz)], color, 0.35);
  };
  person(0.05, -0.62, 0.22, 0.62, C.signal);
  person(-1.1, -0.2, 0.18, 0.5, C.bone);

  return {
    root,
    groups,
    materials,
    edges,
    movers: { lid: groups.lid!, accel },
    spinners: [],
    overlay,
    overlayMats,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

/* ── Camera choreography per component view ──────────────────── */

const open = { movers: { lid: [0, 0.6, 0] as [number, number, number] }, ghost: { lid: 0.04 } };

export const edgeStageConfig: StageConfig = {
  grid: { radius: 1.6, y: -H / 2 - 0.02 },
  fitAspect: 1.45,
  looks: {
    exterior: { view: { az: 0.62, el: 0.32, dist: 5.2, target: [0, 0, 0] }, focus: "all", anchor: null, autoRotate: true },
    enclosure: { view: { az: 0.95, el: 0.42, dist: 5, target: [0, 0, 0] }, focus: ["enclosure", "lid"], anchor: [W / 2, H / 2, 0.3] },
    camera: { view: { az: 0.38, el: 0.22, dist: 2.7, target: [-0.3, 0, 0.55] }, focus: ["camera"], anchor: LENS, ...open },
    night: { view: { az: -0.32, el: 0.22, dist: 2.7, target: [0.24, 0.05, 0.6] }, focus: ["night"], anchor: [0.36, 0.1, FRONT + 0.02], ...open },
    compute: {
      view: { az: -0.75, el: 0.78, dist: 3.4, target: [0, -0.25, -0.25] },
      focus: ["compute"],
      anchor: [0.08, -0.31, -0.3],
      movers: { lid: [0, 0.6, 0], accel: [0, 0.42, 0] },
      ghost: { lid: 0.04, accelerator: 0.06 },
    },
    accelerator: {
      view: { az: 0.6, el: 0.7, dist: 3.3, target: [0, -0.05, -0.15] },
      focus: ["accelerator"],
      anchor: [0.06, -0.12, -0.05],
      anchorMover: "accel",
      movers: { lid: [0, 0.6, 0], accel: [0, 0.22, 0] },
      ghost: { lid: 0.04 },
    },
    alerts: { view: { az: 0.22, el: 0.08, dist: 2.9, target: [0.15, -0.2, 0.75] }, focus: ["alerts"], anchor: [0.38, -0.25, FRONT] },
    power: { view: { az: 2.55, el: 0.3, dist: 2.6, target: [-0.35, -0.28, -1.0] }, focus: ["power"], anchor: [-0.38, -0.3, -FRONT - 0.02] },
    intelligence: { view: { az: 2.45, el: 0.32, dist: 6.6, target: [-0.3, -0.1, 1.6] }, focus: "all", anchor: [-0.04, -0.2, LENS[2] + 2.1], overlay: true },
  } satisfies Record<EdgeSystemId, Look>,
};

export function createStage(host: HTMLElement, initial: string, opts: { reduceMotion: boolean; onLabel: LabelSink }) {
  return new ProductStage(host, buildEdge(), edgeStageConfig, initial, opts);
}
