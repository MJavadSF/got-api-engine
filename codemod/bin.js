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

const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const IGNORED = new Set(["node_modules", "dist", ".next", ".git"]);
const USES_PACKAGE = /["']got-api-engine(\/[\w/-]+)?["']/;

/** Lists the files that import the package, so an empty run is explained instead of "N skipped". */
function findPackageUsers(paths) {
  const fs = require("node:fs");
  const found = [];
  const visit = (p) => {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (IGNORED.has(path.basename(p))) return;
      for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    } else if (EXTENSIONS.test(p) && USES_PACKAGE.test(fs.readFileSync(p, "utf8"))) {
      found.push(p);
    }
  };
  for (const p of paths) visit(p);
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage(0);
  const [migration, ...rest] = args;
  if (migration !== "v4") usage(1);
  const paths = rest.filter((a) => !a.startsWith("--"));
  if (paths.length === 0) usage(1);

  const users = findPackageUsers(paths);
  if (users.length === 0) {
    process.stdout.write(
      "No file under " + paths.join(", ") + ' imports "got-api-engine" — nothing to migrate.\n' +
        "If the engine is used from another folder (e.g. lib/ or app/), pass that path too.\n",
    );
    return;
  }
  process.stdout.write(users.length + ' file(s) import "got-api-engine":\n' + users.map((f) => "  " + f).join("\n") + "\n\n");

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
  process.stdout.write(
    "\nSummary: " + users.length + " file(s) use the package, " + (result.ok ?? 0) + (rest.includes("--dry") ? " would change" : " changed") +
      ". Lines marked REP need a manual look; \"skipped\" files had nothing to rewrite.\n",
  );
  process.exitCode = result.error > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
