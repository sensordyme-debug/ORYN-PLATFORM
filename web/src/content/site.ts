/**
 * Global site configuration.
 * Values that depend on deployment come from environment variables —
 * see .env.example and README.md.
 */

function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export const site = {
  name: "ORYN",
  tagline: "Intelligent Physical Systems",
  description:
    "ORYN builds intelligent physical systems. SensorDyme, our perception and reasoning layer, powers SensorDyme Edge — on-device intelligent sensing — and SensorDyme Aero, our aerial development platform.",
  url: resolveSiteUrl(),
  /** Optional public inquiry address. Leave unset rather than inventing one. */
  contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL || null,
  /**
   * Where "Sign in" points: an external platform deployment when
   * NEXT_PUBLIC_COMMAND_URL is set, the built-in platform when
   * NEXT_PUBLIC_PLATFORM_ENABLED=true, otherwise hidden.
   */
  commandUrl: process.env.NEXT_PUBLIC_COMMAND_URL || (process.env.NEXT_PUBLIC_PLATFORM_ENABLED === "true" ? "/login" : null),
  stageNote:
    "ORYN is an early-stage company. Products and capabilities described on this site are in development unless stated otherwise.",
} as const;

export type NavItem = { label: string; href: string; description?: string; children?: NavItem[] };

/** ORYN → SensorDyme (intelligence layer) → Edge | Aero. */
export const sensorDymeNav: NavItem[] = [
  { label: "SensorDyme Edge", href: "/edge", description: "Intelligent sensing, on the device" },
  { label: "SensorDyme Aero", href: "/aero", description: "Aerial development platform" },
  { label: "Aerial analysis", href: "/intelligence", description: "Vision & geospatial analysis of aerial imagery" },
];

export const primaryNav: NavItem[] = [
  { label: "SensorDyme", href: "/#sensordyme", children: sensorDymeNav },
  { label: "Technology", href: "/technology" },
  { label: "Platform", href: "/platform" },
  { label: "Solutions", href: "/solutions" },
  { label: "About", href: "/about" },
];

export const footerNav: { title: string; items: NavItem[] }[] = [
  {
    title: "Products",
    items: [
      { label: "SensorDyme Edge", href: "/edge" },
      { label: "SensorDyme Aero", href: "/aero" },
      { label: "Aerial analysis", href: "/intelligence" },
      { label: "ORYN Command", href: "/platform#command" },
      { label: "ORYN Portal", href: "/platform#portal" },
    ],
  },
  {
    title: "Solutions",
    items: [
      { label: "Agriculture", href: "/solutions/agriculture" },
      { label: "Environment", href: "/solutions/environment" },
      { label: "Construction", href: "/solutions/construction" },
      { label: "Disaster Response", href: "/solutions/disaster-response" },
      { label: "Search & Rescue", href: "/solutions/search-and-rescue" },
    ],
  },
  {
    title: "Company",
    items: [
      { label: "Technology", href: "/technology" },
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Talk to the team", href: "/contact?intent=demo" },
      { label: "Media credits", href: "/credits" },
    ],
  },
];
