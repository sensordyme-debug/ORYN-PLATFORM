/** Technology architecture content. Status labels reflect current development stage. */

export type Stage = {
  id: string;
  index: string;
  name: string;
  short: string;
  body: string;
  inputs: string[];
  outputs: string[];
  runsOn: string;
  status: string;
};

export const pipeline: Stage[] = [
  {
    id: "acquisition",
    index: "01",
    name: "Aerial data acquisition",
    short: "Plan, fly, capture",
    body: "Missions are planned as repeatable survey patterns. The aircraft captures overlapping imagery with the position, attitude, and timing metadata needed for accurate mapping.",
    inputs: ["Area of interest", "Mission parameters", "Airspace & weather checks"],
    outputs: ["Raw imagery", "Flight logs", "Capture metadata"],
    runsOn: "Aircraft",
    status: "In development",
  },
  {
    id: "processing",
    index: "02",
    name: "Sensor processing",
    short: "Calibrate, align, stitch",
    body: "Imagery is checked for quality, aligned using its metadata, and stitched into georeferenced map products such as orthomosaics.",
    inputs: ["Raw imagery", "Capture metadata"],
    outputs: ["Orthomosaic", "Quality report", "Image index"],
    runsOn: "Cloud",
    status: "In development",
  },
  {
    id: "vision",
    index: "03",
    name: "Computer vision",
    short: "Detect, segment, classify",
    body: "Models analyze imagery to detect objects, segment regions such as water or vegetation, and classify land cover — producing candidate findings with confidence scores.",
    inputs: ["Orthomosaic", "Image tiles"],
    outputs: ["Detections", "Segmentation masks", "Confidence scores"],
    runsOn: "Cloud · Edge (future)",
    status: "Research & development",
  },
  {
    id: "geospatial",
    index: "04",
    name: "Geospatial intelligence",
    short: "Locate, measure, compare",
    body: "Results are placed on the map, measured in real-world units, and compared against previous captures to surface what has changed.",
    inputs: ["Detections", "Masks", "Prior surveys"],
    outputs: ["Map layers", "Measurements", "Change records"],
    runsOn: "Cloud",
    status: "Research & development",
  },
  {
    id: "review",
    index: "05",
    name: "Human review",
    short: "Verify before delivery",
    body: "Trained analysts review automated findings, confirm or reject them, and add context. Low-confidence results are always routed to a person.",
    inputs: ["Candidate findings"],
    outputs: ["Verified findings", "Analyst notes"],
    runsOn: "ORYN Command",
    status: "Planned",
  },
  {
    id: "delivery",
    index: "06",
    name: "Customer delivery",
    short: "Clear answers",
    body: "Customers receive findings in plain language through ORYN Portal — with maps, reports, and exports for the tools they already use.",
    inputs: ["Verified findings", "Map products"],
    outputs: ["Portal dashboard", "Reports", "Data exports"],
    runsOn: "ORYN Portal",
    status: "Planned",
  },
];

export const pillars = [
  {
    id: "modular-hardware",
    name: "Modular hardware",
    body: "Aircraft built from well-defined modules — airframe, propulsion, power, flight control, compute, and payload — so each can be improved or replaced independently.",
    status: "In development",
  },
  {
    id: "edge-ai",
    name: "Edge AI",
    body: "Inference on the device itself. It runs today on the SensorDyme Edge prototype; moving selected inference onboard the aircraft is research for Aero.",
    status: "Prototype · Research",
  },
  {
    id: "geospatial",
    name: "Geospatial intelligence",
    body: "Every result tied to a location and a time, so it can be measured, mapped, and compared across surveys.",
    status: "Research & development",
  },
  {
    id: "fleet",
    name: "Fleet management",
    body: "ORYN Command is designed to coordinate aircraft, missions, maintenance, and data processing from a single operational view.",
    status: "Planned",
  },
  {
    id: "managed",
    name: "Managed operations",
    body: "ORYN plans, flies, processes, and reviews — so customers receive results without operating drones themselves.",
    status: "Planned service model",
  },
];

export const principles = [
  {
    title: "Human in the loop",
    body: "Automated analysis produces candidates. People decide what is reported.",
  },
  {
    title: "Measured claims",
    body: "We publish performance figures only after they are validated through testing.",
  },
  {
    title: "Authorized operations",
    body: "Missions are intended to be conducted in accordance with applicable aviation regulations, such as FAA Part 107 in the United States, and with landowner permission.",
  },
  {
    title: "Data stewardship",
    body: "Customer imagery and findings belong to the customer. Privacy is a design requirement, not an afterthought.",
  },
];

/** Where SensorDyme runs. Status labels match the product pages. */
export const platforms = [
  {
    id: "edge",
    name: "SensorDyme Edge",
    role: "Physical sensing + local intelligence",
    body: "A fixed unit that sees, tracks, and confirms events on the device itself — and acts in the room.",
    status: "Working prototype",
    href: "/edge",
  },
  {
    id: "aero",
    name: "SensorDyme Aero",
    role: "Aerial sensing · development platform",
    body: "A modular aircraft being developed to give the same intelligence altitude, reach, and mobility.",
    status: "In development",
    href: "/aero",
  },
  {
    id: "intelligence",
    name: "SensorDyme intelligence",
    role: "Perceive · track · context · verify · act",
    body: "The shared layer: detection, tracking, zones, temporal verification, and rules — specialized models directed by a deterministic safety engine.",
    status: "In prototype software",
    href: "/edge#pipeline-title",
  },
  {
    id: "systems",
    name: "ORYN Command & Portal",
    role: "Operations and delivery",
    body: "Software for running aerial missions and delivering findings — Command for ORYN's operators, Portal for customers.",
    status: "Planned",
    href: "/platform",
  },
];

/** The on-device loop on SensorDyme Edge (device software + Jupiter design notes). */
export const edgeLoop = [
  { label: "Camera", body: "Frames captured on the device" },
  { label: "Detection", body: "DAMO-YOLO on the Hailo-8L" },
  { label: "Tracking", body: "The same person, across frames" },
  { label: "Context", body: "Named zones, judged at the feet" },
  { label: "Verification", body: "Persistence, frame count, smoothed confidence" },
  { label: "Rules", body: "Deterministic safety engine" },
  { label: "Action", body: "Buzzer and local event log" },
];
