/**
 * Industry solutions. Copy describes ORYN's intended capabilities —
 * these services are in development and not yet commercially deployed.
 */

import { media, type MediaImage } from "@/content/media";

export type Industry = {
  slug: string;
  index: string;
  name: string;
  headline: string;
  summary: string;
  image: MediaImage;
  secondaryImage: MediaImage;
  /** Short framing shown on the solution page hero. */
  intro: string;
  challenge: { title: string; body: string };
  outputs: { title: string; body: string }[];
  questions: string[];
  /** Which illustrative analysis demo best represents this industry. */
  demo: "agriculture" | "construction" | "flood" | "landcover";
  status: string;
};

export const industries: Industry[] = [
  {
    slug: "agriculture",
    index: "01",
    name: "Agriculture",
    headline: "See beyond the field.",
    summary:
      "Repeatable aerial surveys designed to reveal crop vigor, irrigation patterns, and emerging problem areas — before they are visible from the ground.",
    image: media.indAgriculture,
    secondaryImage: media.agriculture2,
    intro:
      "Our vision for agriculture is simple: give growers a reliable, field-by-field picture of what is happening across their land — delivered as plain-language findings, not raw imagery.",
    challenge: {
      title: "Large areas, limited time.",
      body: "Walking every acre is impractical. Problems like irrigation failures, pest pressure, or nutrient stress often spread before they are noticed. Satellite data helps, but resolution, cloud cover, and revisit timing limit what it can show at the scale of a single field.",
    },
    outputs: [
      {
        title: "Vegetation vigor mapping",
        body: "Index-based maps that highlight relative differences in canopy health across a field.",
      },
      {
        title: "Irrigation pattern review",
        body: "Identification of dry or saturated zones that may indicate distribution problems.",
      },
      {
        title: "Change over time",
        body: "Side-by-side comparison between inspections to show where conditions are improving or declining.",
      },
      {
        title: "Field reports",
        body: "Clear summaries with annotated maps and prioritized areas to check on the ground.",
      },
    ],
    questions: [
      "Which parts of this field are under stress?",
      "Is my irrigation reaching every section?",
      "What changed since the last inspection?",
    ],
    demo: "agriculture",
    status: "In development — agricultural survey workflows are an initial focus area.",
  },
  {
    slug: "environment",
    index: "02",
    name: "Environment",
    headline: "Understand the changing earth.",
    summary:
      "Aerial observation for land cover, shorelines, wetlands, and habitat — structured so change can be measured consistently over seasons and years.",
    image: media.indEnvironment,
    secondaryImage: media.environment2,
    intro:
      "Environmental work depends on consistent, comparable observation. ORYN is designing survey and analysis workflows that make repeat monitoring practical for consultants, researchers, and land managers.",
    challenge: {
      title: "Change is gradual — until it isn't.",
      body: "Erosion, vegetation loss, and shifting water boundaries can be subtle between visits. Without consistent capture conditions and georeferenced comparisons, it is difficult to quantify change with confidence.",
    },
    outputs: [
      {
        title: "Land-cover classification",
        body: "Segmentation of imagery into classes such as water, vegetation, bare ground, and built surfaces.",
      },
      {
        title: "Shoreline & wetland mapping",
        body: "Delineation of water boundaries for comparison across surveys.",
      },
      {
        title: "Temporal change detection",
        body: "Highlighting where land cover has changed between captures of the same area.",
      },
      {
        title: "Monitoring records",
        body: "Organized, georeferenced survey archives that support long-term studies.",
      },
    ],
    questions: [
      "How much has this shoreline moved?",
      "Where is vegetation cover changing?",
      "What is the extent of standing water after a storm?",
    ],
    demo: "landcover",
    status: "In development — environmental monitoring workflows are being designed.",
  },
  {
    slug: "construction",
    index: "03",
    name: "Construction",
    headline: "Every site. In sight.",
    summary:
      "Scheduled aerial capture of active sites for progress tracking, equipment visibility, and up-to-date site maps that the whole team can understand.",
    image: media.indConstruction,
    secondaryImage: media.construction2,
    intro:
      "Construction teams need a shared, current view of the site. ORYN is building toward routine aerial capture that turns into maps, progress comparisons, and simple visual updates.",
    challenge: {
      title: "Sites change every day.",
      body: "Large sites are hard to see as a whole. Progress reports often rely on scattered photos and walk-throughs, making it difficult for owners, managers, and subcontractors to share a single accurate picture.",
    },
    outputs: [
      {
        title: "Site maps",
        body: "Stitched, georeferenced orthomosaic maps from each capture.",
      },
      {
        title: "Progress comparison",
        body: "Visual comparison between captures to document what changed and when.",
      },
      {
        title: "Equipment & material visibility",
        body: "Detection of equipment and materials to support site awareness.",
      },
      {
        title: "Stakeholder updates",
        body: "Shareable summaries that non-technical stakeholders can read in minutes.",
      },
    ],
    questions: [
      "How far has earthwork progressed this week?",
      "Where is equipment staged across the site?",
      "What does the site look like today, from above?",
    ],
    demo: "construction",
    status: "In development — construction capture and comparison workflows are planned.",
  },
  {
    slug: "disaster-response",
    index: "04",
    name: "Disaster Response",
    headline: "Clarity when it matters most.",
    summary:
      "Rapid aerial assessment designed to help response and recovery teams understand the extent of floods, fires, and storm damage.",
    image: media.indDisaster,
    secondaryImage: media.disaster2,
    intro:
      "After a disaster, the first question is often the hardest to answer: how large is the affected area? ORYN is exploring how aerial capture and automated analysis can support assessment teams with faster situational understanding.",
    challenge: {
      title: "Access is limited. Time is short.",
      body: "Damaged roads and hazardous conditions make ground assessment slow. Decision-makers need an overview of affected areas quickly — while respecting the people and communities involved.",
    },
    outputs: [
      {
        title: "Flood extent mapping",
        body: "Segmentation of standing water to estimate inundated areas.",
      },
      {
        title: "Damage overview",
        body: "Georeferenced imagery to support prioritization by trained assessment teams.",
      },
      {
        title: "Before-and-after comparison",
        body: "Change detection against prior imagery where available.",
      },
      {
        title: "Shareable situation maps",
        body: "Simple map products intended for coordination between teams.",
      },
    ],
    questions: [
      "Which areas are under water right now?",
      "Which access routes appear passable?",
      "How has the affected area changed since yesterday?",
    ],
    demo: "flood",
    status:
      "Research & development — any response deployment would operate in coordination with, and under the direction of, authorized agencies.",
  },
  {
    slug: "search-and-rescue",
    index: "05",
    name: "Search & Rescue",
    headline: "A wider field of view.",
    summary:
      "An area of active research: how aerial imagery and computer vision might help trained search teams cover difficult terrain more systematically.",
    image: media.indSar,
    secondaryImage: media.sar2,
    intro:
      "Search and rescue is demanding, high-stakes work led by trained professionals. ORYN's interest is in supporting tools — systematic aerial coverage and assisted image review — not in replacing the people who do this work.",
    challenge: {
      title: "Vast terrain. Every minute counts.",
      body: "Searches often span forests, mountains, and water where visibility is poor and ground movement is slow. Reviewing large volumes of aerial imagery by eye is exhausting and error-prone.",
    },
    outputs: [
      {
        title: "Systematic coverage planning",
        body: "Grid-based flight planning concepts to document which areas have been imaged.",
      },
      {
        title: "Assisted image review",
        body: "Research into flagging imagery for human reviewers to examine first.",
      },
      {
        title: "Terrain context",
        body: "Maps combining imagery and terrain to support search planning.",
      },
      {
        title: "Coverage records",
        body: "Clear records of what has been searched, and when.",
      },
    ],
    questions: [
      "Which sectors have been covered from the air?",
      "Which images should a reviewer look at first?",
      "What does the terrain look like in this sector?",
    ],
    demo: "landcover",
    status:
      "Area of research — not a validated emergency-response capability. Any future use would support, and be directed by, authorized SAR organizations.",
  },
];

export function getIndustry(slug: string) {
  return industries.find((i) => i.slug === slug);
}
