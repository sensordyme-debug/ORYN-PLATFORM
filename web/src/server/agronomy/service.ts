/**
 * Field agronomy inputs (crop, planting date, soil, rooting depth, irrigation
 * log) and the FAO-56 crop water balance computed from them on request.
 *
 * Authorization: reading needs aoi.read / results.read, changing the inputs
 * aoi.write, logging irrigation notes.write; every call resolves the area
 * through getAoi, so a member restricted to some areas cannot reach others
 * (they read as not found). Writes are audited.
 *
 * Weather: only providers whose licence and configuration currently permit
 * use (contextProviderAvailability) contribute. With Open-Meteo permitted,
 * its FAO Penman-Monteith ETo and precipitation (ERA5-based reanalysis) are
 * used; otherwise ETo comes from Hargreaves (FAO-56 Eq. 52) on daily
 * temperatures from NWS station observations and rain from complete NWS
 * station days. A day missing either value stops the estimate: it reports
 * the missing dates instead of filling them.
 */
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import type { OrgAccess } from "@/server/authz/access";
import { getAoi } from "@/server/aois/service";
import type { Tx } from "@/server/db/client";
import { jsonb } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { contextProviderAvailability } from "@/server/pipeline/context";
import {
  CROP_PROFILES,
  dayOfYear,
  hargreavesEt0,
  resolveCrop,
  seasonLength,
  simulateWaterBalance,
  SOIL_TEXTURES,
  textureAvailableWaterMmPerM,
  WATER_BALANCE_METHOD,
  type DailyInput,
  type DailyState,
  type StageDays,
} from "@/lib/fao56";

// ── Inputs ────────────────────────────────────────────────────

const ymd = z.iso.date();

export const agronomySchema = z.strictObject({
  crop: z.enum(Object.keys(CROP_PROFILES) as [string, ...string[]]).nullable(),
  plantingDate: ymd.nullable(),
  stageDays: z
    .strictObject({ init: z.int().min(1).max(200), dev: z.int().min(1).max(200), mid: z.int().min(1).max(200), late: z.int().min(1).max(200) })
    .nullable()
    .default(null),
  soilTexture: z.enum(Object.keys(SOIL_TEXTURES) as [string, ...string[]]).nullable(),
  availableWaterMmPerM: z.number().min(20).max(300).nullable(),
  rootDepthM: z.number().min(0.1).max(3).nullable(),
  notes: z.string().trim().max(2000).default(""),
});
export type AgronomyInput = z.input<typeof agronomySchema>;

export const irrigationSchema = z.strictObject({
  appliedOn: ymd,
  amountMm: z.number().gt(0).max(300),
  note: z.string().trim().max(500).default(""),
});

export type IrrigationEvent = { id: string; appliedOn: string; amountMm: number; note: string; createdAt: string };

export type Agronomy = {
  aoiId: string;
  crop: string | null;
  /** Where the crop comes from: these inputs, or the area's metadata `crop` field. */
  cropSource: "agronomy" | "area_metadata" | null;
  plantingDate: string | null;
  stageDays: StageDays | null;
  soilTexture: string | null;
  availableWaterMmPerM: number | null;
  rootDepthM: number | null;
  notes: string;
  updatedAt: string | null;
  irrigation: IrrigationEvent[];
};

type Row = {
  crop: string | null;
  planting_date: string | null;
  stage_days: StageDays | null;
  soil_texture: string | null;
  available_water_mm_per_m: number | null;
  root_depth_m: number | null;
  notes: string;
  updated_at: Date;
};

const userId = (access: OrgAccess) => (access.principal.type === "user" ? access.principal.userId : null);

async function loadAgronomy(tx: Tx, access: OrgAccess, aoiId: string): Promise<Agronomy> {
  const aoi = await getAoi(access, aoiId, tx);
  return loadAgronomyRecord(tx, access.org.id, aoiId, aoi.metadata);
}

/** The stored inputs for one area of `orgId` (no authorization: callers resolve the area first). */
export async function loadAgronomyRecord(tx: Tx, orgId: string, aoiId: string, metadata: Record<string, unknown>): Promise<Agronomy> {
  const [row] = await tx<Row[]>`
    select crop, planting_date::text as planting_date, stage_days, soil_texture, available_water_mm_per_m, root_depth_m, notes, updated_at
      from field_agronomy where aoi_id = ${aoiId} and org_id = ${orgId}`;
  const events = await tx<{ id: string; applied_on: string; amount_mm: number; note: string; created_at: Date }[]>`
    select id, applied_on::text as applied_on, amount_mm, note, created_at from irrigation_events
     where aoi_id = ${aoiId} and org_id = ${orgId} order by applied_on, created_at`;
  const metaCrop = typeof metadata.crop === "string" ? resolveCrop(metadata.crop)?.id ?? null : null;
  return {
    aoiId,
    crop: row?.crop ?? metaCrop,
    cropSource: row?.crop ? "agronomy" : metaCrop ? "area_metadata" : null,
    plantingDate: row?.planting_date ?? null,
    stageDays: row?.stage_days ?? null,
    soilTexture: row?.soil_texture ?? null,
    availableWaterMmPerM: row?.available_water_mm_per_m ?? null,
    rootDepthM: row?.root_depth_m ?? null,
    notes: row?.notes ?? "",
    updatedAt: row?.updated_at.toISOString() ?? null,
    irrigation: events.map((e) => ({ id: e.id, appliedOn: e.applied_on, amountMm: e.amount_mm, note: e.note, createdAt: e.created_at.toISOString() })),
  };
}

export async function getAgronomy(access: OrgAccess, aoiId: string): Promise<Agronomy> {
  access.assert("aoi.read");
  return access.tx((tx) => loadAgronomy(tx, access, aoiId));
}

export async function saveAgronomy(access: OrgAccess, aoiId: string, input: unknown): Promise<Agronomy> {
  access.assert("aoi.write");
  const v = agronomySchema.parse(input);
  return access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    await tx`
      insert into field_agronomy (aoi_id, org_id, crop, planting_date, stage_days, soil_texture, available_water_mm_per_m, root_depth_m, notes, updated_by)
      values (${aoiId}, ${access.org.id}, ${v.crop}, ${v.plantingDate}, ${v.stageDays === null ? null : jsonb(v.stageDays)}::jsonb, ${v.soilTexture},
              ${v.availableWaterMmPerM}, ${v.rootDepthM}, ${v.notes}, ${userId(access)})
      on conflict (aoi_id) do update set crop = excluded.crop, planting_date = excluded.planting_date, stage_days = excluded.stage_days,
             soil_texture = excluded.soil_texture, available_water_mm_per_m = excluded.available_water_mm_per_m,
             root_depth_m = excluded.root_depth_m, notes = excluded.notes, updated_by = excluded.updated_by`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "aoi.agronomy.update",
      targetType: "aoi",
      targetId: aoiId,
      metadata: { crop: v.crop, planting_date: v.plantingDate, soil_texture: v.soilTexture, available_water_mm_per_m: v.availableWaterMmPerM, root_depth_m: v.rootDepthM },
      ...access.meta,
    });
    return loadAgronomy(tx, access, aoiId);
  });
}

export async function addIrrigationEvent(access: OrgAccess, aoiId: string, input: unknown, today: Date = new Date()): Promise<IrrigationEvent> {
  access.assert("notes.write");
  const v = irrigationSchema.parse(input);
  if (v.appliedOn > today.toISOString().slice(0, 10)) {
    throw new DomainError("invalid", "Irrigation can only be logged once it has been applied.", 422, { appliedOn: "In the future" });
  }
  return access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      insert into irrigation_events (org_id, aoi_id, applied_on, amount_mm, note, created_by)
      values (${access.org.id}, ${aoiId}, ${v.appliedOn}, ${v.amountMm}, ${v.note}, ${userId(access)}) returning id, created_at`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "aoi.irrigation.add",
      targetType: "aoi",
      targetId: aoiId,
      metadata: { event_id: row!.id, applied_on: v.appliedOn, amount_mm: v.amountMm },
      ...access.meta,
    });
    return { id: row!.id, appliedOn: v.appliedOn, amountMm: v.amountMm, note: v.note, createdAt: row!.created_at.toISOString() };
  });
}

export async function deleteIrrigationEvent(access: OrgAccess, aoiId: string, eventId: string): Promise<void> {
  access.assert("notes.write");
  if (!z.uuid().safeParse(eventId).success) throw notFoundError("Irrigation event");
  await access.tx(async (tx) => {
    await getAoi(access, aoiId, tx);
    // The person who logged it, or someone who may change the area's inputs.
    const [row] = await tx<{ created_by: string | null }[]>`
      select created_by from irrigation_events where id = ${eventId} and aoi_id = ${aoiId} and org_id = ${access.org.id}`;
    if (!row) throw notFoundError("Irrigation event");
    if (row.created_by !== userId(access) && !access.can("aoi.write")) {
      throw new DomainError("forbidden", "Only the person who logged this event, or someone who can edit the area, can delete it.", 422);
    }
    await tx`delete from irrigation_events where id = ${eventId} and org_id = ${access.org.id}`;
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "aoi.irrigation.delete", targetType: "aoi", targetId: aoiId, metadata: { event_id: eventId }, ...access.meta });
  });
}

// ── Water balance ─────────────────────────────────────────────

export type WaterBalanceStatus = "estimated" | "insufficient_inputs" | "insufficient_weather" | "not_started";

export type SourceUse = { provider: string; method: string; recordKind: string; licence: string; days: number };

export type WaterBalance = {
  method: { id: string; version: string; reference: string };
  status: WaterBalanceStatus;
  statusText: string;
  /** Last day included (the day before `asOf`, or the end of the season). */
  throughDate: string | null;
  missingInputs: { input: string; why: string }[];
  inputs: {
    crop: { id: string; label: string; source: string } | null;
    plantingDate: { value: string; source: string } | null;
    stages: { days: StageDays; source: string } | null;
    availableWater: { mmPerM: number; source: string } | null;
    rootDepth: { central: number; range: [number, number] | null; source: string } | null;
    depletionFraction: { tableValue: number; source: string } | null;
    irrigation: { events: number; totalMm: number; source: string };
  };
  weather: { et0: SourceUse | null; precipitation: SourceUse | null; expectedDays: number; presentDays: number; missingDates: string[] } | null;
  current: {
    date: string;
    stage: DailyState["stage"];
    depletionMm: number;
    /** Depletion with the shallowest and deepest rooting depth of FAO-56 Table 22 (null when a depth was supplied). */
    depletionRangeMm: [number, number] | null;
    rawMm: number;
    tawMm: number;
    ks: number;
    condition: "no_stress_expected" | "approaching_stress" | "stress_likely";
    /** Net depth that would return the root zone to field capacity. */
    refillMm: number;
    seasonEnded: boolean;
  } | null;
  totals: { et0Mm: number; etcAdjMm: number; precipMm: number; effectivePrecipMm: number; irrigationMm: number; deepPercolationMm: number } | null;
  series: Pick<DailyState, "date" | "depletionMm" | "rawMm" | "tawMm" | "etcAdjMm" | "effectivePrecipMm" | "irrigationMm" | "ks">[];
  assumptions: string[];
  limitations: string[];
  recommendation: string;
};

const REFERENCE = "FAO Irrigation and Drainage Paper 56 (Allen et al. 1998), chapters 6 and 8: single crop coefficient and daily root-zone water balance";
const LIMITATIONS = [
  "A planning estimate from weather and published crop and soil parameters, not a measurement of the field's soil water. It has not been validated against soil-moisture measurements on this field.",
  "Kc values are FAO-56 Table 12 values for a sub-humid climate and are not adjusted for local wind and humidity; varieties, planting density and management change crop water use.",
  "Surface runoff and capillary rise are not modelled: intense storms are counted as fully infiltrating, and a shallow water table would supply water this estimate ignores.",
  "The root zone is held at its maximum depth from planting, so early-season available water is overstated.",
  "Irrigation counts only when it has been logged; unlogged irrigation makes the deficit look larger than it is.",
  "The estimate does not account for within-field differences in soil or crop; it describes the field as one unit.",
];

type WeatherRow = { provider_id: string; record_kind: string; variable: string; value: number; valid_from: Date; valid_to: Date };

/** Local calendar day of a daily record (its midpoint, robust to any UTC offset within ±12 h). */
const recordDay = (r: { valid_from: Date; valid_to: Date }) => new Date((r.valid_from.getTime() + r.valid_to.getTime()) / 2).toISOString().slice(0, 10);

function datesBetween(from: string, toInclusive: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${toInclusive}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The water balance for one area through yesterday (or `asOf` − 1 day).
 * Pure with respect to its inputs: the same stored inputs and weather give
 * the same result.
 */
export async function waterBalance(access: OrgAccess, aoiId: string, opts: { asOf?: Date } = {}): Promise<WaterBalance> {
  access.assert("results.read");
  return access.tx(async (tx) => {
    const aoi = await getAoi(access, aoiId, tx);
    return waterBalanceForArea(tx, access.org.id, aoiId, aoi.metadata, opts.asOf ?? new Date());
  });
}

/** The water balance for one area of `orgId` as of a date (reports call this inside the org's transaction). */
export async function waterBalanceForArea(tx: Tx, orgId: string, aoiId: string, metadata: Record<string, unknown>, asOf: Date): Promise<WaterBalance> {
  const ag = await loadAgronomyRecord(tx, orgId, aoiId, metadata);
  const [pt] = await tx<{ lon: number; lat: number }[]>`select ST_X(label_point) as lon, ST_Y(label_point) as lat from aois where id = ${aoiId} and org_id = ${orgId}`;
  if (!pt) throw notFoundError("Area");
  return computeWaterBalance(ag, { lat: pt.lat, lon: pt.lon }, asOf, (from, to) => tx<WeatherRow[]>`
    select provider_id, record_kind, variable, value, valid_from, valid_to from weather_records
     where aoi_id = ${aoiId} and org_id = ${orgId}
       and variable in ('et0_mm', 'precipitation_mm', 'temperature_max_c', 'temperature_min_c', 'temperature_c')
       and valid_from >= ${from}::date - interval '1 day' and valid_from < ${to}::date + interval '2 days'
       and value is not null`);
}

export async function computeWaterBalance(
  ag: Agronomy,
  point: { lat: number; lon: number },
  asOf: Date,
  loadWeather: (fromDate: string, toDate: string) => Promise<WeatherRow[]>,
  availability: (p: "open-meteo" | "nws") => boolean = (p) => contextProviderAvailability(p).state === "available",
): Promise<WaterBalance> {
  const profile = ag.crop ? CROP_PROFILES[ag.crop] ?? null : null;
  const texture = ag.soilTexture ? SOIL_TEXTURES[ag.soilTexture] ?? null : null;
  const missing: WaterBalance["missingInputs"] = [];
  if (!profile) missing.push({ input: "crop", why: "Crop coefficients and rooting depth depend on the crop (FAO-56 Tables 12 and 22)." });
  if (!ag.plantingDate) missing.push({ input: "planting date", why: "The crop coefficient follows the growth stages counted from planting; without it the season cannot be placed." });
  if (!texture && ag.availableWaterMmPerM === null) {
    missing.push({ input: "soil", why: "How much water the root zone holds depends on the soil: give a texture class or a surveyed available water value (mm per m)." });
  }
  const stages: StageDays | null = profile ? (ag.stageDays ?? profile.stages) : null;
  const awMmPerM = ag.availableWaterMmPerM ?? (texture ? textureAvailableWaterMmPerM(texture) : null);
  const irrigationTotal = ag.irrigation.reduce((s, e) => s + e.amountMm, 0);
  const inputs: WaterBalance["inputs"] = {
    crop: profile ? { id: profile.id, label: profile.label, source: ag.cropSource === "area_metadata" ? "Area metadata (crop field)" : "Field agronomy inputs" } : null,
    plantingDate: ag.plantingDate ? { value: ag.plantingDate, source: "Field agronomy inputs" } : null,
    stages: profile && stages ? { days: stages, source: ag.stageDays ? "Field agronomy inputs (override)" : `FAO-56 Table 11 (${profile.stagesRow})` } : null,
    availableWater:
      awMmPerM === null
        ? null
        : { mmPerM: awMmPerM, source: ag.availableWaterMmPerM !== null ? "Field agronomy inputs (surveyed or measured value)" : `FAO-56 Table 19, typical ${texture!.label.toLowerCase()} (mean θFC − mean θWP)` },
    rootDepth: profile
      ? ag.rootDepthM !== null
        ? { central: ag.rootDepthM, range: null, source: "Field agronomy inputs" }
        : { central: (profile.rootDepthM[0] + profile.rootDepthM[1]) / 2, range: profile.rootDepthM, source: "FAO-56 Table 22 (midpoint of the range; the range is shown as the uncertainty band)" }
      : null,
    depletionFraction: profile ? { tableValue: profile.p, source: "FAO-56 Table 22, adjusted daily for ETc (p + 0.04 (5 − ETc), 0.1–0.8)" } : null,
    irrigation: { events: ag.irrigation.length, totalMm: irrigationTotal, source: "Irrigation logged by members of this organization" },
  };
  const base = {
    method: { ...WATER_BALANCE_METHOD, reference: REFERENCE },
    inputs,
    limitations: LIMITATIONS,
  };
  const assumptions = [
    "The root zone was at field capacity on the planting date (FAO-56: after heavy rain or irrigation).",
    `Daily rain below ${0.2} × ETo is treated as evaporated (FAO-56 ch. 8); all other rain infiltrates (no runoff).`,
    "No capillary rise from a water table.",
  ];

  if (missing.length) {
    return {
      ...base,
      status: "insufficient_inputs",
      statusText: `No estimate: ${missing.map((m) => m.input).join(", ")} ${missing.length === 1 ? "is" : "are"} needed.`,
      throughDate: null,
      missingInputs: missing,
      weather: null,
      current: null,
      totals: null,
      series: [],
      assumptions,
      recommendation: "Add the missing field details; the estimate is computed from them and stored weather.",
    };
  }

  const yesterday = new Date(asOf.getTime() - 86_400_000).toISOString().slice(0, 10);
  const seasonEnd = new Date(Date.parse(`${ag.plantingDate}T00:00:00Z`) + (seasonLength(stages!) - 1) * 86_400_000).toISOString().slice(0, 10);
  const through = yesterday < seasonEnd ? yesterday : seasonEnd;
  if (through < ag.plantingDate!) {
    return {
      ...base,
      status: "not_started",
      statusText: `The season starts on ${ag.plantingDate}; there is nothing to estimate yet.`,
      throughDate: null,
      missingInputs: [],
      weather: null,
      current: null,
      totals: null,
      series: [],
      assumptions,
      recommendation: "Check back after planting.",
    };
  }

  // Weather: Open-Meteo (Penman-Monteith ETo, reanalysis rain) when permitted; otherwise NWS.
  const rows = await loadWeather(ag.plantingDate!, through);
  const useOpenMeteo = availability("open-meteo");
  const useNws = availability("nws");
  const byDay = (provider: string, variable: string, kinds: string[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.provider_id === provider && r.variable === variable && kinds.includes(r.record_kind) && r.valid_to > r.valid_from) m.set(recordDay(r), r.value);
    return m;
  };
  const et0: Map<string, number> = new Map();
  const precip: Map<string, number> = new Map();
  let et0Use: SourceUse | null = null;
  let precipUse: SourceUse | null = null;
  if (useOpenMeteo) {
    for (const [d, v] of byDay("open-meteo", "et0_mm", ["model_estimate"])) et0.set(d, v);
    for (const [d, v] of byDay("open-meteo", "precipitation_mm", ["model_estimate"])) precip.set(d, v);
    et0Use = { provider: "open-meteo", method: "FAO Penman-Monteith ETo (FAO-56 Eq. 6), as computed by Open-Meteo", recordKind: "model_estimate (ERA5-based reanalysis)", licence: "Open-Meteo free API: non-commercial use only; commercial use needs a paid plan", days: 0 };
    precipUse = { provider: "open-meteo", method: "Daily precipitation sum", recordKind: "model_estimate (ERA5-based reanalysis)", licence: et0Use.licence, days: 0 };
  } else if (useNws) {
    // Daily Tmax/Tmin from hourly NWS station observations, on the area's approximate local solar day.
    const offsetMs = (point.lon / 15) * 3_600_000;
    const hours = new Map<string, { min: number; max: number; hours: Set<number> }>();
    for (const r of rows) {
      if (r.provider_id !== "nws" || r.variable !== "temperature_c" || r.record_kind !== "observation") continue;
      const local = new Date(r.valid_from.getTime() + offsetMs);
      const d = local.toISOString().slice(0, 10);
      const h = hours.get(d) ?? { min: Infinity, max: -Infinity, hours: new Set<number>() };
      h.min = Math.min(h.min, r.value);
      h.max = Math.max(h.max, r.value);
      h.hours.add(local.getUTCHours());
      hours.set(d, h);
    }
    for (const [d, h] of hours) {
      if (h.hours.size < 18) continue; // a day with large gaps would understate the range
      const v = hargreavesEt0(h.max, h.min, point.lat, dayOfYear(d));
      if (v !== null) et0.set(d, v);
    }
    for (const [d, v] of byDay("nws", "precipitation_mm", ["observation"])) precip.set(d, v);
    et0Use = { provider: "nws", method: "Hargreaves ETo (FAO-56 Eq. 52) from daily maximum and minimum of hourly station temperatures (days with ≥ 18 reported hours)", recordKind: "observation", licence: "U.S. public domain (NOAA/NWS)", days: 0 };
    precipUse = { provider: "nws", method: "Daily total of hourly station precipitation (complete local days only)", recordKind: "observation", licence: "U.S. public domain (NOAA/NWS)", days: 0 };
  }

  const dates = datesBetween(ag.plantingDate!, through);
  const missingDates = dates.filter((d) => !et0.has(d) || !precip.has(d));
  if (et0Use) et0Use.days = dates.filter((d) => et0.has(d)).length;
  if (precipUse) precipUse.days = dates.filter((d) => precip.has(d)).length;
  const weather = { et0: et0Use, precipitation: precipUse, expectedDays: dates.length, presentDays: dates.length - missingDates.length, missingDates: missingDates.slice(0, 20) };
  if (!et0Use || missingDates.length) {
    const why = !et0Use
      ? "No weather provider whose terms permit this use is available (Open-Meteo's free API is non-commercial; NWS is not configured)."
      : `${missingDates.length} of ${dates.length} days since planting lack ETo or rainfall from ${et0Use.provider === "nws" ? "NWS station observations" : "Open-Meteo"} (first missing: ${missingDates[0]}).`;
    return {
      ...base,
      status: "insufficient_weather",
      statusText: `No estimate: ${why} Days are never filled in.`,
      throughDate: through,
      missingInputs: [],
      weather,
      current: null,
      totals: null,
      series: [],
      assumptions,
      recommendation:
        et0Use?.provider === "nws"
          ? "NWS station history accumulates as ORYN syncs daily; a season needs every day since planting. A commercially licensed daily weather source would close the gap."
          : "Enable a weather source whose terms permit this use; ORYN does not estimate without daily ETo and rainfall.",
    };
  }

  const irrigationByDay = new Map<string, number>();
  for (const e of ag.irrigation) irrigationByDay.set(e.appliedOn, (irrigationByDay.get(e.appliedOn) ?? 0) + e.amountMm);
  const days: DailyInput[] = dates.map((d) => ({ date: d, et0Mm: et0.get(d)!, precipMm: precip.get(d)!, irrigationMm: irrigationByDay.get(d) ?? 0 }));
  const run = (depth: number) => simulateWaterBalance({ profile: profile!, stages: stages!, plantingDate: ag.plantingDate!, availableWaterMmPerM: awMmPerM!, rootDepthM: depth }, days);
  const central = run(inputs.rootDepth!.central);
  const range = inputs.rootDepth!.range ? ([run(inputs.rootDepth!.range[0]), run(inputs.rootDepth!.range[1])] as const) : null;
  const last = central.at(-1)!;
  const condition = last.depletionMm > last.rawMm ? "stress_likely" : last.depletionMm > 0.8 * last.rawMm ? "approaching_stress" : "no_stress_expected";
  const seasonEnded = through === seasonEnd && yesterday >= seasonEnd;
  const sum = (k: keyof DailyState) => round1(central.reduce((s, d) => s + (d[k] as number), 0));
  const depletionRangeMm: [number, number] | null = range
    ? [round1(Math.min(range[0].at(-1)!.depletionMm, range[1].at(-1)!.depletionMm)), round1(Math.max(range[0].at(-1)!.depletionMm, range[1].at(-1)!.depletionMm))]
    : null;
  const conditionText = {
    no_stress_expected: "below the readily available water: no water stress expected",
    approaching_stress: "approaching the readily available water: stress may begin soon without rain or irrigation",
    stress_likely: "beyond the readily available water: the crop is likely under water stress",
  }[condition];
  return {
    ...base,
    status: "estimated",
    statusText: `Estimated root-zone depletion on ${last.date}: ${round1(last.depletionMm)} mm${depletionRangeMm ? ` (${depletionRangeMm[0]}–${depletionRangeMm[1]} mm across the rooting-depth range)` : ""}, ${conditionText}.${seasonEnded ? " The season (by its stage lengths) has ended." : ""}`,
    throughDate: through,
    missingInputs: [],
    weather,
    current: {
      date: last.date,
      stage: last.stage,
      depletionMm: round1(last.depletionMm),
      depletionRangeMm,
      rawMm: round1(last.rawMm),
      tawMm: round1(last.tawMm),
      ks: Math.round(last.ks * 100) / 100,
      condition,
      refillMm: round1(last.depletionMm),
      seasonEnded,
    },
    totals: {
      et0Mm: sum("et0Mm"),
      etcAdjMm: sum("etcAdjMm"),
      precipMm: sum("precipMm"),
      effectivePrecipMm: sum("effectivePrecipMm"),
      irrigationMm: sum("irrigationMm"),
      deepPercolationMm: sum("deepPercolationMm"),
    },
    series: central.map((d) => ({ date: d.date, depletionMm: round1(d.depletionMm), rawMm: round1(d.rawMm), tawMm: round1(d.tawMm), etcAdjMm: round1(d.etcAdjMm), effectivePrecipMm: round1(d.effectivePrecipMm), irrigationMm: d.irrigationMm, ks: Math.round(d.ks * 100) / 100 })),
    assumptions,
    recommendation:
      condition === "no_stress_expected"
        ? "No action indicated by this estimate. Verify with a soil-moisture reading before relying on it for scheduling."
        : `Check soil moisture in the root zone (probe or feel method) before irrigating. If confirmed, about ${round1(last.depletionMm)} mm net would return the root zone to field capacity; the estimate's uncertainty is shown above.`,
  };
}
