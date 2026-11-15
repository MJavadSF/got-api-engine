#!/usr/bin/env node
// got-api-engine-codegen <openapi.json> [-o out.ts] [--import got-api-engine]

import { readFileSync, writeFileSync } from "node:fs";
import { generateFromOpenApi } from "./openapi";

function main(argv: string[]): number {
  const args = [...argv];
  let input: string | undefined;
  let output: string | undefined;
  let importFrom: string | undefined;
  while (args.length) {
    const a = args.shift() as string;
    if (a === "-o" || a === "--out") output = args.shift();
    else if (a === "--import") importFrom = args.shift();
    else if (a === "-h" || a === "--help") input = undefined;
    else input = a;
  }
  if (!input) {
    process.stderr.write("Usage: got-api-engine-codegen <openapi.json> [-o out.ts] [--import got-api-engine]\n");
    return 1;
  }
  if (/\.ya?ml$/i.test(input)) {
    process.stderr.write("YAML is not supported; convert the spec to JSON first (e.g. `npx yaml-to-json`).\n");
    return 1;
  }
  const doc = JSON.parse(readFileSync(input, "utf8")) as Record<string, unknown>;
  const code = generateFromOpenApi(doc, importFrom ? { importFrom } : {});
  if (output) writeFileSync(output, code);
  else process.stdout.write(code);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
