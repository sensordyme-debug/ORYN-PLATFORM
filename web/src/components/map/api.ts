"use client";

/** Typed client for the ORYN v1 API (session-cookie authenticated). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; fields?: Record<string, string> } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "http_error", body?.error?.message ?? `Request failed (${res.status})`, body?.error?.fields);
  }
  return body as T;
}

export const orgApi = (slug: string) => `/api/v1/orgs/${encodeURIComponent(slug)}`;
