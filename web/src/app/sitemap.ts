import type { MetadataRoute } from "next";
import { industries } from "@/content/industries";
import { site } from "@/content/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes = ["", "/technology", "/edge", "/aero", "/intelligence", "/platform", "/solutions", "/about", "/contact", "/credits"];
  return [
    ...routes.map((r) => ({
      url: `${site.url}${r}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: r === "" ? 1 : r === "/credits" ? 0.2 : 0.8,
    })),
    ...industries.map((i) => ({
      url: `${site.url}/solutions/${i.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
