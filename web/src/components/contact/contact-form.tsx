"use client";

import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { INDUSTRY_OPTIONS, type ContactPayload, type ContactResponse } from "@/lib/contact-schema";
import { cn } from "@/lib/cn";

type Errors = Partial<Record<"name" | "email" | "message" | "form", string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(v: ContactPayload): Errors {
  const e: Errors = {};
  if (v.name.trim().length < 2) e.name = "Please enter your name.";
  if (!EMAIL_RE.test(v.email.trim())) e.email = "Please enter a valid email address.";
  if (v.message.trim().length < 10) e.message = "Please add a little more detail (10+ characters).";
  return e;
}

export function ContactForm({ fallbackEmail }: { fallbackEmail: string | null }) {
  const params = useSearchParams();
  const [intent, setIntent] = useState<ContactPayload["intent"]>(params.get("intent") === "demo" ? "demo" : "general");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [mode, setMode] = useState<"delivered" | "development">("delivered");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const markStart = () => {
    if (startedAt.current === null) startedAt.current = Date.now();
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload: ContactPayload = {
      name: String(fd.get("name") ?? ""),
      organization: String(fd.get("organization") ?? ""),
      email: String(fd.get("email") ?? ""),
      industry: String(fd.get("industry") ?? "") as ContactPayload["industry"],
      intent,
      message: String(fd.get("message") ?? ""),
      website: String(fd.get("website") ?? ""),
      elapsed: startedAt.current ? Date.now() - startedAt.current : 0,
    };
    const v = validate(payload);
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      const first = Object.keys(v)[0];
      formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setStatus("submitting");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as ContactResponse | null;
      if (data?.ok) {
        setMode(data.mode);
        setStatus("success");
        return;
      }
      setStatus("error");
      if (data && !data.ok && data.error === "invalid" && data.fields) {
        setErrors(data.fields as Errors);
        setFormError("Please check the highlighted fields.");
      } else if (data && !data.ok && data.error === "rate_limited") {
        setFormError("Too many submissions in a short time. Please try again in a few minutes.");
      } else if (data && !data.ok && data.error === "not_configured") {
        setFormError(
          fallbackEmail
            ? `Our inquiry form isn't connected to email delivery yet. Please write to us directly at ${fallbackEmail}.`
            : "Our inquiry form isn't connected to email delivery yet, so your message was not sent. Please check back soon.",
        );
      } else {
        setFormError("Something went wrong and your message was not sent. Please try again.");
      }
    } catch {
      setStatus("error");
      setFormError("Network error — your message was not sent. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="border-t border-ink-900/15 pt-10" role="status">
        <p className="t-eyebrow text-ink-900/60">{intent === "demo" ? "Demo request" : "Message"} received</p>
        <h2 className="t-h3 mt-4 max-w-lg">Thank you. We&apos;ll be in touch.</h2>
        <p className="t-body mt-4 max-w-lg text-ink-900/65">
          A member of the ORYN team will reply to the email address you provided.
        </p>
        {mode === "development" ? (
          <p className="t-mono mt-6 max-w-lg rounded-[3px] bg-ink-900/[0.05] p-3 text-ink-900/70">
            Development mode: email delivery is not configured, so this submission was logged to the server console instead of being sent. See README → Contact form.
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setStatus("idle");
            startedAt.current = null;
          }}
          className="mt-8 text-[0.9375rem] font-medium underline underline-offset-4"
        >
          Send another message
        </button>
      </motion.div>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} onFocusCapture={markStart} noValidate className="space-y-8" aria-describedby={formError ? "form-error" : undefined}>
      <fieldset>
        <legend className="t-eyebrow text-ink-900/60">I&apos;d like to</legend>
        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-ink-900/15 bg-ink-900/15">
          {(
            [
              ["general", "Get in touch"],
              ["demo", "Request a demo"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-center justify-center gap-2 px-4 py-3.5 text-[0.9375rem] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal",
                intent === value ? "bg-ink-900 text-bone-50" : "bg-bone-100 text-ink-900 hover:bg-bone-50",
              )}
            >
              <input type="radio" name="intent" value={value} checked={intent === value} onChange={() => setIntent(value)} className="sr-only" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-8 md:grid-cols-2">
        <Field label="Name" name="name" autoComplete="name" required error={errors.name} />
        <Field label="Organization" name="organization" autoComplete="organization" optional />
        <Field label="Email" name="email" type="email" autoComplete="email" required error={errors.email} />
        <div>
          <label htmlFor="industry" className="t-eyebrow block text-ink-900/60">
            Industry <span className="normal-case tracking-normal text-ink-900/60">(optional)</span>
          </label>
          <div className="relative mt-2">
            <select
              id="industry"
              name="industry"
              defaultValue=""
              className="h-12 w-full appearance-none border-b border-ink-900/25 bg-transparent pr-8 text-[1.0625rem] outline-none transition-colors focus:border-ink-900"
            >
              <option value="">Select an industry</option>
              {INDUSTRY_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <svg viewBox="0 0 12 12" className="pointer-events-none absolute right-1 top-1/2 size-3 -translate-y-1/2 text-ink-900/60" aria-hidden="true">
              <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="message" className="t-eyebrow block text-ink-900/60">
          {intent === "demo" ? "What would you like to see?" : "Message"}
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          maxLength={4000}
          aria-invalid={!!errors.message}
          aria-describedby={errors.message ? "message-error" : undefined}
          placeholder={intent === "demo" ? "Tell us about your land, site, or project — and what you'd like to understand from above." : "How can we help?"}
          className={cn(
            "mt-2 w-full resize-y border-b bg-transparent py-2 text-[1.0625rem] leading-relaxed outline-none transition-colors placeholder:text-ink-900/30 focus:border-ink-900",
            errors.message ? "border-[#c2410c]" : "border-ink-900/25",
          )}
        />
        {errors.message ? (
          <p id="message-error" className="mt-2 text-[0.875rem] text-[#c2410c]">
            {errors.message}
          </p>
        ) : null}
      </div>

      {/* Honeypot — hidden from people, tempting to bots */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <AnimatePresence>
        {formError ? (
          <motion.p
            id="form-error"
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-[3px] border border-[#c2410c]/30 bg-[#c2410c]/[0.06] p-4 text-[0.9375rem] text-[#9a3412]"
          >
            {formError}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-col gap-5 border-t border-ink-900/15 pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="t-small max-w-sm text-ink-900/65">
          We use your details only to respond to your inquiry.
        </p>
        <button
          type="submit"
          disabled={status === "submitting"}
          className="group inline-flex h-13 min-w-[200px] items-center justify-center gap-3 rounded-[2px] bg-ink-900 px-7 py-4 text-[0.9375rem] font-medium text-bone-50 transition-colors hover:bg-ink-700 disabled:opacity-60"
        >
          {status === "submitting" ? "Sending…" : intent === "demo" ? "Request a demo" : "Send message"}
          <svg viewBox="0 0 16 16" className="size-4 transition-transform group-hover:translate-x-0.5" fill="none" aria-hidden="true">
            <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  required,
  optional,
  error,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  optional?: boolean;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="t-eyebrow block text-ink-900/60">
        {label} {optional ? <span className="normal-case tracking-normal text-ink-900/60">(optional)</span> : null}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        maxLength={type === "email" ? 200 : 120}
        aria-invalid={!!error}
        aria-describedby={error ? `${name}-error` : undefined}
        className={cn(
          "mt-2 h-12 w-full border-b bg-transparent text-[1.0625rem] outline-none transition-colors focus:border-ink-900",
          error ? "border-[#c2410c]" : "border-ink-900/25",
        )}
      />
      {error ? (
        <p id={`${name}-error`} className="mt-2 text-[0.875rem] text-[#c2410c]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
