export const INDUSTRY_OPTIONS = [
  "Agriculture",
  "Environmental monitoring",
  "Construction",
  "Disaster response",
  "Search & rescue",
  "Research / academic",
  "Investment",
  "Other",
] as const;

export const INTENT_OPTIONS = ["general", "demo"] as const;

export type ContactPayload = {
  name: string;
  organization: string;
  email: string;
  industry: (typeof INDUSTRY_OPTIONS)[number] | "";
  intent: (typeof INTENT_OPTIONS)[number];
  message: string;
  /** Honeypot — must stay empty. */
  website: string;
  /** Milliseconds between form render and submit. */
  elapsed: number;
};

export type ContactResponse =
  | { ok: true; mode: "delivered" | "development" }
  | { ok: false; error: "invalid" | "rate_limited" | "not_configured" | "delivery_failed"; fields?: Record<string, string> };
