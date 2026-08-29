import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";

// Loaded here (not just relying on src/config/env.ts's own dotenv/config
// call) so `test.env` below can forward these into each test worker's
// process.env before any source file - and therefore config/env.ts's
// module-level parse - runs.
loadEnv({ path: ".env.test" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    // Integration tests share one Postgres database via truncate-between-tests
    // isolation (tests/setup.ts) rather than per-test transactions, so files
    // must not run concurrently against it.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL!,
      REDIS_URL: process.env.REDIS_URL!,
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET!,
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
      SMTP_HOST: process.env.SMTP_HOST!,
      SMTP_PORT: process.env.SMTP_PORT!,
      WEB_ORIGIN: process.env.WEB_ORIGIN!,
      STORAGE_DIR: process.env.STORAGE_DIR!,
    },
  },
});
