/**
 * Shared renderer, camera choreography, and interaction for SensorDyme
 * product explorers (Edge and Aero). Loaded on demand (dynamic import) so
 * Three.js never ships in the initial bundle. Renders only while visible
 * and only while something is changing.
 *
 * A product supplies a model (named part groups, movable parts, an optional
 * overlay) and a set of "looks" — one per system view.
 */

import * as THREE from "three";

export type View = { az: number; el: number; dist: number; target: [number, number, number] };

export type Look = {
  view: View;
  /** Groups shown solid; everything else ghosts to an x-ray. */
  focus: string[] | "all";
  /** Point the on-screen label is anchored to. */
  anchor: [number, number, number] | null;
  /** The anchor travels with this mover. */
  anchorMover?: string;
  /** Offsets for named movable parts (e.g. a lid lifting away). */
  movers?: Record<string, [number, number, number]>;
  /** Ghost opacity overrides for specific groups. */
  ghost?: Record<string, number>;
  /** Show the model's overlay (e.g. a sensing footprint). */
  overlay?: boolean;
  /** Animate the model's spinners (e.g. propellers). */
  spin?: boolean;
  /** Slow idle rotation while nobody is interacting. */
  autoRotate?: boolean;
};

export type ProductModel = {
  root: THREE.Group;
  groups: Record<string, THREE.Group>;
  materials: Record<string, THREE.MeshStandardMaterial[]>;
  edges: Record<string, THREE.LineBasicMaterial[]>;
  movers: Record<string, THREE.Object3D>;
  spinners: THREE.Object3D[];
  overlay?: THREE.Group;
  /** Overlay materials carry their full opacity in `userData.base`. */
  overlayMats: THREE.Material[];
  dispose: () => void;
};

export type StageConfig = {
  looks: Record<string, Look>;
  /** Polar reference grid under the model. */
  grid: { radius: number; y: number };
  /** Minimum width/height ratio before the camera pulls back to fit. */
  fitAspect: number;
};

export type LabelSink = (pos: { x: number; y: number } | null) => void;

export class ProductStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  private grid: THREE.PolarGridHelper;
  private groupNames: string[];
  private raf = 0;
  private active = false;
  private last = 0;
  private dirty = true;
  private look: Look;
  private cur: { az: number; el: number; dist: number; target: THREE.Vector3 };
  private user = { az: 0, el: 0 };
  private drag: { id: number; x: number; y: number; type: string } | null = null;
  private lastInteract = 0;
  private fade: Record<string, number>;
  private rest: Record<string, THREE.Vector3>;
  private offset: Record<string, THREE.Vector3>;
  private over = 0;
  private aspect = 1;
  private ro: ResizeObserver;
  private lastLabel = "";

  constructor(
    private host: HTMLElement,
    private model: ProductModel,
    private config: StageConfig,
    initial: string,
    private opts: { reduceMotion: boolean; onLabel: LabelSink },
  ) {
    this.look = config.looks[initial]!;
    const v = this.look.view;
    this.cur = { az: v.az, el: v.el, dist: v.dist, target: new THREE.Vector3(...v.target) };
    this.groupNames = Object.keys(model.groups);
    this.fade = Object.fromEntries(this.groupNames.map((g) => [g, 1]));
    this.rest = Object.fromEntries(Object.entries(model.movers).map(([k, o]) => [k, o.position.clone()]));
    this.offset = Object.fromEntries(Object.keys(model.movers).map((k) => [k, new THREE.Vector3()]));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 768 ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.style.touchAction = "pan-y";
    canvas.style.cursor = "grab";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);

    this.scene.add(new THREE.HemisphereLight(0xe6e8ea, 0x0a0b0c, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(3, 5, 4);
    const rim = new THREE.DirectionalLight(0xcfe3ff, 1.1);
    rim.position.set(-4, 2.5, -3.5);
    const warm = new THREE.DirectionalLight(0xffd2b8, 0.35);
    warm.position.set(2, -2, 3);
    this.scene.add(key, rim, warm);
    this.scene.add(model.root);

    this.grid = new THREE.PolarGridHelper(config.grid.radius, 8, 5, 96, 0xf2f1ed, 0xf2f1ed);
    this.grid.position.y = config.grid.y;
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.1;
    gm.depthWrite = false;
    this.scene.add(this.grid);

    canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.applyLook(true);
  }

  setStep(id: string) {
    const next = this.config.looks[id];
    if (!next) return;
    this.look = next;
    this.user = { az: 0, el: 0 };
    // Idle auto-rotation and dragging accumulate whole turns; take the short way to the new view.
    const target = this.look.view.az;
    this.cur.az = target + Math.atan2(Math.sin(this.cur.az - target), Math.cos(this.cur.az - target));
    this.applyLook(this.opts.reduceMotion);
  }

  /** Pause rendering when off-screen. */
  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this.last = performance.now();
      this.dirty = true;
      this.raf = requestAnimationFrame(this.frame);
    } else cancelAnimationFrame(this.raf);
  }

  /** Nudge the view from keyboard controls. */
  rotateBy(daz: number, del = 0) {
    this.user.az += daz;
    this.user.el = THREE.MathUtils.clamp(this.user.el + del, -0.6, 0.6);
    this.lastInteract = performance.now();
    this.dirty = true;
    if (this.opts.reduceMotion) this.applyLook(true);
  }

  dispose() {
    this.setActive(false);
    this.ro.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    this.model.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  /* ── internals ─────────────────────────────────────────────── */

  private applyLook(instant: boolean) {
    if (instant) {
      const v = this.look.view;
      this.cur.az = v.az + this.user.az;
      this.cur.el = v.el + this.user.el;
      this.cur.dist = v.dist;
      this.cur.target.set(...v.target);
      this.groupNames.forEach((g) => (this.fade[g] = this.targetFade(g)));
      for (const k of Object.keys(this.offset)) this.offset[k]!.set(...(this.look.movers?.[k] ?? [0, 0, 0]));
      this.over = this.look.overlay ? 1 : 0;
      this.updateScene(0);
      this.render();
    }
    this.dirty = true;
  }

  private targetFade(g: string) {
    if (this.look.focus === "all" || this.look.focus.includes(g)) return 1;
    return this.look.ghost?.[g] ?? 0.1;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.aspect = w / h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    if (!this.active) this.render();
  }

  private onDown = (e: PointerEvent) => {
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType };
    this.renderer.domElement.style.cursor = "grabbing";
  };
  private onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    // On touch, vertical movement belongs to page scroll (touch-action: pan-y).
    this.rotateBy(-dx * 0.006, this.drag.type === "mouse" ? dy * 0.004 : 0);
  };
  private onUp = (e: PointerEvent) => {
    if (this.drag?.id !== e.pointerId) return;
    this.drag = null;
    this.renderer.domElement.style.cursor = "grab";
  };

  private frame = (now: number) => {
    // Exponential easing is stable at any step, so slow devices still finish transitions on time;
    // the cap only guards against a long pause (e.g. a background tab) jumping everything at once.
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const animating = this.updateScene(dt);
    if (animating || this.dirty) this.render();
    this.dirty = false;
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Eases every value toward its target; returns whether anything is still moving. */
  private updateScene(dt: number) {
    const k = dt === 0 ? 1 : 1 - Math.exp(-dt * 4.2);
    let moving = false;
    const ease = (from: number, to: number) => {
      const d = to - from;
      if (Math.abs(d) > 1e-4) moving = true;
      return Math.abs(d) < 1e-4 ? to : from + d * k;
    };

    const idle = !this.drag && performance.now() - this.lastInteract > 2500;
    if (this.look.autoRotate && idle && !this.opts.reduceMotion && dt > 0) {
      this.user.az += dt * 0.12;
      moving = true;
    }

    const v = this.look.view;
    this.cur.az = ease(this.cur.az, v.az + this.user.az);
    this.cur.el = ease(this.cur.el, THREE.MathUtils.clamp(v.el + this.user.el, -0.35, 1.35));
    this.cur.dist = ease(this.cur.dist, v.dist);
    const tx = ease(this.cur.target.x, v.target[0]);
    const ty = ease(this.cur.target.y, v.target[1]);
    const tz = ease(this.cur.target.z, v.target[2]);
    this.cur.target.set(tx, ty, tz);

    const fit = Math.max(1, this.config.fitAspect / this.aspect);
    const d = this.cur.dist * fit;
    this.camera.position.set(
      tx + d * Math.cos(this.cur.el) * Math.sin(this.cur.az),
      ty + d * Math.sin(this.cur.el),
      tz + d * Math.cos(this.cur.el) * Math.cos(this.cur.az),
    );
    this.camera.lookAt(this.cur.target);

    for (const g of this.groupNames) {
      const target = this.targetFade(g);
      const f = (this.fade[g] = ease(this.fade[g]!, target));
      const ghost = f < 0.999;
      for (const m of this.model.materials[g] ?? []) {
        m.opacity = f;
        if (m.transparent !== ghost) {
          m.transparent = ghost;
          m.needsUpdate = true; // blending mode is baked into the compiled program
        }
        m.depthWrite = f > 0.5;
      }
      const focused = this.look.focus !== "all" && this.look.focus.includes(g);
      // Ghosted parts keep a faint outline for context; parts moved fully aside nearly disappear.
      const edge = focused ? 0.3 : !ghost ? 0.1 : target < 0.05 ? 0.04 : 0.11;
      for (const e of this.model.edges[g] ?? []) e.opacity = edge;
    }

    for (const [name, obj] of Object.entries(this.model.movers)) {
      const o = this.offset[name]!;
      const t = this.look.movers?.[name] ?? [0, 0, 0];
      o.set(ease(o.x, t[0]), ease(o.y, t[1]), ease(o.z, t[2]));
      obj.position.copy(this.rest[name]!).add(o);
    }

    this.over = ease(this.over, this.look.overlay ? 1 : 0);
    if (this.model.overlay) {
      this.model.overlay.visible = this.over > 0.01;
      for (const m of this.model.overlayMats) m.opacity = (m.userData.base as number) * this.over;
    }
    (this.grid.material as THREE.LineBasicMaterial).opacity = 0.1 * (1 - this.over);

    if (this.look.spin && !this.opts.reduceMotion && dt > 0) {
      for (const p of this.model.spinners) p.rotation.y += dt * 2.4 * (p.userData.dir as number);
      moving = true;
    }
    return moving;
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
    const a = this.look.anchor;
    let key = "none";
    let pos: { x: number; y: number } | null = null;
    if (a && this.over >= (this.look.overlay ? 0.6 : 0)) {
      const p = new THREE.Vector3(...a);
      if (this.look.anchorMover) p.add(this.offset[this.look.anchorMover] ?? new THREE.Vector3());
      p.project(this.camera);
      if (p.z < 1) {
        pos = { x: ((p.x + 1) / 2) * this.host.clientWidth, y: ((1 - p.y) / 2) * this.host.clientHeight };
        key = `${Math.round(pos.x)},${Math.round(pos.y)}`;
      }
    }
    if (key !== this.lastLabel) {
      this.lastLabel = key;
      this.opts.onLabel(pos);
    }
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Builds part groups with per-mesh materials and fine engineering outlines. */
export function createPartKit(names: string[]) {
  const disposables: { dispose: () => void }[] = [];
  const root = new THREE.Group();
  const groups = Object.fromEntries(names.map((n) => [n, new THREE.Group()])) as Record<string, THREE.Group>;
  const materials = Object.fromEntries(names.map((n) => [n, [] as THREE.MeshStandardMaterial[]]));
  const edges = Object.fromEntries(names.map((n) => [n, [] as THREE.LineBasicMaterial[]]));
  names.forEach((n) => root.add(groups[n]!));

  const add = (
    group: string,
    geo: THREE.BufferGeometry,
    color: number,
    opts: {
      rough?: number;
      metal?: number;
      pos?: [number, number, number];
      rot?: [number, number, number];
      parent?: THREE.Object3D;
      outline?: boolean;
      emissive?: number;
      emissiveIntensity?: number;
    } = {},
  ) => {
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.5,
      metalness: opts.metal ?? 0.3,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    if (opts.pos) mesh.position.set(...opts.pos);
    if (opts.rot) mesh.rotation.set(...opts.rot);
    (opts.parent ?? groups[group]!).add(mesh);
    materials[group]!.push(mat);
    disposables.push(geo, mat);
    if (opts.outline !== false) {
      const eg = new THREE.EdgesGeometry(geo, 28);
      const em = new THREE.LineBasicMaterial({ color: 0xf2f1ed, transparent: true, opacity: 0.08, depthWrite: false });
      mesh.add(new THREE.LineSegments(eg, em));
      edges[group]!.push(em);
      disposables.push(eg, em);
    }
    return mesh;
  };

  /** Lines for overlays; opacity is driven by the stage from `userData.base`. */
  const overlay = new THREE.Group();
  const overlayMats: THREE.Material[] = [];
  const line = (pts: THREE.Vector3[], color: number, opacity: number) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    m.userData.base = opacity;
    overlay.add(new THREE.LineSegments(g, m));
    overlayMats.push(m);
    disposables.push(g, m);
  };
  const overlayMesh = (mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>, base: number) => {
    mesh.material.userData.base = base;
    overlay.add(mesh);
    overlayMats.push(mesh.material);
    disposables.push(mesh.geometry, mesh.material);
  };
  overlay.visible = false;
  root.add(overlay);

  return { root, groups, materials, edges, disposables, add, overlay, overlayMats, line, overlayMesh };
}
