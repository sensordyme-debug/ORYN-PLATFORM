/**
 * Illustrative SensorDyme aerial-analysis demonstrations.
 *
 * The "analyzed" images were produced from the licensed sample photographs
 * with simple, documented techniques (see `scripts/README.md`):
 *  - agriculture: Excess Green (ExG) vegetation index on RGB pixels
 *  - flood / land cover: k-means color clustering + spatial rules + smoothing
 *  - construction: hand-annotated bounding boxes with sample scores
 *
 * Percentages are pixel fractions of each sample frame. None of these are
 * measurements of ORYN model accuracy.
 */

import type { StaticImageData } from "next/image";
import { media } from "@/content/media";
import agricultureAnalysis from "@/assets/intel/agriculture-analysis.jpg";
import floodAnalysis from "@/assets/intel/flood-analysis.jpg";
import landcoverAnalysis from "@/assets/intel/landcover-analysis.jpg";
import constructionAnalysis from "@/assets/intel/construction-analysis.jpg";

export type DemoId = "agriculture" | "construction" | "flood" | "landcover";

export type Demo = {
  id: DemoId;
  label: string;
  task: string;
  title: string;
  description: string;
  method: string;
  input: string;
  output: string;
  before: StaticImageData;
  after: StaticImageData;
  alt: string;
  /** Pixel size of the `after` image — overlay coordinate space. */
  size: { w: number; h: number };
  boxes?: { x: number; y: number; w: number; h: number; label: string; score: number }[];
  legend: { label: string; color: string; value?: string }[];
  credit: string;
  disclaimer: string;
};

// Annotated in the 2560 × 1919 source; scaled to the 2048-px analysis frame.
const k = 2048 / 2560;
const raw: [number, number, number, number, string, number][] = [
  [919, 849, 105, 156, "dozer", 0.91],
  [1150, 902, 170, 334, "dump_truck", 0.94],
  [1478, 635, 294, 273, "excavator", 0.89],
  [1634, 827, 135, 323, "dump_truck", 0.92],
  [1077, 160, 440, 656, "crusher_plant", 0.78],
  [1077, 1431, 391, 265, "dump_truck", 0.9],
  [1540, 1617, 260, 129, "vehicle", 0.86],
  [1929, 1389, 304, 136, "truck", 0.84],
  [1957, 1486, 433, 206, "excavator", 0.88],
  [0, 1508, 212, 190, "excavator", 0.62],
];
const constructionBoxes = raw.map(([x, y, w, h, label, score]) => ({ x: x * k, y: y * k, w: w * k, h: h * k, label, score }));

const DISCLAIMER =
  "Illustrative output generated on licensed sample imagery to demonstrate the interface. It is not a measure of ORYN model performance.";

export const demos: Demo[] = [
  {
    id: "agriculture",
    label: "Agriculture",
    task: "Vegetation analysis",
    title: "Vegetation vigor",
    description:
      "A per-pixel vegetation index reveals relative differences in canopy density — streaks, patches, and bare ground that are hard to judge by eye.",
    method: "Excess Green index (ExG)",
    input: "RGB aerial image",
    output: "Index map · 4 classes",
    before: media.intelAgriculture.src,
    after: agricultureAnalysis,
    alt: media.intelAgriculture.alt,
    size: { w: 2048, h: 1573 },
    legend: [
      { label: "High vigor", color: "#6fae4f", value: "26.4%" },
      { label: "Moderate", color: "#a8c95f", value: "19.6%" },
      { label: "Low vigor", color: "#e9b949", value: "18.7%" },
      { label: "Bare / sparse", color: "#9a6236", value: "35.3%" },
    ],
    credit: "Photo: Bernd Dittrich / Unsplash",
    disclaimer: DISCLAIMER,
  },
  {
    id: "construction",
    label: "Construction",
    task: "Object detection",
    title: "Equipment detection",
    description:
      "Detection identifies and locates equipment across a site, creating an at-a-glance record of where machines and materials are staged.",
    method: "Bounding-box detection",
    input: "RGB aerial image",
    output: "10 detections · 6 classes",
    before: media.intelConstruction.src,
    after: constructionAnalysis,
    alt: media.intelConstruction.alt,
    size: { w: 2048, h: 1535 },
    boxes: constructionBoxes,
    legend: [
      { label: "Excavator", color: "#ff6a2b", value: "3" },
      { label: "Dump truck", color: "#ff6a2b", value: "3" },
      { label: "Dozer", color: "#ff6a2b", value: "1" },
      { label: "Crusher plant", color: "#ff6a2b", value: "1" },
      { label: "Truck / vehicle", color: "#ff6a2b", value: "2" },
    ],
    credit: "Photo: Shane McLendon / Unsplash · boxes hand-annotated, scores are sample values",
    disclaimer: DISCLAIMER,
  },
  {
    id: "flood",
    label: "Flood extent",
    task: "Segmentation",
    title: "Floodwater extent",
    description:
      "Segmentation separates standing water from land, producing a boundary that can be measured and compared against later captures.",
    method: "Color clustering + spatial rules",
    input: "RGB aerial image (oblique)",
    output: "Water mask · boundary",
    before: media.intelFlood.src,
    after: floodAnalysis,
    alt: media.intelFlood.alt,
    size: { w: 2048, h: 1152 },
    legend: [
      { label: "Water (segmented)", color: "#5fb4d6", value: "63.7%" },
      { label: "Trees & hedgerows", color: "#3a3f43", value: "27.4%" },
      { label: "Dry pasture", color: "#6c7278", value: "8.9%" },
    ],
    credit: "Photo: Mathis Mauprivez / Unsplash · oblique view, so areas are not to scale",
    disclaimer: DISCLAIMER,
  },
  {
    id: "landcover",
    label: "Land cover",
    task: "Classification",
    title: "Land-cover classification",
    description:
      "Every pixel is assigned to a land-cover class — water, cropland, vegetation, bare soil, or built surface — the foundation for environmental change monitoring.",
    method: "k-means clustering · 5 classes",
    input: "RGB aerial image",
    output: "Class map · boundaries",
    before: media.intelLandcover.src,
    after: landcoverAnalysis,
    alt: media.intelLandcover.alt,
    size: { w: 2048, h: 1366 },
    legend: [
      { label: "Built surface", color: "#a39be0", value: "31.9%" },
      { label: "Trees & grass", color: "#8dbf63", value: "27.3%" },
      { label: "Water", color: "#5fb4d6", value: "16.2%" },
      { label: "Cropland", color: "#e9b949", value: "13.7%" },
      { label: "Bare soil", color: "#c08a5a", value: "10.9%" },
    ],
    credit: "Photo: Bernd Dittrich / Unsplash",
    disclaimer: DISCLAIMER,
  },
];
