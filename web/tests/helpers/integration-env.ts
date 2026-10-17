import { testDatabaseUrls } from "./test-env";

const { app, owner } = testDatabaseUrls();
process.env.DATABASE_URL = app;
process.env.DATABASE_OWNER_URL = owner;
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123456789";
process.env.ORYN_STORAGE_DIR = "./var/test-storage";
process.env.LOG_LEVEL ??= "error";
// Open-Meteo's free API is non-commercial and off by default (see
// tests/unit/providers/licence-defaults.test.ts). These tests exercise the
// multi-provider context pipeline with mocked HTTP, so they opt in, as a
// non-commercial evaluation would; tests of the disabled state stub "false".
process.env.OPEN_METEO_ALLOW_NONCOMMERCIAL ??= "true";
