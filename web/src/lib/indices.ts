/**
 * Spectral indices a user can chart and map, with the words shown beside
 * them. Formulas and coefficients live in src/server/analytics/indices.ts;
 * this file is the client-safe vocabulary. Pure data.
 */

export const CHART_INDICES = ["ndvi", "evi", "savi", "ndmi"] as const;
export type ChartIndex = (typeof CHART_INDICES)[number];

export const INDEX_INFO: Record<ChartIndex, { button: string; caveat: string; yDomain?: [number, number]; color?: string }> = {
  ndvi: { button: "NDVI", caveat: "vigour" },
  evi: {
    button: "EVI",
    caveat: "vigour; saturates less than NDVI over dense canopy, but the blue band it uses is sensitive to haze",
    yDomain: [-0.2, 1],
    color: "#a39be0",
  },
  savi: {
    button: "SAVI",
    caveat: "vigour with reduced soil-background influence in sparse cover (L = 0.5)",
    yDomain: [-0.2, 1],
    color: "#6fbf9f",
  },
  ndmi: { button: "NDMI", caveat: "canopy water content, not soil moisture", yDomain: [-0.5, 0.7], color: "#c98500" },
};

export const isChartIndex = (k: string): k is ChartIndex => (CHART_INDICES as readonly string[]).includes(k);
