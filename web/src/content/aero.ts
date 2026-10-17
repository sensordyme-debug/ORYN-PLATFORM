/**
 * SensorDyme Aero — content for the aerial product page.
 *
 * IMPORTANT: specifications are intentionally unset. Do not publish
 * figures until they have been validated through testing. Set a value
 * (string) to display it; `null` renders as "To be established".
 */

export type Spec = { label: string; value: string | null; note?: string };

export const a1Specs: Spec[] = [
  { label: "Configuration", value: "Multirotor development platform" },
  { label: "Flight endurance", value: null },
  { label: "Payload capacity", value: null },
  { label: "Maximum takeoff weight", value: null },
  { label: "Operating range", value: null },
  { label: "Wind tolerance", value: null },
  { label: "Ingress protection", value: null },
  { label: "Sensor payloads", value: null, note: "See sensor compatibility direction" },
  { label: "Onboard compute", value: null },
  { label: "Certifications", value: null, note: "None claimed at this stage" },
];

export type Module = {
  id: string;
  name: string;
  summary: string;
  detail: string;
};

export const a1Modules: Module[] = [
  {
    id: "airframe",
    name: "Airframe",
    summary: "Rigid, serviceable structure",
    detail:
      "A frame designed around access and replaceability — arms, mounts, and covers that can be swapped without rebuilding the aircraft.",
  },
  {
    id: "propulsion",
    name: "Propulsion",
    summary: "Motors, ESCs, propellers",
    detail:
      "Brushless propulsion selected and characterized on the bench before integration, with thrust margins defined by the payloads we intend to carry.",
  },
  {
    id: "power",
    name: "Power",
    summary: "Battery & distribution",
    detail:
      "Isolated power distribution for propulsion, avionics, and payload, with monitoring designed in from the start.",
  },
  {
    id: "flight",
    name: "Flight control",
    summary: "Autopilot & navigation sensors",
    detail:
      "A dedicated flight controller handles stabilization and navigation independently of mission software, keeping the safety-critical loop simple.",
  },
  {
    id: "compute",
    name: "Edge compute",
    summary: "Companion computer",
    detail:
      "A separate companion computer for mission logic, capture management, and — over time — onboard inference.",
  },
  {
    id: "payload",
    name: "Sensor payload",
    summary: "Interchangeable mount",
    detail:
      "A standardized mechanical and electrical interface intended to accept different imaging sensors as the platform matures.",
  },
];

export const sensorDirection = [
  { name: "RGB imaging", status: "Initial focus", body: "High-resolution visible imagery for mapping, detection, and visual inspection." },
  { name: "Multispectral", status: "Planned evaluation", body: "Additional spectral bands for vegetation analysis beyond what visible light reveals." },
  { name: "Thermal", status: "Planned evaluation", body: "Radiometric or relative thermal imaging for water, heat, and night-time observation." },
  { name: "LiDAR", status: "Exploratory", body: "Active ranging for terrain and structure measurement under vegetation." },
];

export const flightControlChain = [
  { id: "sensors", label: "Navigation sensors", body: "IMU · barometer · magnetometer · GNSS" },
  { id: "estimation", label: "State estimation", body: "Sensor fusion for attitude, position, velocity" },
  { id: "control", label: "Control loops", body: "Attitude & position controllers" },
  { id: "mixer", label: "Motor mixing", body: "Commands mapped to individual motors" },
  { id: "esc", label: "ESCs & motors", body: "Propulsion output" },
];

export const companionChain = [
  { id: "mission", label: "Mission logic", body: "Survey patterns · waypoints · capture triggers" },
  { id: "capture", label: "Capture & metadata", body: "Images tagged with position, attitude, time" },
  { id: "edge", label: "Edge inference", body: "Onboard models (future)" },
  { id: "link", label: "Data link", body: "Telemetry & status to ORYN Command" },
];

export type Phase = { id: string; label: string; title: string; body: string; state: "complete" | "current" | "next" | "future" };

export const roadmap: Phase[] = [
  {
    id: "p0",
    label: "Phase 0",
    title: "Research & requirements",
    body: "Defining mission profiles, sensing needs, and operating constraints across target industries.",
    state: "current",
  },
  {
    id: "p1",
    label: "Phase 1",
    title: "A1 development platform",
    body: "Building and bench-testing the first integrated airframe, propulsion, and flight-control stack.",
    state: "current",
  },
  {
    id: "p2",
    label: "Phase 2",
    title: "Integrated sensing & compute",
    body: "Payload interface, capture pipeline, and companion computer integration.",
    state: "next",
  },
  {
    id: "p3",
    label: "Phase 3",
    title: "Controlled flight testing",
    body: "Structured test campaigns to characterize performance — the basis for any published specification.",
    state: "future",
  },
  {
    id: "p4",
    label: "Phase 4",
    title: "Managed service pilots",
    body: "Limited pilot programs with early partners, operated within applicable aviation regulations.",
    state: "future",
  },
];

/* ── SensorDyme Aero — interactive system explorer ───────────── */

export type AeroSystemId = "exterior" | "airframe" | "propulsion" | "power" | "flight" | "compute" | "payload" | "link" | "intelligence";

/** Who is responsible for each layer — so third-party parts are never presented as ours. */
export type Provenance = "ORYN architecture" | "Third-party components · ORYN integration" | "SensorDyme software";

export type AeroSystem = {
  id: AeroSystemId;
  n: string;
  label: string;
  name: string;
  body: string;
  provenance: Provenance;
  status: string;
  /** Matching part of the 2D concept drawing, used when WebGL is unavailable. */
  blueprint?: "airframe" | "propulsion" | "power" | "flight" | "compute" | "payload";
};

export const aeroSystems: AeroSystem[] = [
  {
    id: "exterior",
    n: "00",
    label: "Exterior",
    name: "SensorDyme Aero",
    body: "A modular multirotor development platform — the aircraft we are building to give SensorDyme intelligence altitude and mobility. Drag to rotate; select a system to look inside.",
    provenance: "ORYN architecture",
    status: "Concept · in development",
  },
  {
    id: "airframe",
    n: "01",
    label: "Airframe",
    name: "Rigid, serviceable structure",
    body: "A central fuselage derived from the ORYN mark, four arms, and landing gear — designed around access and replaceability, so an arm or cover can be swapped without rebuilding the aircraft.",
    provenance: "ORYN architecture",
    status: "Concept design",
    blueprint: "airframe",
  },
  {
    id: "propulsion",
    n: "02",
    label: "Propulsion",
    name: "Motor + propeller system",
    body: "Brushless motors, ESCs, and propellers, selected and characterized on the bench before integration — with thrust margins defined by the payloads we intend to carry.",
    provenance: "Third-party components · ORYN integration",
    status: "Bench integration · in progress",
    blueprint: "propulsion",
  },
  {
    id: "power",
    n: "03",
    label: "Power",
    name: "Battery + power architecture",
    body: "Isolated power distribution for propulsion, avionics, and payload, with monitoring designed in from the start. Battery chemistry and capacity are not yet established.",
    provenance: "Third-party components · ORYN integration",
    status: "In development",
    blueprint: "power",
  },
  {
    id: "flight",
    n: "04",
    label: "Navigation",
    name: "Flight control + inertial sensing",
    body: "A dedicated flight controller runs stabilization and navigation independently of mission software, fusing IMU, barometer, magnetometer, and GNSS. The safety-critical loop stays simple and isolated.",
    provenance: "Third-party components · ORYN integration",
    status: "Planned architecture · selection in progress",
    blueprint: "flight",
  },
  {
    id: "compute",
    n: "05",
    label: "Compute",
    name: "Edge AI companion computer",
    body: "A separate companion computer for mission logic and capture — and the place SensorDyme's perception stack is intended to run onboard. Hardware for Aero has not been selected.",
    provenance: "Third-party components · ORYN integration",
    status: "Planned · Phase 2",
    blueprint: "compute",
  },
  {
    id: "payload",
    n: "06",
    label: "Vision",
    name: "Stabilized imaging payload",
    body: "A gimbal-stabilized camera on a standardized mount, intended to accept different sensors as the platform matures. High-resolution RGB is the initial focus; thermal and multispectral are planned evaluations.",
    provenance: "Third-party components · ORYN integration",
    status: "Planned · Phase 2",
    blueprint: "payload",
  },
  {
    id: "link",
    n: "07",
    label: "Communication",
    name: "Telemetry + data link",
    body: "Status and telemetry to ORYN Command over a narrow, well-defined interface. Link technology and range have not been selected or measured.",
    provenance: "Third-party components · ORYN integration",
    status: "Planned",
  },
  {
    id: "intelligence",
    n: "08",
    label: "Intelligence",
    name: "SensorDyme, airborne",
    body: "The same idea as SensorDyme Edge — perceive, track, add context, verify before alerting — given a moving, elevated point of view. This is the direction of the platform, not a demonstrated capability.",
    provenance: "SensorDyme software",
    status: "Concept · research",
  },
];
