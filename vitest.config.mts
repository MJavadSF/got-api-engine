import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/setup/certs.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "src/cli/bin.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 88,
        // The request path gets a stricter gate.
        "src/pipeline/**": { lines: 92, functions: 90, branches: 85, statements: 90 },
      },
    },
  },
});
