import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "adapters/next": "src/adapters/next.ts",
      "adapters/node": "src/adapters/node.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ["next", "zod"],
    banner: {
      js: `/**
 * got-api-engine
 * A modular, framework-agnostic HTTP proxy engine built on got.
 * @author MJavadSF
 * @license MIT
 */`,
    },
  },
]);
