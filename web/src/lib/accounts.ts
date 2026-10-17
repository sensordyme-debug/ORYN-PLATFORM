/**
 * Accounts created by username alone still need a unique email in Better
 * Auth's schema. They get an address under the reserved `.invalid` top-level
 * domain (RFC 2606/6761), which can never be delivered to or belong to anyone;
 * it is never shown, emailed, or marked verified.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "accounts.oryn.invalid";

export const isPlaceholderEmail = (email: string) => email.trim().toLowerCase().endsWith(".invalid");
