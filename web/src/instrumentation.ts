/**
 * Runs once when a Next.js server instance starts (not during `next build`).
 * In production the server refuses to start when the deployment is unsafe —
 * see src/server/config/preflight.ts and docs/DEPLOYMENT.md.
 */
export async function register() {
  // Node-only code lives in its own module so the Edge build never includes it.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    await import("./instrumentation-node");
  }
}
