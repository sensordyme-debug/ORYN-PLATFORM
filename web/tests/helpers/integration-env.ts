import { testDatabaseUrls } from "./test-env";

const { app, owner } = testDatabaseUrls();
process.env.DATABASE_URL = app;
process.env.DATABASE_OWNER_URL = owner;
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123456789";
process.env.ORYN_STORAGE_DIR = "./var/test-storage";
process.env.LOG_LEVEL ??= "error";
