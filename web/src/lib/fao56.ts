/**
 * FAO-56 crop water use and root-zone water balance — pure functions and
 * data, safe for client components (src/server/agronomy/service.ts runs them).
 *
 * Source: Allen, R.G., Pereira, L.S., Raes, D., Smith, M. (1998). Crop
 * evapotranspiration — Guidelines for computing crop water requirements. FAO
 * Irrigation and Drainage Paper 56. Equation and table numbers below are
 * that paper's. Table values were checked on 2026-10-18 against FAO's online
 * edition (fao.org/4/x0490e) and, where FAO's pages show a table as an image,
 * against two independent extractions of the same table (CRAN packages
 * FAO56 and CropWaterBalance), which agree with every value FAO's text shows.
 *
 * Method (single crop coefficient, FAO-56 chapters 6 and 8):
 *   Kc curve      Kc_ini → Kc_mid → Kc_end over the stage lengths, linear in
 *                 the development and late stages (Eq. 66), Tables 11 and 12
 *   ETc           Kc × ETo (Eq. 56); ETc,adj = Ks × Kc × ETo (Eq. 81)
 *   TAW, RAW      1000 (θFC − θWP) Zr (Eq. 82); p × TAW (Eq. 83)
 *   p             Table 22 value + 0.04 (5 − ETc), limited to 0.1–0.8
 *   Ks            (TAW − Dr) / ((1 − p) TAW) when Dr > RAW, else 1 (Eq. 84)
 *   Dr,i          Dr,i−1 − (P − RO)i − Ii − CRi + ETc,i + DPi (Eq. 85),
 *                 0 ≤ Dr,i ≤ TAW (Eq. 86); excess above field capacity
 *                 drains as deep percolation (Eq. 88)
 * Simplifications, each reported with the result:
 *   - Daily rain below 0.2 ETo is ignored ("normally entirely evaporated",
 *     FAO-56 ch. 8); surface runoff RO is not modelled (all other rain
 *     infiltrates); capillary rise CR is taken as zero (no shallow water table).
 *   - Kc_mid and Kc_end are not adjusted for local wind and humidity (Eq. 62);
 *     Table 12 values are for a sub-humid climate (RHmin ≈ 45 %, u2 ≈ 2 m/s).
 *   - The root zone is held at its maximum depth from planting, which
 *     overstates the water available to a young crop.
 *   - The run starts at field capacity on the planting date (Dr = 0), which
 *     FAO-56 allows "following heavy rain or irrigation".
 *
 * Hargreaves ETo (Eq. 52) is used only when no FAO Penman-Monteith ETo is
 * available; FAO-56 says it should be checked against Penman-Monteith in each
 * new region, underpredicts in high wind (u2 > 3 m/s) and overpredicts in high
 * humidity.
 */

export const WATER_BALANCE_METHOD = { id: "fao56-single-kc-water-balance", version: "1.0.0" } as const;

// ── Crops (Tables 11, 12, 22) ─────────────────────────────────

export type StageDays = { init: number; dev: number; mid: number; late: number };

export type CropProfile = {
  id: string;
  label: string;
  /** Table 12: Kc_ini, Kc_mid, Kc_end; ranges where the table gives one (the midpoint is used). */
  kc: { ini: number; mid: number | [number, number]; end: number | [number, number] };
  /** Table 11 stage lengths (days) and the table row they come from. */
  stages: StageDays;
  stagesRow: string;
  /** Table 22: maximum effective rooting depth range (m) and depletion fraction for no stress at ETc ≈ 5 mm/day. */
  rootDepthM: [number, number];
  p: number;
};

export const CROP_PROFILES: Record<string, CropProfile> = {
  maize_grain: {
    id: "maize_grain",
    label: "Maize (field, grain)",
    kc: { ini: 0.3, mid: 1.2, end: [0.35, 0.6] },
    stages: { init: 30, dev: 40, mid: 50, late: 30 },
    stagesRow: "April planting, Spain (spring/summer) and California",
    rootDepthM: [1.0, 1.7],
    p: 0.55,
  },
  soybeans: {
    id: "soybeans",
    label: "Soybeans",
    kc: { ini: 0.4, mid: 1.15, end: 0.5 },
    stages: { init: 20, dev: 35, mid: 60, late: 25 },
    stagesRow: "May planting, Central USA (development 30–35 days; 35 used, matching the 140-day total)",
    rootDepthM: [0.6, 1.3],
    p: 0.5,
  },
  cotton: {
    id: "cotton",
    label: "Cotton",
    kc: { ini: 0.35, mid: [1.15, 1.2], end: [0.5, 0.7] },
    stages: { init: 30, dev: 50, mid: 55, late: 45 },
    stagesRow: "April planting, Texas",
    rootDepthM: [1.0, 1.7],
    p: 0.65,
  },
  groundnut: {
    id: "groundnut",
    label: "Groundnut (peanut)",
    kc: { ini: 0.4, mid: 1.15, end: 0.6 },
    stages: { init: 35, dev: 45, mid: 35, late: 25 },
    stagesRow: "May/June planting, Mediterranean",
    rootDepthM: [0.5, 1.0],
    p: 0.5,
  },
  spring_wheat: {
    id: "spring_wheat",
    label: "Spring wheat",
    kc: { ini: 0.3, mid: 1.15, end: [0.25, 0.4] },
    stages: { init: 20, dev: 25, mid: 60, late: 30 },
    stagesRow: "March/April planting, 35–45° latitude",
    rootDepthM: [1.0, 1.5],
    p: 0.55,
  },
  potato: {
    id: "potato",
    label: "Potato",
    kc: { ini: 0.5, mid: 1.15, end: 0.75 },
    stages: { init: 25, dev: 30, mid: 45, late: 30 },
    stagesRow: "May planting, continental climate",
    rootDepthM: [0.4, 0.6],
    p: 0.35,
  },
  sugar_beet: {
    id: "sugar_beet",
    label: "Sugar beet",
    kc: { ini: 0.35, mid: 1.2, end: 0.7 },
    stages: { init: 30, dev: 45, mid: 90, late: 15 },
    stagesRow: "March planting, California",
    rootDepthM: [0.7, 1.2],
    p: 0.55,
  },
};

/** Common names an area's metadata may use for a crop. */
const CROP_ALIASES: Record<string, string> = {
  maize: "maize_grain",
  corn: "maize_grain",
  field_corn: "maize_grain",
  soybean: "soybeans",
  soy: "soybeans",
  peanut: "groundnut",
  peanuts: "groundnut",
  wheat_spring: "spring_wheat",
  potatoes: "potato",
  sugarbeet: "sugar_beet",
  sugar_beets: "sugar_beet",
};

/** A crop id from a profile id or a common name; null when unknown. */
export function resolveCrop(name: string | null | undefined): CropProfile | null {
  if (!name) return null;
  const k = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return CROP_PROFILES[k] ?? CROP_PROFILES[CROP_ALIASES[k] ?? ""] ?? null;
}

const mid = (v: number | [number, number]) => (Array.isArray(v) ? (v[0] + v[1]) / 2 : v);

/** Kc on day `d` after planting (0-based), Eq. 66; null after the season ends. */
export function kcOnDay(profile: CropProfile, stages: StageDays, d: number): number | null {
  const kIni = profile.kc.ini;
  const kMid = mid(profile.kc.mid);
  const kEnd = mid(profile.kc.end);
  if (d < 0) return null;
  if (d < stages.init) return kIni;
  if (d < stages.init + stages.dev) return kIni + ((d - stages.init) / stages.dev) * (kMid - kIni);
  if (d < stages.init + stages.dev + stages.mid) return kMid;
  const lateStart = stages.init + stages.dev + stages.mid;
  if (d < lateStart + stages.late) return kMid + ((d - lateStart) / stages.late) * (kEnd - kMid);
  return null;
}

export function seasonLength(stages: StageDays): number {
  return stages.init + stages.dev + stages.mid + stages.late;
}

export function stageOnDay(stages: StageDays, d: number): "initial" | "development" | "mid-season" | "late season" | "after harvest" {
  if (d < stages.init) return "initial";
  if (d < stages.init + stages.dev) return "development";
  if (d < stages.init + stages.dev + stages.mid) return "mid-season";
  if (d < seasonLength(stages)) return "late season";
  return "after harvest";
}

// ── Soils (Table 19) ──────────────────────────────────────────

export type SoilTexture = { id: string; label: string; fc: [number, number]; wp: [number, number] };

/** Table 19: typical θFC and θWP (m³/m³). The available water used is mean(θFC) − mean(θWP). */
export const SOIL_TEXTURES: Record<string, SoilTexture> = {
  sand: { id: "sand", label: "Sand", fc: [0.07, 0.17], wp: [0.02, 0.07] },
  loamy_sand: { id: "loamy_sand", label: "Loamy sand", fc: [0.11, 0.19], wp: [0.03, 0.1] },
  sandy_loam: { id: "sandy_loam", label: "Sandy loam", fc: [0.18, 0.28], wp: [0.06, 0.16] },
  loam: { id: "loam", label: "Loam", fc: [0.2, 0.3], wp: [0.07, 0.17] },
  silt_loam: { id: "silt_loam", label: "Silt loam", fc: [0.22, 0.36], wp: [0.09, 0.21] },
  silt: { id: "silt", label: "Silt", fc: [0.28, 0.36], wp: [0.12, 0.22] },
  silty_clay_loam: { id: "silty_clay_loam", label: "Silty clay loam", fc: [0.3, 0.37], wp: [0.17, 0.24] },
  silty_clay: { id: "silty_clay", label: "Silty clay", fc: [0.3, 0.42], wp: [0.17, 0.29] },
  clay: { id: "clay", label: "Clay", fc: [0.32, 0.4], wp: [0.2, 0.24] },
};

/** Typical available water (mm per m of soil) for a texture: 1000 × (mean θFC − mean θWP). */
export function textureAvailableWaterMmPerM(t: SoilTexture): number {
  return Math.round(1000 * ((t.fc[0] + t.fc[1]) / 2 - (t.wp[0] + t.wp[1]) / 2));
}

// ── Reference evapotranspiration (Eq. 21–25, 52) ─────────────

/** Day of the year (1–366) of a UTC calendar date. */
export function dayOfYear(date: string): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  const y = new Date(t).getUTCFullYear();
  return Math.round((t - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/** Extraterrestrial radiation Ra (MJ m⁻² day⁻¹), Eq. 21 with Eq. 23–25; Gsc = 0.0820 MJ m⁻² min⁻¹. */
export function extraterrestrialRadiation(latDeg: number, doy: number): number {
  const phi = (Math.PI / 180) * latDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  return ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

/**
 * Hargreaves ETo (mm/day), Eq. 52: 0.0023 (Tmean + 17.8) (Tmax − Tmin)^0.5 Ra,
 * with Ra as equivalent evaporation (0.408 × MJ m⁻² day⁻¹) and Tmean the mean
 * of Tmax and Tmin. Null when Tmax < Tmin.
 */
export function hargreavesEt0(tMaxC: number, tMinC: number, latDeg: number, doy: number): number | null {
  if (!(tMaxC >= tMinC)) return null;
  const ra = 0.408 * extraterrestrialRadiation(latDeg, doy);
  return Math.max(0, 0.0023 * ((tMaxC + tMinC) / 2 + 17.8) * Math.sqrt(tMaxC - tMinC) * ra);
}

// ── Daily root-zone water balance (Eq. 81–88) ─────────────────

export const IGNORED_RAIN_FRACTION_OF_ETO = 0.2;

export type DailyInput = {
  date: string;
  et0Mm: number;
  precipMm: number;
  irrigationMm: number;
};

export type DailyState = {
  date: string;
  day: number;
  stage: ReturnType<typeof stageOnDay>;
  kc: number;
  ks: number;
  et0Mm: number;
  etcMm: number;
  etcAdjMm: number;
  precipMm: number;
  effectivePrecipMm: number;
  irrigationMm: number;
  deepPercolationMm: number;
  p: number;
  tawMm: number;
  rawMm: number;
  depletionMm: number;
};

export type BalanceParams = {
  profile: CropProfile;
  stages: StageDays;
  plantingDate: string;
  availableWaterMmPerM: number;
  rootDepthM: number;
};

/**
 * Daily root-zone depletion from the planting date, starting at field
 * capacity. `days` must be consecutive dates from the planting date; days
 * after the season ends are ignored.
 */
export function simulateWaterBalance(params: BalanceParams, days: DailyInput[]): DailyState[] {
  const out: DailyState[] = [];
  const taw = params.availableWaterMmPerM * params.rootDepthM; // = 1000 (θFC − θWP) Zr with θ in mm/m
  let dr = 0;
  const start = Date.parse(`${params.plantingDate}T00:00:00Z`);
  for (const d of days) {
    const day = Math.round((Date.parse(`${d.date}T00:00:00Z`) - start) / 86_400_000);
    const kc = kcOnDay(params.profile, params.stages, day);
    if (kc === null) break;
    const etc = kc * d.et0Mm;
    const p = Math.min(0.8, Math.max(0.1, params.profile.p + 0.04 * (5 - etc)));
    const raw = p * taw;
    // Ks from the depletion at the start of the day (end of the previous day).
    const ks = dr > raw ? Math.max(0, (taw - dr) / ((1 - p) * taw)) : 1;
    const etcAdj = ks * etc;
    const effective = d.precipMm >= IGNORED_RAIN_FRACTION_OF_ETO * d.et0Mm ? d.precipMm : 0;
    let next = dr - effective - d.irrigationMm + etcAdj;
    let dp = 0;
    if (next < 0) {
      dp = -next;
      next = 0;
    }
    next = Math.min(next, taw);
    out.push({
      date: d.date,
      day,
      stage: stageOnDay(params.stages, day),
      kc,
      ks,
      et0Mm: d.et0Mm,
      etcMm: etc,
      etcAdjMm: etcAdj,
      precipMm: d.precipMm,
      effectivePrecipMm: effective,
      irrigationMm: d.irrigationMm,
      deepPercolationMm: dp,
      p,
      tawMm: taw,
      rawMm: raw,
      depletionMm: next,
    });
    dr = next;
  }
  return out;
}
