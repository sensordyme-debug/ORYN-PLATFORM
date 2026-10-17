/**
 * SensorDyme Aero — procedural concept model (Three.js).
 *
 * Built in code, like the SensorDyme demo's device model, so it stays
 * lightweight and honest: it depicts the planned module layout, not
 * finished hardware. Proportions follow the 2D concept drawing; the
 * fuselage is the ORYN mark, extruded. Forward is +Z.
 */

import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { MARK_PATH, MARK_VIEWBOX } from "@/components/brand/logo";
import { createPartKit, ProductStage, type LabelSink, type Look, type ProductModel, type StageConfig } from "@/components/explorer/product-stage";
import type { AeroSystemId } from "@/content/aero";

export const MOTOR = 1.1; // motor offset on X and Z
export const GROUND_Y = -2.3;

const COLORS = {
  hull: 0x1a1d20,
  shell: 0x1d2124,
  carbon: 0x0f1113,
  alu: 0x9aa0a6,
  stator: 0x2b2f33,
  prop: 0x17191b,
  pcb: 0x1e2925,
  chip: 0x0b0c0d,
  battery: 0x2c3034,
  puck: 0xd8d5cd,
  signal: 0xff6a2b,
  water: 0x5fb4d6,
  bone: 0xf2f1ed,
};

export function buildDrone(): ProductModel {
  const kit = createPartKit(["airframe", "shell", "propulsion", "power", "flight", "compute", "payload", "link"]);
  const { root, groups, materials, edges, disposables, add, line, overlay, overlayMats, overlayMesh } = kit;

  /* ── Fuselage: the ORYN mark, extruded ─────────────────────── */
  const [, , vbW, vbH] = MARK_VIEWBOX.split(" ").map(Number) as [number, number, number, number];
  const svg = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}"><path d="${MARK_PATH}"/></svg>`);
  const markShapes = svg.paths.flatMap((p) => p.toShapes());
  const S = 0.98 / vbW;
  const fuselage = (depth: number, inset: number) => {
    const geo = new THREE.ExtrudeGeometry(markShapes, { depth, bevelEnabled: true, bevelThickness: 4, bevelSize: 3, bevelSegments: 2, curveSegments: 10 });
    geo.translate(-vbW / 2, -vbH / 2, 0);
    // SVG y-down → forward (+Z); extrusion → up (+Y)
    geo.applyMatrix4(new THREE.Matrix4().makeScale(S * inset, S * inset, S));
    geo.rotateX(-Math.PI / 2);
    return geo;
  };
  add("airframe", fuselage(0.1 / S, 1), COLORS.hull, { pos: [0, -0.06, 0], rough: 0.6, metal: 0.25 });
  add("shell", fuselage(0.12 / S, 0.97), COLORS.shell, { pos: [0, 0.06, 0], rough: 0.62, metal: 0.25 });

  /* ── Arms & landing gear ───────────────────────────────────── */
  const armLen = Math.hypot(MOTOR, MOTOR) - 0.26;
  [45, 135, 225, 315].forEach((deg) => {
    const a = THREE.MathUtils.degToRad(deg);
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const mid = dir.clone().multiplyScalar(0.26 + armLen / 2);
    const arm = add("airframe", new THREE.CylinderGeometry(0.035, 0.042, armLen, 20), COLORS.carbon, { rough: 0.38, metal: 0.25 });
    arm.position.set(mid.x, 0.0, mid.z);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    // folding hinge collar near the body
    const collar = add("airframe", new THREE.CylinderGeometry(0.055, 0.055, 0.07, 20), COLORS.stator, { metal: 0.7, rough: 0.35 });
    collar.position.copy(dir.clone().multiplyScalar(0.36));
    collar.quaternion.copy(arm.quaternion);
    // ESC on the arm
    const esc = add("propulsion", new THREE.BoxGeometry(0.07, 0.03, 0.14), COLORS.pcb, { rough: 0.6, metal: 0.1 });
    esc.position.copy(dir.clone().multiplyScalar(0.62)).setY(0.05);
    esc.rotation.y = a;
  });
  [-0.24, 0.24].forEach((x) => {
    add("airframe", new THREE.CylinderGeometry(0.016, 0.016, 0.34, 10), COLORS.carbon, { pos: [x * 0.85, -0.2, 0.18], rot: [0, 0, x > 0 ? -0.22 : 0.22] });
    add("airframe", new THREE.CylinderGeometry(0.016, 0.016, 0.34, 10), COLORS.carbon, { pos: [x * 0.85, -0.2, -0.22], rot: [0, 0, x > 0 ? -0.22 : 0.22] });
    add("airframe", new THREE.CylinderGeometry(0.02, 0.02, 0.78, 12), COLORS.carbon, { pos: [x * 1.12, -0.36, -0.02], rot: [Math.PI / 2, 0, 0] });
  });

  /* ── Propulsion: motors & propellers ───────────────────────── */
  const blade = new THREE.Shape();
  blade.moveTo(0, -0.018);
  blade.bezierCurveTo(0.2, -0.05, 0.45, -0.04, 0.6, -0.006);
  blade.lineTo(0.6, 0.006);
  blade.bezierCurveTo(0.45, 0.03, 0.2, 0.035, 0, 0.018);
  const bladeGeo = new THREE.ExtrudeGeometry(blade, { depth: 0.008, bevelEnabled: false });
  bladeGeo.rotateX(Math.PI / 2);
  const props: THREE.Object3D[] = [];
  [
    [MOTOR, MOTOR],
    [-MOTOR, MOTOR],
    [-MOTOR, -MOTOR],
    [MOTOR, -MOTOR],
  ].forEach(([x, z], i) => {
    add("propulsion", new THREE.CylinderGeometry(0.075, 0.075, 0.05, 28), COLORS.stator, { pos: [x!, 0.03, z!], metal: 0.6, rough: 0.4 });
    add("propulsion", new THREE.CylinderGeometry(0.09, 0.095, 0.085, 32), COLORS.alu, { pos: [x!, 0.1, z!], metal: 0.9, rough: 0.28 });
    const hub = new THREE.Group();
    hub.position.set(x!, 0.155, z!);
    hub.rotation.y = i * 0.9;
    groups.propulsion!.add(hub);
    add("propulsion", new THREE.CylinderGeometry(0.028, 0.028, 0.04, 16), COLORS.alu, { parent: hub, metal: 0.9, rough: 0.3 });
    add("propulsion", bladeGeo.clone(), COLORS.prop, { parent: hub, rough: 0.55, metal: 0.1 });
    add("propulsion", bladeGeo.clone(), COLORS.prop, { parent: hub, rough: 0.55, metal: 0.1, rot: [0, Math.PI, 0] });
    hub.userData.dir = i % 2 ? -1 : 1;
    props.push(hub);
    // swept disc, drawn like the concept drawing's dashed circles
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.595, 0.6, 96),
      new THREE.MeshBasicMaterial({ color: COLORS.bone, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x!, 0.16, z!);
    groups.propulsion!.add(ring);
    disposables.push(ring.geometry, ring.material as THREE.Material);
  });
  bladeGeo.dispose();

  /* ── Power: battery & distribution ─────────────────────────── */
  const battery = new THREE.Group();
  groups.power!.add(battery);
  add("power", new THREE.BoxGeometry(0.3, 0.11, 0.5), COLORS.battery, { parent: battery, pos: [0, -0.13, -0.06], rough: 0.5, metal: 0.2 });
  add("power", new THREE.BoxGeometry(0.31, 0.02, 0.06), COLORS.bone, { parent: battery, pos: [0, -0.13, 0.12], rough: 0.8, metal: 0, outline: false });
  add("power", new THREE.BoxGeometry(0.2, 0.012, 0.2), COLORS.pcb, { pos: [0, 0.075, -0.05], rough: 0.6, metal: 0.1 });

  /* ── Flight control & navigation sensors ───────────────────── */
  add("flight", new THREE.BoxGeometry(0.14, 0.02, 0.14), COLORS.pcb, { pos: [0, 0.1, 0.12], rough: 0.6, metal: 0.1 });
  add("flight", new THREE.BoxGeometry(0.05, 0.014, 0.05), COLORS.signal, { pos: [0, 0.115, 0.12], rough: 0.5, metal: 0.2 });
  add("flight", new THREE.CylinderGeometry(0.008, 0.008, 0.16, 8), COLORS.stator, { pos: [0, 0.26, -0.3] });
  add("flight", new THREE.CylinderGeometry(0.065, 0.07, 0.03, 32), COLORS.puck, { pos: [0, 0.35, -0.3], rough: 0.7, metal: 0.05 });

  /* ── Companion computer ────────────────────────────────────── */
  add("compute", new THREE.BoxGeometry(0.26, 0.016, 0.17), COLORS.pcb, { pos: [0, 0.095, -0.17], rough: 0.6, metal: 0.1 });
  add("compute", new THREE.BoxGeometry(0.08, 0.012, 0.08), COLORS.chip, { pos: [-0.05, 0.108, -0.17], rough: 0.4, metal: 0.4 });
  for (let k = 0; k < 6; k++) {
    add("compute", new THREE.BoxGeometry(0.004, 0.04, 0.09), COLORS.alu, { pos: [0.02 + k * 0.016, 0.13, -0.17], metal: 0.9, rough: 0.3, outline: false });
  }

  /* ── Imaging payload: gimbal under the nose ────────────────── */
  add("payload", new THREE.CylinderGeometry(0.07, 0.07, 0.02, 24), COLORS.stator, { pos: [0, -0.075, 0.27], metal: 0.6 });
  add("payload", new THREE.BoxGeometry(0.16, 0.012, 0.02), COLORS.stator, { pos: [0, -0.1, 0.3], metal: 0.6 });
  [-0.075, 0.075].forEach((x) => add("payload", new THREE.BoxGeometry(0.012, 0.11, 0.03), COLORS.stator, { pos: [x, -0.15, 0.3], metal: 0.6 }));
  add("payload", new THREE.BoxGeometry(0.12, 0.1, 0.11), 0x121416, { pos: [0, -0.17, 0.31], rough: 0.45, metal: 0.4 });
  add("payload", new THREE.CylinderGeometry(0.035, 0.04, 0.04, 28), 0x050607, { pos: [0, -0.17, 0.38], rot: [Math.PI / 2, 0, 0], rough: 0.1, metal: 0.5 });

  /* ── Data link: radio & antennas ───────────────────────────── */
  add("link", new THREE.BoxGeometry(0.08, 0.02, 0.06), COLORS.pcb, { pos: [0.14, 0.095, -0.33], rough: 0.6, metal: 0.1 });
  [-1, 1].forEach((s) => {
    add("link", new THREE.CylinderGeometry(0.009, 0.012, 0.26, 10), 0x101214, { pos: [s * 0.27, 0.12, -0.36], rot: [-0.5, 0, s * -0.35], rough: 0.5 });
  });

  /* ── SensorDyme coverage footprint (intelligence view) ─────── */
  const lens = new THREE.Vector3(0, -0.17, 0.4);
  const fc = new THREE.Vector3(0, GROUND_Y, 1.5);
  const hw = 1.5;
  const hd = 1.0;
  const corners = [
    new THREE.Vector3(fc.x - hw, GROUND_Y, fc.z - hd),
    new THREE.Vector3(fc.x + hw, GROUND_Y, fc.z - hd),
    new THREE.Vector3(fc.x + hw, GROUND_Y, fc.z + hd),
    new THREE.Vector3(fc.x - hw, GROUND_Y, fc.z + hd),
  ];
  line(corners.flatMap((c) => [lens, c]), COLORS.water, 0.5);
  line(corners.flatMap((c, i) => [c, corners[(i + 1) % 4]!]), COLORS.water, 0.9);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(hw * 2, hd * 2),
    new THREE.MeshBasicMaterial({ color: COLORS.water, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.copy(fc);
  overlayMesh(plane, 0.07);
  // tracked subjects on the ground: a box per subject and a short track behind it
  [
    [-0.7, 1.1, COLORS.bone],
    [0.35, 1.8, COLORS.bone],
    [0.9, 0.95, COLORS.signal],
  ].forEach(([x, z, color]) => {
    const y = GROUND_Y + 0.002;
    const s = 0.13;
    const p = [
      [x! - s, z! - s],
      [x! + s, z! - s],
      [x! + s, z! + s],
      [x! - s, z! + s],
    ].map(([a, b]) => new THREE.Vector3(a, y, b));
    line(p.flatMap((c, i) => [c, p[(i + 1) % 4]!]), color!, 0.95);
    line([new THREE.Vector3(x! - 0.5, y, z! + 0.25), new THREE.Vector3(x! - s, y, z!)], color!, 0.35);
  });
  const grid = new THREE.GridHelper(7, 28, COLORS.bone, COLORS.bone);
  grid.position.set(0, GROUND_Y - 0.001, 1.2);
  const gm = grid.material as THREE.LineBasicMaterial;
  gm.transparent = true;
  gm.opacity = 0.07;
  gm.depthWrite = false;
  gm.userData.base = 0.07;
  overlay.add(grid);
  overlayMats.push(gm);
  disposables.push(grid.geometry, gm);

  return {
    root,
    groups,
    materials,
    edges,
    movers: { shell: groups.shell!, battery },
    spinners: props,
    overlay,
    overlayMats,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

/* ── Camera choreography per system view ─────────────────────── */

const LIFT: [number, number, number] = [0, 0.7, 0];
const lifted = { movers: { shell: LIFT }, ghost: { shell: 0.04 } };

export const droneStageConfig: StageConfig = {
  grid: { radius: 1.9, y: -0.37 },
  fitAspect: 1.45,
  looks: {
    exterior: { view: { az: 0.78, el: 0.36, dist: 5.6, target: [0, -0.05, 0] }, focus: "all", anchor: null, autoRotate: true },
    airframe: { view: { az: 0.45, el: 0.82, dist: 5.2, target: [0, 0, 0] }, focus: ["airframe", "shell"], anchor: [0.62, 0.02, 0.62] },
    propulsion: { view: { az: 0.95, el: 0.36, dist: 2.7, target: [MOTOR * 0.8, 0.05, MOTOR * 0.8] }, focus: ["propulsion"], anchor: [MOTOR, 0.15, MOTOR], spin: true },
    power: {
      view: { az: 0.62, el: 0.16, dist: 3.6, target: [0, -0.15, 0] },
      focus: ["power"],
      anchor: [0.15, -0.13, -0.06],
      anchorMover: "battery",
      movers: { shell: LIFT, battery: [0, -0.28, 0] },
      ghost: { shell: 0.04 },
    },
    flight: { view: { az: 0.3, el: 0.78, dist: 3.3, target: [0, 0.15, -0.05] }, focus: ["flight"], anchor: [0, 0.11, 0.12], ...lifted },
    compute: { view: { az: -0.55, el: 0.7, dist: 3.3, target: [0, 0.15, -0.17] }, focus: ["compute"], anchor: [-0.05, 0.12, -0.17], ...lifted },
    payload: { view: { az: 0.4, el: -0.02, dist: 2.8, target: [0, -0.12, 0.3] }, focus: ["payload"], anchor: [0, -0.17, 0.4] },
    link: { view: { az: -2.45, el: 0.42, dist: 3.5, target: [0, 0.15, -0.3] }, focus: ["link"], anchor: [0.31, 0.24, -0.43], ...lifted },
    intelligence: { view: { az: 0.95, el: 0.36, dist: 9.6, target: [0, -1.25, 1.0] }, focus: "all", anchor: [0.9, GROUND_Y, 0.95], overlay: true },
  } satisfies Record<AeroSystemId, Look>,
};

export function createStage(host: HTMLElement, initial: string, opts: { reduceMotion: boolean; onLabel: LabelSink }) {
  return new ProductStage(host, buildDrone(), droneStageConfig, initial, opts);
}
