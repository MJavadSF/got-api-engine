"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jscodeshift = require("jscodeshift");
const transform = require("../transforms/v4.js");

function run(source, options = {}, path = "app.ts") {
  const reports = [];
  const j = jscodeshift.withParser("tsx");
  const api = { jscodeshift: j, j, stats: () => {}, report: (m) => reports.push(m) };
  const out = transform({ path, source }, api, options);
  return { out: out ?? source, changed: out !== undefined, reports };
}

const has = (reports, text) => reports.some((r) => r.includes(text));
// recast re-prints edited objects on several lines; compare without whitespace.
const squash = (code) => code.replace(/\s+/g, "").replace(/,([}\]])/g, "$1");
const contains = (code, snippet) => assert.ok(squash(code).includes(squash(snippet)), `expected:\n${snippet}\nin:\n${code}`);

test("ignores files that do not use got-api-engine", () => {
  const src = `import axios from "axios";\nconst x = { cache: { cloneOnRead: false } };\nif (r.status === 500) {}\n`;
  const { changed, reports } = run(src);
  assert.equal(changed, false);
  assert.deepEqual(reports, []);
});

test("cloneOnRead: false → copy: \"none\"; cloneOnRead: true is removed", () => {
  const src = [
    `import { createEngine } from "got-api-engine";`,
    `const a = createEngine({ baseUrl: "x", cache: { enabled: true, cloneOnRead: false } });`,
    `const b = createEngine({ baseUrl: "x", cache: { enabled: true, cloneOnRead: true } });`,
  ].join("\n");
  const { out } = run(src);
  contains(out, `cache: { enabled: true, copy: "none" }`);
  contains(out, `cache: { enabled: true }`);
  assert.doesNotMatch(out, /cloneOnRead/);
});

test("non-literal cloneOnRead is reported, not rewritten", () => {
  const src = `import { createEngine } from "got-api-engine";\ncreateEngine({ baseUrl: "x", cache: { cloneOnRead: flag } });\n`;
  const { out, reports } = run(src);
  assert.match(out, /cloneOnRead: flag/);
  assert.ok(has(reports, "app.ts:2 cloneOnRead with a non-literal value"));
});

test("deprecated browser storage auth gets a single TODO", () => {
  const src = `import { createBrowserStorageAuth } from "got-api-engine";\nconst auth = createBrowserStorageAuth("t");\n`;
  const first = run(src).out;
  assert.match(first, /\/\/ TODO\(got-api-engine v4\): createBrowserStorageAuth is deprecated/);
  const second = run(first);
  assert.equal(second.changed, false, "idempotent");
});

test("--preserve-behavior pins v3 defaults (and is idempotent)", () => {
  const src = [
    `import { createNextEngine } from "got-api-engine/next";`,
    `export const api = createNextEngine({ baseUrl: "x", circuitBreaker: { enabled: true } });`,
    `export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/u" });`,
    `export const keep = createNextEngine({ baseUrl: "x", totalTimeoutMs: 5000, strictPath: true, circuitBreaker: { enabled: true, scope: "host" } });`,
  ].join("\n");
  const { out } = run(src, { preserveBehavior: true });
  contains(out, `circuitBreaker: { enabled: true, scope: "engine" }, totalTimeoutMs: 0, strictPath: false`);
  contains(out, `handleRoute(req, { endpoint: "/u", forwardClientIp: true })`);
  contains(out, `totalTimeoutMs: 5000, strictPath: true, circuitBreaker: { enabled: true, scope: "host" }`);
  assert.equal(run(out, { preserveBehavior: true }).changed, false, "idempotent");
});

test("without --preserve-behavior, behaviour changes are only reported", () => {
  const src = [
    `import { createNextEngine, createProxy } from "got-api-engine/next";`,
    `const api = createNextEngine({ baseUrl: "x", circuitBreaker: { enabled: true } });`,
    `const r = await api.get("/x");`,
    `if (r.status === 500) retry();`,
    `await api.post("/x", undefined, { body: null });`,
    `console.log(api.getMetrics()?.successCount);`,
    `export const { GET } = createProxy(api, { allow: ["/**"] });`,
  ].join("\n");
  const { changed, reports } = run(src);
  assert.equal(changed, false);
  assert.ok(has(reports, "app.ts:2 circuitBreaker is now per host"));
  assert.ok(has(reports, "app.ts:4 status 500 check"));
  assert.ok(has(reports, "app.ts:5 body: null"));
  assert.ok(has(reports, "app.ts:6 successCount now counts"));
  assert.ok(has(reports, "app.ts:7 X-Forwarded-For is no longer forwarded"));
});

test("deep imports are reported; CommonJS requires are recognised", () => {
  const deep = run(`import { x } from "got-api-engine/dist/engine-abc.mjs";\n`);
  assert.ok(has(deep.reports, "deep import"));
  const cjs = run(`const { createEngine } = require("got-api-engine");\ncreateEngine({ baseUrl: "x", cache: { cloneOnRead: false } });\n`, {}, "a.cjs");
  assert.match(cjs.out, /copy: "none"/);
});

test("handles JSX/TSX files", () => {
  const src = `import { createEngine } from "got-api-engine";\nconst api = createEngine({ baseUrl: "x", cache: { cloneOnRead: false } });\nexport const C = () => <div>{String(api)}</div>;\n`;
  assert.match(run(src, {}, "c.tsx").out, /copy: "none"/);
});
