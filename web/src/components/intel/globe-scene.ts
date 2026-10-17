/**
 * The CesiumJS scene behind the intelligence globe: imagery, entities,
 * picking, clock, and camera, behind a small imperative API that the React
 * workspace drives. Uses @cesium/engine only (no Cesium ion, no keys): base
 * imagery is NASA GIBS Blue Marble, terrain is the ellipsoid.
 *
 * Styling follows the 2D map: ORYN's findings keep their categorical colours,
 * public events and computed orbits are neutral ink, selection is signal
 * orange.
 */
import type * as CesiumNS from "@cesium/engine";
import { DETECTION_COLORS } from "@/components/map/legend";
import type { AoiFeatureProps, DetectionFeatureProps, FC } from "@/components/map/types";
import { BLUE_MARBLE, VIIRS_DAILY } from "@/lib/intel/layers";
import type { CameraRecord } from "@/lib/intel/cameras";
import type { SatelliteTracksResponse } from "@/lib/intel/satellites";
import type { PublicEventProps } from "@/lib/public-events";

type Cesium = typeof CesiumNS;
export type PickKind = "aoi" | "detection" | "event" | "satellite" | "camera";
export type Picked = { kind: PickKind; id: string; layer?: string };

const INK = "#f2f1ed";
const SIGNAL = "#ff6a2b";
export const CESIUM_VERSION = "26.3.0";

export async function loadCesium(): Promise<Cesium> {
  (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = `/vendor/cesium-${CESIUM_VERSION}/`;
  return import("@cesium/engine");
}

/** A small camera glyph (data URI SVG); filled when the camera streams live video. */
function cameraIcon(color: string, video: boolean): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="3" y="9" width="18" height="14" rx="2" fill="${video ? color : "#060707"}" fill-opacity="${video ? 0.9 : 0.6}" stroke="${color}" stroke-width="2.5"/><path d="M21 14l8-4v12l-8-4z" fill="${color}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type Ring = [number, number][];
function polygonsOf(g: GeoJSON.Geometry): Ring[][] {
  if (g.type === "Polygon") return [g.coordinates as Ring[]];
  if (g.type === "MultiPolygon") return g.coordinates as Ring[][];
  return [];
}

export class GlobeScene {
  readonly widget: CesiumNS.CesiumWidget;
  private readonly C: Cesium;
  private readonly sources: Record<"aois" | "detections" | "quakes" | "fires" | "satellites" | "cameras", CesiumNS.CustomDataSource>;
  private viirs: CesiumNS.ImageryLayer | null = null;
  private viirsDate: string | null = null;
  private aerial: CesiumNS.ImageryLayer | null = null;
  private selected: Picked | null = null;
  private satMeta = new Map<string, { swathKm: number; samples: [number, number, number, number][] }>();
  private destroyed = false;

  constructor(C: Cesium, container: HTMLElement, creditContainer: HTMLElement, usgsAerialTemplate: string) {
    this.C = C;
    const base = new C.ImageryLayer(new C.UrlTemplateImageryProvider({ url: BLUE_MARBLE.url, maximumLevel: BLUE_MARBLE.maximumLevel, credit: new C.Credit(BLUE_MARBLE.credit, true) }));
    this.widget = new C.CesiumWidget(container, {
      baseLayer: base,
      terrainProvider: new C.EllipsoidTerrainProvider(),
      creditContainer,
      shouldAnimate: true,
      // Re-render on interaction or when the clock moves 0.25 s; satellites stay smooth without burning a frame every 16 ms.
      requestRenderMode: true,
      maximumRenderTimeChange: 0.25,
      scene3DOnly: true,
      blurActiveElementOnCanvasFocus: false,
    });
    const scene = this.widget.scene;
    scene.globe.enableLighting = true; // real day/night terminator for the clock time
    scene.globe.baseColor = C.Color.fromCssColorString("#0b0d0e");
    scene.screenSpaceCameraController.minimumZoomDistance = 200;
    scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;
    this.aerialTemplate = usgsAerialTemplate;

    const clock = this.widget.clock;
    const now = C.JulianDate.now();
    clock.startTime = C.JulianDate.addDays(now, -30, new C.JulianDate());
    clock.stopTime = C.JulianDate.addDays(now, 7, new C.JulianDate());
    clock.currentTime = now.clone();
    clock.clockRange = C.ClockRange.CLAMPED;
    clock.multiplier = 1;

    this.sources = {
      aois: new C.CustomDataSource("aois"),
      detections: new C.CustomDataSource("detections"),
      fires: new C.CustomDataSource("fires"),
      quakes: new C.CustomDataSource("quakes"),
      satellites: new C.CustomDataSource("satellites"),
      cameras: new C.CustomDataSource("cameras"),
    };
    for (const s of Object.values(this.sources)) void this.widget.dataSources.add(s);
  }
  private aerialTemplate: string;

  isDestroyed() {
    return this.destroyed || this.widget.isDestroyed();
  }

  destroy() {
    this.destroyed = true;
    if (!this.widget.isDestroyed()) this.widget.destroy();
  }

  private color(css: string, alpha = 1) {
    return this.C.Color.fromCssColorString(css).withAlpha(alpha);
  }

  private requestRender() {
    if (!this.isDestroyed()) this.widget.scene.requestRender();
  }

  // ── Imagery ───────────────────────────────────────────────────

  setViirs(date: string | null) {
    const C = this.C;
    if (date === this.viirsDate) return;
    if (this.viirs) this.widget.imageryLayers.remove(this.viirs, true);
    this.viirs = null;
    this.viirsDate = date;
    if (date) {
      const layer = new C.ImageryLayer(new C.UrlTemplateImageryProvider({ url: VIIRS_DAILY.url(date), maximumLevel: VIIRS_DAILY.maximumLevel, credit: new C.Credit(`${VIIRS_DAILY.credit} (${date})`, true) }));
      this.widget.imageryLayers.add(layer, 1);
      this.viirs = layer;
    }
    this.requestRender();
  }

  setAerial(on: boolean) {
    const C = this.C;
    if (on === Boolean(this.aerial)) return;
    if (this.aerial) {
      this.widget.imageryLayers.remove(this.aerial, true);
      this.aerial = null;
    } else {
      const layer = new C.ImageryLayer(
        new C.UrlTemplateImageryProvider({ url: this.aerialTemplate, maximumLevel: 16, credit: new C.Credit("USDA, USGS The National Map: Orthoimagery (varying dates)", true) }),
        { minimumTerrainLevel: 8 },
      );
      this.widget.imageryLayers.add(layer);
      this.aerial = layer;
    }
    this.requestRender();
  }

  // ── ORYN data ────────────────────────────────────────────────

  setAois(fc: FC<AoiFeatureProps> | null, visible: boolean) {
    const C = this.C;
    const src = this.sources.aois;
    src.entities.suspendEvents();
    src.entities.removeAll();
    src.show = visible;
    for (const f of fc?.features ?? []) {
      const sel = this.selected?.kind === "aoi" && this.selected.id === f.properties.id;
      polygonsOf(f.geometry as GeoJSON.Geometry).forEach((rings, i) => {
        const outer = rings[0]!;
        src.entities.add({
          id: `aoi:${f.properties.id}:${i}`,
          properties: { kind: "aoi", ref: f.properties.id },
          polygon: {
            hierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(outer.flat()), rings.slice(1).map((h) => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(h.flat())))),
            material: this.color(INK, sel ? 0.12 : 0.05),
          },
          polyline: { positions: C.Cartesian3.fromDegreesArray(outer.flat()), width: sel ? 3 : 2, material: this.color(sel ? SIGNAL : INK, 0.95), clampToGround: true },
        });
        if (i === 0) {
          const [lon, lat] = outer.reduce(([a, b], [x, y]) => [a + x / outer.length, b + y / outer.length], [0, 0]);
          src.entities.add({
            id: `aoi-label:${f.properties.id}`,
            properties: { kind: "aoi", ref: f.properties.id },
            position: C.Cartesian3.fromDegrees(lon, lat, 0),
            label: {
              text: f.properties.name,
              font: "12px sans-serif",
              fillColor: this.color(sel ? SIGNAL : INK),
              outlineColor: this.color("#060707"),
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new C.Cartesian2(0, -14),
              distanceDisplayCondition: new C.DistanceDisplayCondition(0, 3_000_000),
              disableDepthTestDistance: 50_000,
            },
          });
        }
      });
    }
    src.entities.resumeEvents();
    this.requestRender();
  }

  setDetections(fc: FC<DetectionFeatureProps> | null, visible: boolean) {
    const C = this.C;
    const src = this.sources.detections;
    src.entities.suspendEvents();
    src.entities.removeAll();
    src.show = visible;
    for (const f of fc?.features ?? []) {
      const style = DETECTION_COLORS[f.properties.type] ?? DETECTION_COLORS.other!;
      const sel = this.selected?.kind === "detection" && this.selected.id === f.properties.id;
      polygonsOf(f.geometry as GeoJSON.Geometry).forEach((rings, i) => {
        const outer = rings[0]!;
        src.entities.add({
          id: `det:${f.properties.id}:${i}`,
          properties: { kind: "detection", ref: f.properties.id },
          polygon: { hierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(outer.flat())), material: this.color(style.color, style.dashed ? 0.05 : 0.35) },
          polyline: {
            positions: C.Cartesian3.fromDegreesArray(outer.flat()),
            width: sel ? 3 : 1.5,
            material: style.dashed ? new C.PolylineDashMaterialProperty({ color: this.color(sel ? "#ffffff" : style.color), dashLength: 12 }) : this.color(sel ? "#ffffff" : style.color),
            clampToGround: true,
          },
        });
      });
    }
    src.entities.resumeEvents();
    this.requestRender();
  }

  // ── Public events ────────────────────────────────────────────

  setQuakes(features: GeoJSON.Feature<GeoJSON.Geometry, PublicEventProps>[], visible: boolean) {
    const C = this.C;
    const src = this.sources.quakes;
    src.entities.suspendEvents();
    src.entities.removeAll();
    src.show = visible;
    for (const f of features) {
      if (f.geometry.type !== "Point" || f.properties.layer !== "usgs-earthquakes") continue;
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const sel = this.selected?.kind === "event" && this.selected.id === f.properties.id;
      const mag = f.properties.magnitude;
      src.entities.add({
        id: `quake:${f.properties.id}`,
        properties: { kind: "event", ref: f.properties.id, layer: "usgs-earthquakes", t: f.properties.observedAt ? Date.parse(f.properties.observedAt) : NaN },
        position: C.Cartesian3.fromDegrees(lon, lat, 0),
        point: {
          pixelSize: Math.min(26, 5 + (mag - 2.5) * 2.6),
          color: this.color(INK, 0.12),
          outlineColor: this.color(sel ? SIGNAL : INK, 0.95),
          outlineWidth: sel ? 3 : 1.5,
        },
      });
    }
    src.entities.resumeEvents();
    this.requestRender();
  }

  /** Show only earthquakes inside [fromMs, toMs] of the clock (event time, not retrieval time). */
  setQuakeWindow(fromMs: number, toMs: number) {
    for (const e of this.sources.quakes.entities.values) {
      const t = e.properties?.t?.getValue() as number | undefined;
      e.show = t !== undefined && Number.isFinite(t) && t >= fromMs && t <= toMs;
    }
    this.requestRender();
  }

  setFires(features: GeoJSON.Feature<GeoJSON.Geometry, PublicEventProps>[], visible: boolean) {
    const C = this.C;
    const src = this.sources.fires;
    src.entities.suspendEvents();
    src.entities.removeAll();
    src.show = visible;
    for (const f of features) {
      if (f.properties.layer !== "nifc-wildfire-perimeters") continue;
      const sel = this.selected?.kind === "event" && this.selected.id === f.properties.id;
      polygonsOf(f.geometry).forEach((rings, i) => {
        const outer = rings[0]!;
        src.entities.add({
          id: `fire:${f.properties.id}:${i}`,
          properties: { kind: "event", ref: f.properties.id, layer: "nifc-wildfire-perimeters" },
          polygon: {
            hierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(outer.flat())),
            material: new C.StripeMaterialProperty({ evenColor: this.color(INK, 0.5), oddColor: this.color(INK, 0.04), repeat: 18, orientation: C.StripeOrientation.VERTICAL }),
          },
          polyline: { positions: C.Cartesian3.fromDegreesArray(outer.flat()), width: sel ? 3 : 1.5, material: this.color(sel ? SIGNAL : INK, 0.95), clampToGround: true },
        });
      });
    }
    src.entities.resumeEvents();
    this.requestRender();
  }

  setFiresVisible(visible: boolean) {
    this.sources.fires.show = visible;
    this.requestRender();
  }

  // ── Satellites ───────────────────────────────────────────────

  setSatellites(res: SatelliteTracksResponse | null, visible: boolean) {
    const C = this.C;
    const src = this.sources.satellites;
    src.entities.suspendEvents();
    src.entities.removeAll();
    this.satMeta.clear();
    src.show = visible;
    for (const s of res?.satellites ?? []) {
      if (!s.track || s.track.samples.length < 2) continue;
      const pos = new C.SampledPositionProperty();
      pos.setInterpolationOptions({ interpolationDegree: 5, interpolationAlgorithm: C.LagrangePolynomialApproximation });
      for (const [t, lon, lat, h] of s.track.samples) pos.addSample(C.JulianDate.fromDate(new Date(t)), C.Cartesian3.fromDegrees(lon, lat, h));
      const first = s.track.samples[0]![0];
      const last = s.track.samples[s.track.samples.length - 1]![0];
      const id = String(s.noradId);
      this.satMeta.set(id, { swathKm: s.swathKm, samples: s.track.samples });
      const sel = this.selected?.kind === "satellite" && this.selected.id === id;
      src.entities.add({
        id: `sat:${id}`,
        properties: { kind: "satellite", ref: id },
        availability: new C.TimeIntervalCollection([new C.TimeInterval({ start: C.JulianDate.fromDate(new Date(first)), stop: C.JulianDate.fromDate(new Date(last)) })]),
        position: pos,
        point: { pixelSize: sel ? 10 : 7, color: this.color(sel ? SIGNAL : INK), outlineColor: this.color("#060707"), outlineWidth: 1.5 },
        label: {
          text: s.name,
          font: "11px sans-serif",
          fillColor: this.color(sel ? SIGNAL : INK),
          outlineColor: this.color("#060707"),
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(10, -10),
          horizontalOrigin: C.HorizontalOrigin.LEFT,
        },
        path: { leadTime: 25 * 60, trailTime: 25 * 60, width: sel ? 2.5 : 1.2, resolution: 60, material: this.color(sel ? SIGNAL : INK, sel ? 0.9 : 0.45) },
      });
      if (sel) this.addSwath(id);
    }
    src.entities.resumeEvents();
    this.requestRender();
  }

  /** Imaging swath along the computed ground track (±20 min of the window centre) for the selected satellite. */
  private addSwath(id: string) {
    const C = this.C;
    const meta = this.satMeta.get(id);
    if (!meta) return;
    const mid = meta.samples[Math.floor(meta.samples.length / 2)]![0];
    const pts = meta.samples.filter(([t]) => Math.abs(t - mid) <= 20 * 60_000);
    // Split where the track crosses the antimeridian so the corridor never wraps the globe.
    const parts: [number, number][][] = [[]];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && Math.abs(pts[i]![1] - pts[i - 1]![1]) > 180) parts.push([]);
      parts[parts.length - 1]!.push([pts[i]![1], pts[i]![2]]);
    }
    parts
      .filter((p) => p.length >= 2)
      .forEach((p, i) =>
        this.sources.satellites.entities.add({
          id: `swath:${id}:${i}`,
          properties: { kind: "satellite", ref: id },
          corridor: { positions: C.Cartesian3.fromDegreesArray(p.flat()), width: meta.swathKm * 1000, material: this.color(SIGNAL, 0.14), height: 0 },
        }),
      );
  }

  // ── Cameras ──────────────────────────────────────────────────

  setCameras(cams: CameraRecord[], visible: boolean) {
    const C = this.C;
    const src = this.sources.cameras;
    src.entities.suspendEvents();
    src.entities.removeAll();
    src.show = visible;
    for (const cam of cams) {
      const sel = this.selected?.kind === "camera" && this.selected.id === cam.id;
      src.entities.add({
        id: `cam:${cam.id}`,
        properties: { kind: "camera", ref: cam.id },
        position: C.Cartesian3.fromDegrees(cam.lon, cam.lat, 0),
        billboard: {
          image: cameraIcon(sel ? SIGNAL : INK, Boolean(cam.video)),
          width: sel ? 22 : 16,
          height: sel ? 22 : 16,
          scaleByDistance: new C.NearFarScalar(2e4, 1.2, 4e6, 0.45),
          disableDepthTestDistance: 2e5,
        },
      });
    }
    src.entities.resumeEvents();
    this.requestRender();
  }

  /** Lon/lat rectangle the camera currently sees, or null when the horizon is in view. */
  viewBbox(): [number, number, number, number] | null {
    const r = this.widget.camera.computeViewRectangle();
    if (!r) return null;
    const d = this.C.Math.toDegrees;
    return [d(r.west), d(r.south), d(r.east), d(r.north)];
  }

  onMoveEnd(cb: () => void) {
    return this.widget.camera.moveEnd.addEventListener(cb);
  }

  follow(entityId: string | null) {
    this.widget.trackedEntity = entityId ? this.widget.dataSources.getByName("satellites")[0]?.entities.getById(entityId) : undefined;
  }

  // ── Selection, picking, camera, clock ─────────────────────────

  setSelected(p: Picked | null) {
    this.selected = p;
  }

  onPick(cb: (p: Picked | null) => void) {
    const C = this.C;
    const handler = new C.ScreenSpaceEventHandler(this.widget.scene.canvas);
    handler.setInputAction((e: { position: CesiumNS.Cartesian2 }) => {
      const hit = this.widget.scene.pick(e.position) as { id?: CesiumNS.Entity } | undefined;
      const props = hit?.id?.properties;
      const kind = props?.kind?.getValue() as PickKind | undefined;
      const ref = props?.ref?.getValue() as string | undefined;
      cb(kind && ref ? { kind, id: ref, layer: props?.layer?.getValue() as string | undefined } : null);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e: { endPosition: CesiumNS.Cartesian2 }) => {
      const hit = this.widget.scene.pick(e.endPosition) as { id?: CesiumNS.Entity } | undefined;
      this.widget.canvas.style.cursor = hit?.id?.properties?.kind ? "pointer" : "";
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    return () => handler.destroy();
  }

  flyToBbox(b: [number, number, number, number], duration = 1.6) {
    const C = this.C;
    const pad = Math.max((b[2] - b[0]) * 0.6, (b[3] - b[1]) * 0.6, 0.05);
    this.widget.camera.flyTo({ destination: C.Rectangle.fromDegrees(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad), duration });
  }

  flyTo(lon: number, lat: number, heightM: number, duration = 1.6) {
    this.widget.camera.flyTo({ destination: this.C.Cartesian3.fromDegrees(lon, lat, heightM), duration });
  }

  /** Camera position as lon/lat/height (m). */
  view(): { lon: number; lat: number; heightM: number } {
    const c = this.widget.camera.positionCartographic;
    return { lon: this.C.Math.toDegrees(c.longitude), lat: this.C.Math.toDegrees(c.latitude), heightM: c.height };
  }

  timeMs(): number {
    return this.C.JulianDate.toDate(this.widget.clock.currentTime).getTime();
  }

  setTime(ms: number) {
    this.widget.clock.currentTime = this.C.JulianDate.fromDate(new Date(ms));
    this.requestRender();
  }

  setPlaying(on: boolean) {
    this.widget.clock.shouldAnimate = on;
    this.requestRender();
  }

  setMultiplier(x: number) {
    this.widget.clock.multiplier = x;
  }

  onTick(cb: (ms: number) => void) {
    let last = 0;
    const remove = this.widget.clock.onTick.addEventListener(() => {
      const ms = this.timeMs();
      if (Math.abs(ms - last) >= 250 || !this.widget.clock.shouldAnimate) {
        last = ms;
        cb(ms);
      }
    });
    return remove;
  }
}
