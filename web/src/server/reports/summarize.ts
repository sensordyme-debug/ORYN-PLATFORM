/**
 * Report summaries.
 *
 * A deterministic template narrative is always produced from the report's
 * structured findings. When ANTHROPIC_API_KEY is configured (and the report
 * did not opt out), an AI narrative is requested as well.
 *
 * Guarantees
 *  - The model receives ONLY the structured findings (with their evidence
 *    ids and labels) and limitation statements — never raw rows, user
 *    content, or anything outside the snapshot.
 *  - Every AI sentence must cite evidence ids in square brackets; sentences
 *    citing an unknown id, or citing nothing, are dropped. If nothing valid
 *    remains, or the request fails or is refused, the template is used and
 *    summary_method records why: 'template (ai_unavailable: <reason>)'.
 *  - No numeric confidence is requested or produced.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "@/server/config/env";
import { integrationEnabled } from "@/server/integrations";
import { log } from "@/server/log";
import { REPORT_TYPE_LABEL, type ReportContent, type ReportSummary } from "@/server/reports/types";

export const AI_SUMMARY_SCHEMA = z.object({
  sentences: z
    .array(z.object({ text: z.string().describe("One sentence with its evidence ids in square brackets, e.g. [E3] or [E3, L2].") }))
    .describe("The summary, one sentence per item, in reading order."),
});
export type AiSummary = z.infer<typeof AI_SUMMARY_SCHEMA>;

export const AI_SYSTEM_PROMPT = [
  "You write short summaries of satellite, weather, warning, news, and alert findings for agricultural operators and municipal staff.",
  "Use only the findings in the user message. Do not add facts, causes, conditions, places, or events that the findings do not state, and do not speculate.",
  "Every sentence must cite the ids it relies on in square brackets, using only ids that appear in the input: finding evidence ids (E…) or limitation ids (L…). Example: \"Mean NDVI fell from 0.71 to 0.55 [E3, E9].\"",
  "Keep the kinds of information distinct using the same wording as the findings: recorded observations, model estimates, forecasts, official warnings, candidate changes (not confirmed), and news claims (not verified).",
  "If the findings say data is missing or stale, say so plainly. Include at least one sentence stating the most important limitations, citing L ids.",
  "Write 4 to 10 plain sentences without headings or bullet points. Do not give any numeric confidence or probability that is not in the findings.",
].join("\n");

/** The minimal client surface used here (the Anthropic SDK client satisfies it; tests pass a stub). */
export type SummaryClient = {
  messages: {
    parse(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): PromiseLike<{ stop_reason: Anthropic.StopReason | null; parsed_output?: unknown }>;
  };
};

export type SummarizeOptions = {
  /** Set false to skip the AI narrative (e.g. the report params opted out). Default true. */
  ai?: boolean;
  client?: SummaryClient;
  model?: string;
};

// ── Template ───────────────────────────────────────────────────

/** Append a citation inside the sentence's final period: "… drawn [E1]." */
function withCitation(text: string, ids: string[]): string {
  if (!ids.length) return text;
  const tag = ` [${ids.join(", ")}]`;
  return text.endsWith(".") ? `${text.slice(0, -1)}${tag}.` : `${text}${tag}`;
}

export function templateSummary(content: ReportContent): string {
  const subject = content.aoi ? content.aoi.name : content.org.name;
  const parts: string[] = [
    `${REPORT_TYPE_LABEL[content.report.type]} for ${subject}, ${content.report.period.from.slice(0, 10)} to ${content.report.period.to.slice(0, 10)}.`,
  ];
  for (const f of content.findings) parts.push(withCitation(f.text, f.evidence_ids));
  // Missing or stale data that no finding already states.
  const statements = [
    content.detections?.statement,
    ...(content.weather?.kinds.map((k) => k.statement) ?? []),
    content.weather?.statement,
    content.processing?.statement,
    content.audit?.statement,
  ].filter((s): s is NonNullable<typeof s> => Boolean(s) && (s!.status === "missing" || s!.status === "stale"));
  for (const s of statements) {
    const core = s.text.replace(/\.$/, "");
    if (!parts.some((p) => p.includes(core))) parts.push(s.text);
  }
  const lim = content.limitations.general[0];
  if (lim) parts.push(withCitation(lim.text, [lim.id]));
  return parts.join(" ");
}

// ── Citation validation ────────────────────────────────────────

const CITATION = /\[([^\]]*)\]/g;
const ID = /^[EL]\d{1,5}$/;

/** Ids cited in a sentence, or null when a bracket contains something that is not an id list. */
export function citedIds(text: string): string[] | null {
  const ids: string[] = [];
  for (const m of text.matchAll(CITATION)) {
    const inner = m[1]!.split(/[,;\s]+/).filter(Boolean);
    if (!inner.length || !inner.every((x) => ID.test(x))) return null;
    ids.push(...inner);
  }
  return [...new Set(ids)];
}

/** Keep only sentences whose citations all exist in the evidence index (and that cite at least one id). */
export function validateCitations(
  sentences: readonly { text: string }[],
  evidence: Readonly<Record<string, unknown>>,
): { kept: { text: string; evidence_ids: string[] }[]; dropped: number } {
  const kept: { text: string; evidence_ids: string[] }[] = [];
  let dropped = 0;
  for (const s of sentences) {
    const text = s.text.trim();
    const ids = citedIds(text);
    if (!text || !ids || ids.length === 0 || !ids.every((id) => Object.prototype.hasOwnProperty.call(evidence, id))) {
      dropped++;
      continue;
    }
    kept.push({ text, evidence_ids: ids });
  }
  return { kept, dropped };
}

// ── AI ─────────────────────────────────────────────────────────

/** The structured findings payload sent to the model (and nothing else). */
export function aiInput(content: ReportContent) {
  const cited = new Set(content.findings.flatMap((f) => f.evidence_ids));
  return {
    report_type: content.report.type,
    subject: content.aoi ? { name: content.aoi.name, area: content.aoi.area_text, synthetic_boundary: content.aoi.is_synthetic } : { organization: content.org.name },
    period: { from: content.report.period.from.slice(0, 10), to: content.report.period.to.slice(0, 10) },
    data_currency: content.data_currency.statement,
    findings: content.findings.map((f) => ({ section: f.section, text: f.text, evidence_ids: f.evidence_ids })),
    evidence: [...cited].map((id) => ({ id, label: content.evidence[id]?.label ?? "" })),
    limitations: [...content.limitations.general, ...content.limitations.models.flatMap((m) => m.limitations)].map((l) => ({ id: l.id, text: l.text })),
  };
}

function failureReason(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "rate_limited";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "connection_error";
  if (err instanceof Anthropic.APIError) return `api_error_${err.status ?? "unknown"}`;
  if (err instanceof Anthropic.AnthropicError) return "invalid_output";
  return "error";
}

export async function summarizeReport(content: ReportContent, opts: SummarizeOptions = {}): Promise<ReportSummary> {
  const template = templateSummary(content);
  const fallback = (reason: string | null): ReportSummary => ({
    method: reason ? `template (ai_unavailable: ${reason})` : "template",
    template,
    ai: null,
    text: template,
  });
  if (opts.ai === false) return fallback(null);
  const apiKey = env.anthropicApiKey();
  if (!opts.client && !apiKey) return fallback(null);
  // Unverified in this deployment (production): never send findings to the model.
  if (!opts.client && !integrationEnabled("ai-summaries")) return fallback("not_verified");
  if (content.findings.length === 0) return fallback("no_findings");

  const model = opts.model ?? env.aiModel();
  const client: SummaryClient = opts.client ?? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      output_config: { format: zodOutputFormat(AI_SUMMARY_SCHEMA), effort: "low" },
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(aiInput(content)) }],
    });
    if (response.stop_reason === "refusal") return fallback("refusal");
    if (response.stop_reason === "max_tokens") return fallback("max_tokens");
    const parsed = AI_SUMMARY_SCHEMA.safeParse(response.parsed_output);
    if (!parsed.success) return fallback("invalid_output");
    const { kept, dropped } = validateCitations(parsed.data.sentences, content.evidence);
    if (kept.length === 0) return fallback("no_valid_sentences");
    if (dropped) log.warn("reports.ai_summary.dropped_sentences", { reportId: content.report.id, dropped });
    return {
      method: `ai:${model}`,
      template,
      ai: { model, sentences: kept, dropped_sentences: dropped },
      text: kept.map((s) => s.text).join(" "),
    };
  } catch (err) {
    const reason = failureReason(err);
    log.warn("reports.ai_summary.failed", { reportId: content.report.id, reason, err });
    return fallback(reason);
  }
}
