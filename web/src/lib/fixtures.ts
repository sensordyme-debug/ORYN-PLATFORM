/**
 * End-to-end test fixtures (scripts/oryn/e2e-fixtures.ts) record their
 * invented imagery under this provider id. Anything derived from such an
 * asset is a test fixture, never an observation, and the UI must say so.
 */
export const FIXTURE_PROVIDER_ID = "e2e";

export function isFixtureProvider(providerId: string | null | undefined): boolean {
  return providerId === FIXTURE_PROVIDER_ID;
}
