import { PreflightError, runStartupPreflight } from "@/server/config/preflight";

try {
  await runStartupPreflight("web");
} catch (err) {
  if (err instanceof PreflightError) {
    console.error(err.message);
    // Exit instead of serving requests with an unsafe configuration.
    process.exit(1);
  }
  throw err;
}
