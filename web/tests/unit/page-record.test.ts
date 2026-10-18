import { describe, expect, it } from "vitest";
import { AccessError } from "@/server/authz/access";
import { getPageRecord } from "@/server/authz/next";
import { DomainError, notFoundError } from "@/server/errors";

/** Next.js marks notFound() with this digest; the org's not-found page renders it inside the shell. */
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;
const digest = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e);
  }
};

describe("record pages", () => {
  it("return the record when it loads", async () => {
    await expect(getPageRecord(Promise.resolve({ id: "r1" }))).resolves.toEqual({ id: "r1" });
  });

  it("render not-found (not a server error) for a missing record, one outside the member's areas, or one their role cannot open", async () => {
    expect(await digest(getPageRecord(Promise.reject(notFoundError("Report"))))).toMatch(NOT_FOUND);
    expect(await digest(getPageRecord(Promise.reject(new AccessError(404, "not_found", "Area not found."))))).toMatch(NOT_FOUND);
    expect(await digest(getPageRecord(Promise.reject(new AccessError(403, "forbidden", 'This action requires the "audit.read" permission.'))))).toMatch(NOT_FOUND);
  });

  it("let other failures reach the error boundary unchanged", async () => {
    const conflict = new DomainError("conflict", "Already exists.", 409);
    await expect(getPageRecord(Promise.reject(conflict))).rejects.toBe(conflict);
    const crash = new Error("connection refused");
    await expect(getPageRecord(Promise.reject(crash))).rejects.toBe(crash);
  });
});
