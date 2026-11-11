import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // Tests use the fixed placeholder catalog, not the live Channel3 snapshot.
    env: { DEMO_CATALOG: "placeholder" },
    // PGlite (in-process Postgres) takes a few seconds to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
