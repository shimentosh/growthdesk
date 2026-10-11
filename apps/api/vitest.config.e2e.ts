import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./test/env.js";

// API integration tests: a real Postgres test database and Redis (docker compose up).
export default defineConfig({
  test: {
    globals: true,
    root: "./",
    include: ["test/**/*.e2e-spec.ts"],
    globalSetup: ["./test/global-setup.ts"],
    env: TEST_ENV,
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
