/**
 * Test helpers for provider adapters: an injectable fetch that records calls
 * and fixture loading. Fixtures are real provider responses captured on
 * 2026-10-15 and trimmed to a few items (see tests/fixtures/providers).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FetchLike } from "@/server/providers/http";

const FIXTURES = path.resolve(__dirname, "../../fixtures/providers");

export function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

export function fixtureJson<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export type Call = { url: string; init: RequestInit | undefined };

export type MockFetch = FetchLike & { calls: Call[] };

export function mockFetch(handler: (url: string, init: RequestInit | undefined, call: number) => Response | Promise<Response>): MockFetch {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  }) as MockFetch;
  f.calls = calls;
  return f;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
}

export function bodyOf(call: Call | undefined): unknown {
  const b = call?.init?.body;
  return typeof b === "string" ? JSON.parse(b) : undefined;
}
