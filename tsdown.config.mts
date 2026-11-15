import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "adapters/next": "src/adapters/next/index.ts",
      "adapters/node": "src/adapters/node.ts",
      redis: "src/stores/redis.ts",
      testing: "src/testing/index.ts",
      codegen: "src/cli/openapi.ts",
    },
    format: ["cjs", "esm"],
    platform: "node",
    target: "node22",
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
  },
  {
    entry: { cli: "src/cli/bin.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: false,
    clean: false,
  },
]);
