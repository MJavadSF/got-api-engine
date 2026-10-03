import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/next": "src/adapters/next.ts",
    "adapters/node": "src/adapters/node.ts",
  },
  format: ["cjs", "esm"],
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
