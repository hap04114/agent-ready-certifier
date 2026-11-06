import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // PGlite (in-process Postgres) takes a few seconds to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
