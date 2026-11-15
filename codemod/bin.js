#!/usr/bin/env node
// npx got-api-engine-codemod v4 <paths...> [--preserve-behavior] [--dry] [--print]
"use strict";

const path = require("node:path");

function usage(code) {
  process.stderr.write(
    [
      "Usage: got-api-engine-codemod v4 <paths...> [options]",
      "",
      "  --preserve-behavior  Pin v3 defaults explicitly (deadline, breaker scope, strictPath, X-Forwarded-For)",
      "  --dry                Report only, write nothing",
      "  --print              Print transformed files",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage(0);
  const [migration, ...rest] = args;
  if (migration !== "v4") usage(1);
  const paths = rest.filter((a) => !a.startsWith("--"));
  if (paths.length === 0) usage(1);

  const { run } = require("jscodeshift/src/Runner");
  const result = await run(path.join(__dirname, "transforms", "v4.js"), paths, {
    parser: "tsx",
    extensions: "ts,tsx,js,jsx,mjs,cjs,mts,cts",
    ignorePattern: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    dry: rest.includes("--dry"),
    print: rest.includes("--print"),
    preserveBehavior: rest.includes("--preserve-behavior"),
    verbose: 0,
    babel: false,
    silent: false,
  });
  process.exitCode = result.error > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
