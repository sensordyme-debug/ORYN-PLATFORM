/**
 * SensorDyme — the intelligence layer behind ORYN's products.
 *
 * Sources of truth (do not add claims that are not in them):
 *   - SensorDyme demo presentation (DemoSlideshow/js/content.js)
 *   - SensorDyme device software (sensordyne-models): core/tracking.py,
 *     core/zones.py, core/event_engine.py, docs/JUPITER.md,
 *     docs/PHASE5_DEMO_READINESS.md, docs/HARDWARE_VERIFICATION.md
 *
 * Measured figures come from a single prototype unit and are labeled as such.
 * They are not product specifications.
 */

import type { StaticImageData } from "next/image";
import angle from "@/assets/edge/angle.png";
import exploded from "@/assets/edge/exploded.png";
import front from "@/assets/edge/front.png";
import night from "@/assets/edge/night.png";
import side from "@/assets/edge/side.png";

export type Status = "Verified on prototype" | "In prototype software" | "Prototype hardware" | "In development" | "Planned" | "Concept";

/** SEE · UNDERSTAND · VERIFY · ACT — the SensorDyme loop, from the demo presentation. */
export const loop = [
  { word: "See", body: "Continuous on-device visual perception" },
  { word: "Understand", body: "People, motion, and context over time" },
  { word: "Verify", body: "Rules and temporal checks filter false alarms" },
  { word: "Act", body: "On-site and remote alerts when it matters" },
] as const;

/* ── Perception pipeline (interactive story) ─────────────────── */

export type PipelineStage = {
  id: "camera" | "perception" | "tracking" | "context" | "event" | "verification" | "alert";
  name: string;
  question: string;
  body: string;
  detail: string;
  status: Status;
};

export const pipelineStages: PipelineStage[] = [
  {
    id: "camera",
    name: "Camera",
    question: "What does it see?",
    body: "A wide-angle NoIR camera captures the scene continuously. With the infrared filter removed and an 850 nm illuminator, the same optics keep working after dark.",
    detail: "Camera Module 3 Wide NoIR · 640 × 480 capture on the prototype",
    status: "Prototype hardware",
  },
  {
    id: "perception",
    name: "Perception",
    question: "What is in the frame?",
    body: "A detection model runs continuously on a dedicated neural accelerator on the device itself, with no cloud round-trip.",
    detail: "DAMO-YOLO on the Hailo-8L (AI HAT+, 13 TOPS)",
    status: "Verified on prototype",
  },
  {
    id: "tracking",
    name: "Tracking",
    question: "Is it the same person?",
    body: "Detections become tracked identities. Someone who walks behind furniture stays the same person, so the timers that matter never restart.",
    detail: "Nearest-centroid matching gated in torso lengths · 2 s occlusion grace",
    status: "In prototype software",
  },
  {
    id: "context",
    name: "Context",
    question: "Where are they, relative to what matters?",
    body: "Named zones — restricted, safe, or boundary — give the scene meaning. Membership is judged at the feet, where a person actually stands, not the center of their box.",
    detail: "Normalized polygon zones · feet-point membership test",
    status: "In prototype software",
  },
  {
    id: "event",
    name: "Event",
    question: "Is something happening?",
    body: "Per-frame observations become a candidate event. It is observed, then developing — but not yet worth anyone's attention.",
    detail: "Event lifecycle: observed → developing → confirmed → resolved",
    status: "In prototype software",
  },
  {
    id: "verification",
    name: "Verification",
    question: "Is it real?",
    body: "A single uncertain frame never confirms anything. The condition must persist for the configured time, across enough frames, with smoothed confidence above threshold.",
    detail: "Persistence time · minimum frame count · EMA-smoothed confidence",
    status: "In prototype software",
  },
  {
    id: "alert",
    name: "Alert",
    question: "What happens next?",
    body: "On confirmation the device acts in the room: an on-site buzzer that needs no network, and a structured event written locally. Phone notifications are in development.",
    detail: "Buzzer via GPIO · local event log · phone alert (in development)",
    status: "In development",
  },
];

/** The illustrative rule used in the pipeline story. */
export const exampleRule = {
  zone: "Pool zone",
  kind: "restricted",
  condition: "Person in pool zone",
  persist: 10,
  action: "Buzzer + phone alert",
} as const;

/* ── SensorDyme Edge device ──────────────────────────────────── */

export type EdgeView = {
  id: "assembled" | "front" | "profile" | "night" | "exploded";
  label: string;
  caption: string;
  image: StaticImageData;
  alt: string;
};

export const edgeViews: EdgeView[] = [
  {
    id: "assembled",
    label: "Assembled",
    caption: "A flat graphite enclosure with one sensor-glass strip and a single status light.",
    image: angle,
    alt: "SensorDyme Edge prototype enclosure seen at an angle: a flat dark graphite body with a glass sensor strip, round lens, and a pale blue status light bar.",
  },
  {
    id: "front",
    label: "Front",
    caption: "Lens, flush infrared windows behind the glass, status bar, and buzzer grille.",
    image: front,
    alt: "Front view of the SensorDyme Edge enclosure showing the sensor-glass strip, lens, status light bar and perforated buzzer grille.",
  },
  {
    id: "profile",
    label: "Profile",
    caption: "A thin, wall-hugging body designed to disappear into a room.",
    image: side,
    alt: "Side profile of the thin SensorDyme Edge enclosure.",
  },
  {
    id: "night",
    label: "Night",
    caption: "Infrared illuminators engaged: dark to a person, visible to the NoIR sensor.",
    image: night,
    alt: "SensorDyme Edge enclosure at night with infrared emitters active, casting a faint red glow.",
  },
  {
    id: "exploded",
    label: "Exploded",
    caption: "Every internal component, separated. Select a part to see what it does.",
    image: exploded,
    alt: "Exploded view of the SensorDyme Edge prototype: infrared illuminator board, camera ribbon cable, microSD card, Raspberry Pi 5, AI HAT+, active cooler, front housing, and buzzer.",
  },
];

export type EdgePart = {
  id: string;
  n: string;
  name: string;
  role: string;
  body: string;
  /** Hotspot position on the exploded render, in percent. */
  at: [number, number];
  /** Who makes it. Defaults to "Third-party component". */
  source?: string;
};

/** Components of the current prototype, from the demo presentation. Third-party parts unless noted. */
export const edgeParts: EdgePart[] = [
  {
    id: "ir",
    n: "01",
    name: "Infrared illuminator",
    role: "Night vision",
    body: "High-output 850 nm infrared LEDs with an automatic light sensor. The room stays dark to people; the NoIR sensor sees clearly.",
    at: [15, 41],
  },
  {
    id: "ribbon",
    n: "02",
    name: "Camera ribbon cable",
    role: "MIPI CSI link",
    body: "A flat, high-speed interface that streams every captured frame from the camera to the processor.",
    at: [28.5, 37],
  },
  {
    id: "sd",
    n: "03",
    name: "High Endurance microSD",
    role: "Local memory",
    body: "64 GB storage built for continuous write cycles: operating system, software, configuration, logs, and events — on the device.",
    at: [34.5, 55],
  },
  {
    id: "pi",
    n: "04",
    name: "Raspberry Pi 5",
    role: "Orchestration",
    body: "A quad-core computer with 4 GB of RAM. It runs the SensorDyme software, coordinates the accelerator, and handles storage, networking, and alerts.",
    at: [51.5, 48],
  },
  {
    id: "hat",
    n: "05",
    name: "AI HAT+ · Hailo-8L",
    role: "Neural inference",
    body: "A 13 TOPS neural processor connected over PCIe. Vision models run on dedicated silicon while the CPU stays free for reasoning and rules.",
    at: [66, 37],
  },
  {
    id: "cooler",
    n: "06",
    name: "Active cooler",
    role: "Sustained performance",
    body: "An aluminum heatsink with a temperature-controlled fan, so continuous inference does not throttle.",
    at: [73.5, 44],
  },
  {
    id: "housing",
    n: "07",
    name: "Front housing & camera",
    role: "Sensing face",
    body: "The enclosure front carries the Camera Module 3 Wide NoIR — a 12 MP wide-angle sensor — behind a dark sensor-glass strip.",
    at: [83, 31],
    source: "Enclosure: ORYN prototype design · Camera: third-party",
  },
  {
    id: "buzzer",
    n: "08",
    name: "Active buzzer",
    role: "On-site alert",
    body: "A piezo sounder wired to the Pi's GPIO pins. It reaches everyone nearby the moment a rule is confirmed — even with no network.",
    at: [94, 72],
  },
];

/** Measured on one prototype unit, 29 Aug 2026 (Phase 5 demo readiness). Not specifications. */
export const edgeMeasurements = [
  { label: "Detector inference", value: "22 ms", note: "Mean of 300 samples on the Hailo-8L" },
  { label: "Pipeline frame rate", value: "≈30 fps", note: "29.5–29.9 fps live, most modes" },
  { label: "Evidence-losing stalls", value: "0", note: "No frame gaps over 1 s, any mode" },
  { label: "Boot to healthy", value: "6–9 s", note: "Measured per restart" },
];

/** What exists today, with an honest label on each. */
export const edgeStatus: { name: string; status: Status }[] = [
  { name: "On-device detection on the Hailo-8L", status: "Verified on prototype" },
  { name: "Tracking, zones, and temporal confirmation", status: "In prototype software" },
  { name: "Local event log", status: "Verified on prototype" },
  { name: "Infrared night vision", status: "Prototype hardware" },
  { name: "On-site buzzer alert", status: "Prototype hardware" },
  { name: "Phone notifications", status: "In development" },
  { name: "Natural-language rules (Jupiter)", status: "In development" },
];

/** Monitoring modes that exist in the prototype software. */
export const edgeModes = [
  { name: "Driver attention", body: "Distraction and phone-use detection from a dash-mounted unit." },
  { name: "Fall awareness", body: "Pose-based detection of a person going down — and staying down." },
  { name: "Child & infant monitoring", body: "Safe-zone monitoring with evidence-based identification." },
  { name: "Occupancy & restricted zones", body: "Presence, entry, and boundary crossings in named zones." },
];

/** Jupiter — the reasoning layer (docs/JUPITER.md). */
export const jupiter = {
  summary:
    "Jupiter is SensorDyme's reasoning layer. Specialized vision models stay specialized and run at full frame rate; Jupiter turns a plain-language request into a validated rule. A deterministic safety engine — not a language model — decides what fires.",
  example: {
    say: "“Alert me if someone is in the pool zone for more than ten seconds.”",
    rule: [
      ["If", "person in pool zone"],
      ["For", "longer than 10 seconds"],
      ["Then", "buzzer + phone alert"],
    ] as [string, string][],
  },
  status: "In development" as Status,
};

/* ── SensorDyme Edge — interactive blueprint explorer ────────── */

export type EdgeSystemId = "exterior" | "enclosure" | "camera" | "night" | "compute" | "accelerator" | "alerts" | "power" | "intelligence";

/**
 * System views for the Edge explorer. Components and statuses come from the
 * prototype's documented build (demo presentation, device repository, and
 * Phase 5 readiness record). The blueprint model shows the internal
 * architecture; its proportions are illustrative, not the prototype enclosure.
 */
export const edgeSystems: {
  id: EdgeSystemId;
  n: string;
  label: string;
  name: string;
  body: string;
  provenance: string;
  status: string;
  link?: { href: string; label: string };
}[] = [
  {
    id: "exterior",
    n: "00",
    label: "Exterior",
    name: "SensorDyme Edge",
    body: "A compact edge-AI sensing unit: a camera on the front face, compute and a neural accelerator inside, and alerts that act in the room. Drag to rotate; select a component to look inside.",
    provenance: "ORYN architecture",
    status: "Working prototype",
  },
  {
    id: "enclosure",
    n: "01",
    label: "Enclosure",
    name: "Serviceable housing",
    body: "A closed housing with a dark sensor-glass front, a removable lid, and vents for the active cooler. This blueprint's proportions are illustrative — the current prototype enclosure is shown in the renders below.",
    provenance: "ORYN prototype design",
    status: "Prototype design",
  },
  {
    id: "camera",
    n: "02",
    label: "Camera",
    name: "Camera Module 3 · Wide NoIR",
    body: "A 12 MP wide-angle sensor behind the front glass, with the infrared filter removed so it keeps seeing after dark. A flat MIPI CSI ribbon carries every frame to the processor.",
    provenance: "Third-party component · ORYN integration",
    status: "Prototype hardware",
  },
  {
    id: "night",
    n: "03",
    label: "Night vision",
    name: "850 nm infrared illuminator",
    body: "High-output infrared LEDs with an automatic light sensor, behind flush windows in the front glass. The room stays dark to people; the NoIR camera sees clearly.",
    provenance: "Third-party component · ORYN integration",
    status: "Prototype hardware",
  },
  {
    id: "compute",
    n: "04",
    label: "Compute",
    name: "Raspberry Pi 5 · cooler · storage",
    body: "A quad-core Raspberry Pi 5 with 4 GB of RAM runs the SensorDyme software. An active cooler keeps sustained inference from throttling; a 64 GB High Endurance microSD holds the software, configuration, and event log.",
    provenance: "Third-party components · ORYN integration",
    status: "Prototype hardware",
  },
  {
    id: "accelerator",
    n: "05",
    label: "Accelerator",
    name: "AI HAT+ · Hailo-8L",
    body: "A 13 TOPS neural processor stacked on the Pi over PCIe. The detection model runs here, on dedicated silicon, leaving the CPU free for tracking, rules, and reasoning.",
    provenance: "Third-party component · ORYN integration",
    status: "Verified on prototype",
  },
  {
    id: "alerts",
    n: "06",
    label: "Alerts",
    name: "Buzzer + status light",
    body: "A piezo buzzer wired to the Pi's GPIO sounds on site the moment a rule is confirmed — no network needed. A restrained light bar shows whether the unit is armed, alerting, or idle.",
    provenance: "Third-party components · ORYN integration",
    status: "Prototype hardware",
  },
  {
    id: "power",
    n: "07",
    label: "Power",
    name: "USB-C power input",
    body: "The unit is powered over USB-C; the prototype has run from a USB Power Delivery supply. Wall power draw has not been measured.",
    provenance: "Third-party components · ORYN integration",
    status: "Prototype hardware",
  },
  {
    id: "intelligence",
    n: "08",
    label: "Intelligence",
    name: "SensorDyme, on the device",
    body: "The hardware is the sensor; SensorDyme is the product. Frames from the camera become detections, tracked people, zones, and confirmed events — all on the unit itself.",
    provenance: "SensorDyme software",
    status: "In prototype software",
    link: { href: "/edge#pipeline-title", label: "See how it thinks" },
  },
];
