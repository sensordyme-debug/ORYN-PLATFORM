import { NextResponse } from "next/server";
import { z } from "zod";
import { INDUSTRY_OPTIONS, INTENT_OPTIONS, type ContactResponse } from "@/lib/contact-schema";
import { clientIp } from "@/server/http";
import { integrationEnabled } from "@/server/integrations";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(2, "Please enter your name.").max(100),
  organization: z.string().trim().max(120).optional().default(""),
  email: z.string().trim().max(200).pipe(z.email("Please enter a valid email address.")),
  industry: z.union([z.enum(INDUSTRY_OPTIONS), z.literal("")]).optional().default(""),
  intent: z.enum(INTENT_OPTIONS).default("general"),
  message: z.string().trim().min(10, "Please add a little more detail (10+ characters).").max(4000),
  website: z.string().max(0).optional().default(""),
  elapsed: z.number().optional().default(0),
});

// Best-effort, per-instance rate limiting. On serverless platforms each
// instance keeps its own window; pair with a platform firewall rule
// (e.g. Vercel WAF) for stronger guarantees.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

function json(body: ContactResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const ip = clientIp(req.headers) ?? "unknown";
  if (rateLimited(ip)) return json({ ok: false, error: "rate_limited" }, 429);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid" }, 400);
  }

  // Honeypot or implausibly fast submission: accept silently, do nothing.
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if ((typeof r.website === "string" && r.website.length > 0) || (typeof r.elapsed === "number" && r.elapsed < 2500)) {
      return json({ ok: true, mode: "delivered" });
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      if (!fields[key]) fields[key] = issue.message;
    }
    return json({ ok: false, error: "invalid", fields }, 422);
  }
  const data = parsed.data;

  const subject = `${data.intent === "demo" ? "Demo request" : "Inquiry"} — ${data.name}${data.organization ? ` (${data.organization})` : ""}`;
  const text = [
    `Type: ${data.intent === "demo" ? "Request a demo" : "General inquiry"}`,
    `Name: ${data.name}`,
    `Organization: ${data.organization || "—"}`,
    `Email: ${data.email}`,
    `Industry: ${data.industry || "—"}`,
    "",
    data.message,
  ].join("\n");

  const { RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL } = process.env;

  // In production, email stays off until verified in this deployment (src/server/integrations.ts).
  if (RESEND_API_KEY && CONTACT_TO_EMAIL && CONTACT_FROM_EMAIL && integrationEnabled("email")) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: CONTACT_FROM_EMAIL,
          to: CONTACT_TO_EMAIL.split(",").map((s) => s.trim()),
          reply_to: data.email,
          subject,
          text,
        }),
      });
      if (!res.ok) {
        console.error("[contact] Resend responded", res.status, await res.text().catch(() => ""));
        return json({ ok: false, error: "delivery_failed" }, 502);
      }
      return json({ ok: true, mode: "delivered" });
    } catch (err) {
      console.error("[contact] delivery error", err);
      return json({ ok: false, error: "delivery_failed" }, 502);
    }
  }

  if (process.env.NODE_ENV !== "production") {
    console.info("\n[contact] Email delivery not configured — development submission:\n" + `Subject: ${subject}\n${text}\n`);
    return json({ ok: true, mode: "development" });
  }

  console.error("[contact] Submission received but email delivery is not available (set RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL, and verify email — see docs/DEPLOYMENT.md).");
  return json({ ok: false, error: "not_configured" }, 503);
}
