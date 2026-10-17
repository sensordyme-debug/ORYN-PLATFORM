/**
 * SAMPLE DATA for the ORYN Command interactive preview.
 *
 * The basemap is real public-domain USGS orthoimagery (Grant County,
 * Washington). Everything layered on top — missions, aircraft, findings,
 * telemetry and processing states — is illustrative sample data created
 * to demonstrate the planned interface. None of it describes real
 * operations or real analysis of these properties.
 *
 * Coordinates are in basemap pixel space (3072 × 2048).
 */

export const MAP = {
  width: 3072,
  height: 2048,
  /** Geographic bounds of the basemap (Web Mercator tiles, zoom 14). */
  bounds: { north: 47.11499982620772, west: -120.08056640625, south: 46.99524110694595, east: -119.81689453125 },
  /** Ground distance per basemap pixel at this latitude (zoom 14). */
  metersPerPixel: 6.516,
  attribution: "Basemap: USGS The National Map — orthoimagery, shaded relief, 3DEP elevation (public domain)",
};

export type FindingSeverity = "attention" | "watch" | "info";

export type Finding = {
  id: string;
  title: string;
  category: string;
  severity: FindingSeverity;
  x: number;
  y: number;
  confidence: number;
  area?: string;
  note: string;
};

export type Mission = {
  id: string;
  name: string;
  type: "Agriculture" | "Environment" | "Construction";
  status: "Delivered" | "In review" | "Processing";
  aircraft: string;
  date: string;
  polygon: [number, number][];
  /** Lawn-mower survey path, generated from bounds. */
  path: { x0: number; y0: number; x1: number; y1: number; spacing: number; vertical?: boolean };
  view: { x: number; y: number; zoom: number };
  flight: { altitude: string; gsd: string; images: number; coverage: string; duration: string; sorties: number };
  pipeline: { label: string; state: "done" | "active" | "pending" }[];
  findings: Finding[];
};

const done = "done" as const;
const active = "active" as const;
const pending = "pending" as const;

export const missions: Mission[] = [
  {
    id: "M-0142",
    name: "Pivot survey — North block",
    type: "Agriculture",
    status: "Delivered",
    aircraft: "A1 · Unit 01",
    date: "Sample · Day 12",
    polygon: [
      [1500, 470],
      [2150, 470],
      [2150, 1040],
      [1500, 1040],
    ],
    path: { x0: 1520, y0: 490, x1: 2130, y1: 1020, spacing: 48 },
    view: { x: 1825, y: 755, zoom: 2.3 },
    flight: { altitude: "120 m AGL", gsd: "3.1 cm/px", images: 1842, coverage: "15.4 km²", duration: "2 h 05 min", sorties: 5 },
    pipeline: [
      { label: "Captured", state: done },
      { label: "Processed", state: done },
      { label: "Analyzed", state: done },
      { label: "Reviewed", state: done },
      { label: "Delivered", state: done },
    ],
    findings: [
      {
        id: "F-01",
        title: "Concentric banding",
        category: "Vegetation",
        severity: "attention",
        x: 1965,
        y: 830,
        confidence: 0.86,
        area: "9.2 ha",
        note: "Ring-shaped vigor variation across the northern half of the pivot. Pattern is consistent with uneven water distribution.",
      },
      {
        id: "F-02",
        title: "Lower canopy vigor",
        category: "Vegetation",
        severity: "watch",
        x: 1825,
        y: 800,
        confidence: 0.78,
        area: "4.6 ha",
        note: "Index values below the field average in the central rings. Recommend ground check.",
      },
      {
        id: "F-03",
        title: "Sparse cover",
        category: "Vegetation",
        severity: "watch",
        x: 1795,
        y: 640,
        confidence: 0.81,
        area: "6.1 ha",
        note: "Low vegetation fraction across the quarter section relative to adjacent fields.",
      },
      {
        id: "F-04",
        title: "Harvested / fallow",
        category: "Land use",
        severity: "info",
        x: 1585,
        y: 930,
        confidence: 0.93,
        note: "Classified as bare or harvested. Excluded from vigor scoring.",
      },
    ],
  },
  {
    id: "M-0143",
    name: "Coulee drainage survey",
    type: "Environment",
    status: "In review",
    aircraft: "A1 · Unit 02",
    date: "Sample · Day 14",
    polygon: [
      [1160, 1060],
      [1960, 1060],
      [1960, 1760],
      [1160, 1760],
    ],
    path: { x0: 1180, y0: 1080, x1: 1940, y1: 1740, spacing: 54, vertical: true },
    view: { x: 1560, y: 1410, zoom: 1.9 },
    flight: { altitude: "110 m AGL", gsd: "2.9 cm/px", images: 2210, coverage: "23.8 km²", duration: "2 h 40 min", sorties: 6 },
    pipeline: [
      { label: "Captured", state: done },
      { label: "Processed", state: done },
      { label: "Analyzed", state: done },
      { label: "Reviewed", state: active },
      { label: "Delivered", state: pending },
    ],
    findings: [
      {
        id: "F-11",
        title: "Standing water extent",
        category: "Water",
        severity: "watch",
        x: 1520,
        y: 1315,
        confidence: 0.91,
        area: "3.4 ha",
        note: "Open water segmented within the coulee basin. Boundary available as a map layer.",
      },
      {
        id: "F-12",
        title: "Channel water",
        category: "Water",
        severity: "info",
        x: 1320,
        y: 1540,
        confidence: 0.88,
        note: "Water present along the incised channel. Continuous for approx. 2.1 km.",
      },
      {
        id: "F-13",
        title: "Riparian vegetation",
        category: "Vegetation",
        severity: "info",
        x: 1610,
        y: 1150,
        confidence: 0.84,
        area: "7.9 ha",
        note: "Dense vegetation corridor following the drainage line.",
      },
      {
        id: "F-14",
        title: "Wetland vegetation",
        category: "Vegetation",
        severity: "watch",
        x: 1840,
        y: 1450,
        confidence: 0.72,
        area: "2.2 ha",
        note: "Mixed water and vegetation signature. Flagged for analyst confirmation.",
      },
    ],
  },
  {
    id: "M-0144",
    name: "Earthworks site survey",
    type: "Construction",
    status: "Processing",
    aircraft: "A1 · Unit 01",
    date: "Sample · Day 15",
    polygon: [
      [1140, 960],
      [1370, 960],
      [1370, 1320],
      [1140, 1320],
    ],
    path: { x0: 1150, y0: 970, x1: 1360, y1: 1310, spacing: 26 },
    view: { x: 1255, y: 1120, zoom: 4.2 },
    flight: { altitude: "90 m AGL", gsd: "2.4 cm/px", images: 640, coverage: "0.8 km²", duration: "34 min", sorties: 2 },
    pipeline: [
      { label: "Captured", state: done },
      { label: "Processed", state: active },
      { label: "Analyzed", state: pending },
      { label: "Reviewed", state: pending },
      { label: "Delivered", state: pending },
    ],
    findings: [
      {
        id: "F-21",
        title: "Stockpile cluster",
        category: "Materials",
        severity: "info",
        x: 1282,
        y: 1062,
        confidence: 0.83,
        note: "Bright material piles detected. Volume estimation requires a processed surface model.",
      },
      {
        id: "F-22",
        title: "Graded pad",
        category: "Earthworks",
        severity: "info",
        x: 1205,
        y: 1030,
        confidence: 0.79,
        area: "1.1 ha",
        note: "Leveled surface consistent with site grading.",
      },
      {
        id: "F-23",
        title: "Disturbed ground",
        category: "Earthworks",
        severity: "watch",
        x: 1270,
        y: 1262,
        confidence: 0.74,
        area: "0.9 ha",
        note: "Recently disturbed area outside the main site footprint.",
      },
    ],
  },
  {
    id: "M-0145",
    name: "River corridor mapping",
    type: "Environment",
    status: "Delivered",
    aircraft: "A1 · Unit 03",
    date: "Sample · Day 9",
    polygon: [
      [430, 160],
      [900, 160],
      [900, 1950],
      [430, 1950],
    ],
    path: { x0: 450, y0: 180, x1: 880, y1: 1930, spacing: 52, vertical: true },
    view: { x: 640, y: 900, zoom: 1.5 },
    flight: { altitude: "120 m AGL", gsd: "3.1 cm/px", images: 3120, coverage: "36.1 km²", duration: "3 h 30 min", sorties: 8 },
    pipeline: [
      { label: "Captured", state: done },
      { label: "Processed", state: done },
      { label: "Analyzed", state: done },
      { label: "Reviewed", state: done },
      { label: "Delivered", state: done },
    ],
    findings: [
      {
        id: "F-31",
        title: "Island shoreline",
        category: "Water",
        severity: "info",
        x: 560,
        y: 380,
        confidence: 0.9,
        note: "Shoreline delineated for comparison against future captures.",
      },
      {
        id: "F-32",
        title: "Bank change candidate",
        category: "Change",
        severity: "watch",
        x: 770,
        y: 1010,
        confidence: 0.69,
        note: "Low-confidence boundary difference. Requires a second capture to confirm.",
      },
      {
        id: "F-33",
        title: "Side channel",
        category: "Water",
        severity: "info",
        x: 860,
        y: 1640,
        confidence: 0.82,
        note: "Secondary channel mapped along the eastern bank.",
      },
    ],
  },
];

export const fleet = [
  { unit: "A1 · Unit 01", state: "Ready", battery: 96, link: "Nominal" },
  { unit: "A1 · Unit 02", state: "Charging", battery: 54, link: "Docked" },
  { unit: "A1 · Unit 03", state: "Maintenance", battery: 0, link: "Offline" },
] as const;
