import { runMigrations } from "../../src/server/db/migrate";
import { testDatabaseUrls } from "./test-env";

export default async function setup() {
  const { owner } = testDatabaseUrls();
  await runMigrations(owner);
}
