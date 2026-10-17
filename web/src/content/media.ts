/**
 * Media registry. Images are statically imported so Next.js can generate
 * responsive sizes, blur placeholders and immutable URLs.
 * Sources & licenses: MEDIA_CREDITS.md and /credits.
 */

import type { StaticImageData } from "next/image";

import aboutEarth from "@/assets/img/about-earth.jpg";
import aboutWorkshop from "@/assets/img/about-workshop.jpg";
import agriculture2 from "@/assets/img/agriculture-2.jpg";
import construction2 from "@/assets/img/construction-2.jpg";
import contact from "@/assets/img/contact.jpg";
import disaster2 from "@/assets/img/disaster-2.jpg";
import environment2 from "@/assets/img/environment-2.jpg";
import indAgriculture from "@/assets/img/ind-agriculture.jpg";
import indConstruction from "@/assets/img/ind-construction.jpg";
import indDisaster from "@/assets/img/ind-disaster.jpg";
import indEnvironment from "@/assets/img/ind-environment.jpg";
import indSar from "@/assets/img/ind-sar.jpg";
import intelAgriculture from "@/assets/img/intel-agriculture.jpg";
import intelConstruction from "@/assets/img/intel-construction.jpg";
import intelFlood from "@/assets/img/intel-flood.jpg";
import intelLandcover from "@/assets/img/intel-landcover.jpg";
import sar2 from "@/assets/img/sar-2.jpg";
import stepAnalyze from "@/assets/img/step-analyze.jpg";
import stepDeliver from "@/assets/img/step-deliver.jpg";
import stepDeploy from "@/assets/img/step-deploy.jpg";
import stepRequest from "@/assets/img/step-request.jpg";
import techHero from "@/assets/img/tech-hero.jpg";
import heroPoster from "@/assets/img/hero-poster.jpg";
import heroMobilePoster from "@/assets/img/hero-mobile-poster.jpg";
import flyoverPoster from "@/assets/img/flyover-poster.jpg";

export type MediaImage = { src: StaticImageData; alt: string; focal: string; credit: string };

export const media = {
  aboutEarth: { src: aboutEarth, alt: "High-altitude view of the Earth's curvature over a coastline of lakes and forests, with a band of clouds and deep blue sky above.", focal: "50% 60%", credit: "Photo: Dembee Tsogoo / Unsplash" },
  aboutWorkshop: { src: aboutWorkshop, alt: "Engineering workbench with a bench power supply, soldering station, helping hands, wire spools and FPV drone parts.", focal: "50% 50%", credit: "Photo: ThisisEngineering / Unsplash" },
  agriculture2: { src: agriculture2, alt: "Abstract top-down view of parallel vineyard rows catching low golden light.", focal: "50% 50%", credit: "Photo: Erik Fabian / Unsplash" },
  construction2: { src: construction2, alt: "Top-down aerial of an excavator digging a long trench beside spoil piles in warm evening light.", focal: "30% 50%", credit: "Photo: Built Robotics / Unsplash" },
  contact: { src: contact, alt: "Night aerial of a vast city grid of lights stretching to the horizon under a deep blue sky.", focal: "50% 70%", credit: "Photo: Benni Talent / Unsplash" },
  disaster2: { src: disaster2, alt: "Dusk aerial over a river valley with overflowing floodwater spreading into forest and fields under a stormy sky.", focal: "50% 55%", credit: "Photo: Mathis Mauprivez / Unsplash" },
  environment2: { src: environment2, alt: "Top-down aerial of a braided river delta with branching channels cutting through pale sediment.", focal: "50% 50%", credit: "Photo: Cosmin Andrei Buzamat / Unsplash" },
  indAgriculture: { src: indAgriculture, alt: "Cinematic oblique aerial of rolling farmland and hedgerows at golden hour, with long shadows across green fields.", focal: "50% 60%", credit: "Photo: Bernd Dittrich / Unsplash" },
  indConstruction: { src: indConstruction, alt: "Top-down aerial of a large waterfront construction site with a circular shaft excavation, cranes, and materials yards at dusk.", focal: "50% 45%", credit: "Photo: Nabeel Hussain / Unsplash" },
  indDisaster: { src: indDisaster, alt: "Aerial view of a mountainside of standing burned trees after a wildfire, with fresh green regrowth beginning on the slope.", focal: "50% 50%", credit: "Photo: Luke Miller / Unsplash" },
  indEnvironment: { src: indEnvironment, alt: "Aerial view of a river meandering in a tight horseshoe bend through dense forest.", focal: "50% 50%", credit: "Photo: Ivars Utināns / Unsplash" },
  indSar: { src: indSar, alt: "Aerial view of a rugged mountain ridge in mist, with a lone hiker in a yellow jacket standing small on the rocky summit.", focal: "50% 55%", credit: "Photo: Joshua Earle / Unsplash" },
  intelAgriculture: { src: intelAgriculture, alt: "Straight-down aerial view of a patchwork of crop fields: dense green wheat, lighter variable-health strips, pale stubble and bare tan soil divided by farm tracks.", focal: "50% 50%", credit: "Photo: Bernd Dittrich / Unsplash" },
  intelConstruction: { src: intelConstruction, alt: "Top-down aerial view of an earthworks site with a bulldozer, excavators, articulated dump trucks, a mobile crushing plant and service trucks on brown soil.", focal: "50% 50%", credit: "Photo: Shane McLendon / Unsplash" },
  intelFlood: { src: intelFlood, alt: "High-oblique aerial view of flooded farmland: hedgerows and tree lines standing in floodwater around a raised green pasture and a small farmstead.", focal: "50% 50%", credit: "Photo: Mathis Mauprivez / Unsplash" },
  intelLandcover: { src: intelLandcover, alt: "Straight-down aerial view of mixed land cover: yellow rapeseed and green wheat fields, a bare-soil strip, a tree-lined river with a cargo barge, and a dense town of red-roofed buildings and roads.", focal: "50% 50%", credit: "Photo: Bernd Dittrich / Unsplash" },
  sar2: { src: sar2, alt: "Aerial of a dense, dark conifer forest canopy with a single bright golden tree standing out.", focal: "65% 35%", credit: "Photo: Joss Woodhead / Unsplash" },
  stepAnalyze: { src: stepAnalyze, alt: "Dark workspace with a monitor and laptop glowing with imagery and data in an unlit room.", focal: "35% 50%", credit: "Photo: Sou Jest / Unsplash" },
  stepDeliver: { src: stepDeliver, alt: "Over-the-shoulder view of a field operator reviewing a live aerial map on a tablet mounted to a drone controller.", focal: "45% 55%", credit: "Photo: Tamas Pap / Unsplash" },
  stepDeploy: { src: stepDeploy, alt: "Hexacopter drone with a gimbal camera flying low over a dry field and dirt track under a blue sky with clouds.", focal: "35% 45%", credit: "Photo: Daniele Fiungo / Unsplash" },
  stepRequest: { src: stepRequest, alt: "High-angle view of a construction worker in a hard hat and hi-vis vest inspecting a rebar grid on a building site.", focal: "40% 55%", credit: "Photo: Toni Reed / Unsplash" },
  techHero: { src: techHero, alt: "Silhouette of a quadcopter drone against a dramatic backlit cloudy sky above dark water.", focal: "70% 40%", credit: "Photo: Louei Mups / Unsplash" },
  heroPoster: { src: heroPoster, alt: "Hazy sunrise over a lake framed by layered limestone mountains, seen from a drone.", focal: "50% 40%", credit: "Footage: Marco López / Mixkit" },
  heroMobilePoster: { src: heroMobilePoster, alt: "Hazy sunrise over a lake framed by layered limestone mountains, seen from a drone.", focal: "50% 50%", credit: "Footage: Marco López / Mixkit" },
  flyoverPoster: { src: flyoverPoster, alt: "Top-down view of parallel rows of dark green orchard trees.", focal: "50% 50%", credit: "Footage: Marco López / Mixkit" },
} satisfies Record<string, MediaImage>;

export const video = {
  hero: { desktop: "/media/video/hero.mp4", mobile: "/media/video/hero-mobile.mp4" },
  flyover: { desktop: "/media/video/flyover.mp4" },
} as const;
