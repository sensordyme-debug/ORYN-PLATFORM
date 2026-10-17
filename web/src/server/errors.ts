/**
 * Errors whose message is safe to show to the user. Anything else is logged
 * with a reference id and reported to the user generically.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 422 | 429 | 503 = 422,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function notFoundError(what = "Record") {
  return new DomainError("not_found", `${what} not found.`, 404);
}

/** Map a Postgres error to a DomainError when it is a known constraint violation. */
export function fromPgError(err: unknown): DomainError | null {
  const e = err as { code?: string; message?: string; constraint_name?: string };
  if (!e || typeof e.code !== "string") return null;
  switch (e.code) {
    case "23505":
      return new DomainError("conflict", "A record with these details already exists.", 409);
    case "22023":
      return new DomainError("invalid_geometry", e.message ?? "Invalid geometry.", 422);
    case "23514":
      return new DomainError("invalid", "One or more values are outside the allowed range.", 422);
    case "42501":
      return new DomainError("forbidden", "This operation is not permitted.", 422);
    case "OR001":
      // Raised by db/migrations/0006 trial-isolation triggers; the message is ours.
      return new DomainError("trial_restricted", e.message ?? "Trial-only accounts are restricted to trial organizations.", 409);
    default:
      return null;
  }
}
