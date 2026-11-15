#!/usr/bin/env node
// End-to-end check of got-api-engine/next inside a real Next.js app.
//
//   node test/next-app/run.mjs --next 15 [--bundle] [--tarball path/to/got-api-engine.tgz] [--keep]
//
// Builds the fixture app in test/next-app/.work/next-<major> against the
// packed package (what users install from npm), runs `next build` and
// `next start`, then exercises Route Handlers, the catch-all proxy, a Server
// Component, a real Server Action (progressive-enhancement form post), SSE
// streaming, multipart uploads, cookie auth + CSRF, stale-while-revalidate via
// `after`, client aborts and metrics against a mock upstream.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const major = Number(arg("next", "15"));
const keep = args.includes("--keep");
const bundle = args.includes("--bundle"); // let Next bundle the package instead of loading it externally
// Outside the repository on purpose: no parent lockfile / node_modules can leak
// into module resolution, so the app sees only what a user would install.
const work = resolve(arg("work", join(tmpdir(), "gae-next-e2e")));

const VERSIONS = {
  14: { next: "^14.2.35", react: "^18.3.1", types: "^18.3.0" },
  15: { next: "^15.5.0", react: "^19.0.0", types: "^19.0.0" },
  16: { next: "^16.0.0", react: "^19.2.0", types: "^19.0.0" },
};
if (!VERSIONS[major]) throw new Error(`Unsupported Next.js major: ${major}`);

const label = `next-${major}${bundle ? "-bundled" : ""}`;
const log = (...m) => console.log(`[${label}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Package under test ───────────────────────────────────────
function packTarball() {
  const given = arg("tarball");
  if (given) return resolve(given);
  log("building and packing got-api-engine …");
  execFileSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit" });
  const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: root }).toString().trim();
  return join(work, out.split("\n").pop());
}

// ── 2. Fixture app ──────────────────────────────────────────────
function prepareApp(tarball) {
  const dir = join(work, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(here, "template"), dir, { recursive: true });
  const v = VERSIONS[major];
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `gae-next-${major}`,
        private: true,
        scripts: { build: "next build", start: "next start" },
        dependencies: {
          "got-api-engine": `file:${tarball}`,
          next: v.next,
          react: v.react,
          "react-dom": v.react,
          zod: "^3.25.0",
        },
        devDependencies: {
          typescript: "^5.9.0",
          "@types/node": "^22.0.0",
          "@types/react": v.types,
          "@types/react-dom": v.types,
        },
      },
      null,
      2,
    ),
  );
  log("installing dependencies …");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "inherit" });
  const installed = JSON.parse(
    execFileSync("node", ["-p", "JSON.stringify(require('next/package.json').version)"], { cwd: dir }).toString(),
  );
  log(`next ${installed}`);
  return { dir, nextVersion: installed };
}

// ── 3. Mock upstream ────────────────────────────────────────────
function startUpstream() {
  let counter = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://upstream");
    const p = url.pathname;

    if (req.method === "GET" && p === "/users/1") return json(200, { id: 1, name: "Sara" });
    if (req.method === "GET" && p === "/users") return json(200, { lang: req.headers["accept-language"] ?? null });
    if (req.method === "POST" && p === "/users") {
      const data = JSON.parse(body.toString() || "{}");
      if (typeof data.name !== "string" || data.name.length < 2) {
        return json(422, { message: "Validation failed", fieldErrors: { name: ["too short"] } });
      }
      return json(201, { created: data });
    }
    if (req.method === "GET" && p === "/users/slow") {
      await sleep(400);
      return json(200, { slow: true });
    }
    if (req.method === "GET" && p.startsWith("/users/")) return json(200, { id: p.slice(7) });
    if (p === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: 1\n\n");
      await sleep(600);
      res.end("data: 2\n\n");
      return;
    }
    if (p === "/secure") return json(200, { auth: req.headers.authorization ?? null });
    if (p === "/upload") return json(200, { contentType: req.headers["content-type"] ?? null, length: body.length });
    if (p === "/counter") return json(200, { n: ++counter });
    json(404, { message: "not found" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// ── 4. Next build + start ───────────────────────────────────────
function freePort() {
  return new Promise((r) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
}

async function startNext(dir, env) {
  log("next build …");
  execFileSync("npx", ["next", "build"], { cwd: dir, env, stdio: "inherit" });
  const port = await freePort();
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${base}/api/metrics`);
      return { child, base, output: () => output };
    } catch {
      await sleep(250);
    }
  }
  child.kill("SIGTERM");
  throw new Error(`next start did not come up:\n${output}`);
}

// ── 5. Checks ───────────────────────────────────────────────────
const unescapeHtml = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function checks(base) {
  const list = [];
  const check = (name, fn) => list.push({ name, fn });
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const eq = (a, b, what) =>
    expect(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

  check("Server Component renders data fetched with serverGet", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /<pre id="data">([\s\S]*?)<\/pre>/.exec(html);
    expect(m, "no <pre id=data> in page");
    eq(JSON.parse(unescapeHtml(m[1])), { id: 1, name: "Sara" }, "page data");
  });

  check("Route Handler GET forwards allow-listed headers and sets X-Request-Id", async () => {
    const res = await fetch(`${base}/api/users`, { headers: { "accept-language": "fa-IR" } });
    eq(res.status, 200, "status");
    eq(await res.json(), { lang: "fa-IR" }, "body");
    expect(res.headers.get("x-request-id"), "missing x-request-id");
  });

  check("Route Handler POST: schema-valid JSON → 201, invalid → 400 + details, non-JSON → 415", async () => {
    const post = (body, type = "application/json") =>
      fetch(`${base}/api/users`, { method: "POST", headers: { "content-type": type }, body });
    const ok = await post(JSON.stringify({ name: "Sara" }));
    eq(ok.status, 201, "valid status");
    eq(await ok.json(), { created: { name: "Sara" } }, "valid body");
    const bad = await post(JSON.stringify({ name: "a" }));
    eq(bad.status, 400, "invalid status");
    expect((await bad.json()).details, "invalid body has no details");
    eq((await post('{"name":"Sara"}', "text/plain")).status, 415, "text/plain status");
  });

  check("Catch-all proxy forwards allow-listed paths only", async () => {
    const ok = await fetch(`${base}/api/proxy/users/7`);
    eq(ok.status, 200, "allowed status");
    eq(await ok.json(), { id: "7" }, "allowed body");
    eq((await fetch(`${base}/api/proxy/orders/1`, { method: "DELETE" })).status, 404, "method not allowed");
    eq((await fetch(`${base}/api/proxy/admin`)).status, 404, "path not allowed");
  });

  check("SSE is streamed through (first event arrives before upstream finishes)", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/api/sse`);
    expect(res.headers.get("content-type")?.startsWith("text/event-stream"), `content-type ${res.headers.get("content-type")}`);
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const text = new TextDecoder().decode(first.value) + rest;
    eq(text, "data: 1\n\ndata: 2\n\n", "stream body");
    expect(firstAt < 500, `first event after ${firstAt}ms — response was buffered`);
  });

  check("Cookie auth + CSRF: same-origin → Bearer from cookie, cross-site → 403, no cookie → 401 (fa)", async () => {
    const post = (headers) => fetch(`${base}/api/secure`, { method: "POST", headers });
    const ok = await post({ cookie: "theme=dark; at=tok123", origin: base });
    eq(await ok.json(), { auth: "Bearer tok123" }, "auth forwarded");
    eq((await post({ cookie: "at=tok123", origin: "https://evil.example" })).status, 403, "cross-site");
    const missing = await post({ origin: base });
    eq(missing.status, 401, "no cookie status");
    eq((await missing.json()).error, "برای این کار باید وارد حساب کاربری شوید.", "persian message");
  });

  check("Multipart upload is forwarded; oversized body → 413", async () => {
    const small = new FormData();
    small.append("file", new Blob([new Uint8Array(1000)]), "a.bin");
    const res = await fetch(`${base}/api/upload`, { method: "POST", body: small });
    const data = await res.json();
    expect(data.contentType?.startsWith("multipart/form-data; boundary="), `content-type ${data.contentType}`);
    expect(data.length > 1000, `length ${data.length}`);
    const big = new FormData();
    big.append("file", new Blob([new Uint8Array(100 * 1024)]), "b.bin");
    eq((await fetch(`${base}/api/upload`, { method: "POST", body: big })).status, 413, "oversized");
  });

  check("Server Action (real form post) → serverForm → useActionState-ready state", async () => {
    const html = await (await fetch(`${base}/action`)).text();
    const hidden = [...html.matchAll(/<input type="hidden" name="(\$ACTION_[^"]+)"(?: value="([^"]*)")?/g)];
    expect(hidden.length > 0, "no $ACTION hidden field in the form");
    const submit = async (name) => {
      const form = new FormData();
      for (const [, k, v] of hidden) form.append(k, unescapeHtml(v ?? ""));
      form.append("name", name);
      const res = await fetch(`${base}/action`, { method: "POST", body: form, redirect: "manual", headers: { origin: base } });
      const location = res.headers.get("location") ?? "";
      expect([303, 307].includes(res.status), `status ${res.status}`);
      return JSON.parse(new URL(location, base).searchParams.get("state"));
    };
    eq(await submit("Sara"), { ok: true, data: { created: { name: "Sara" } } }, "valid action state");
    const invalid = await submit("x");
    eq(invalid.ok, false, "invalid ok");
    eq(invalid.fieldErrors, { name: ["too short"] }, "field errors");
  });

  check("stale-while-revalidate: background refresh completes (after/waitUntil)", async () => {
    const get = async () => {
      const res = await fetch(`${base}/api/swr`);
      return { cache: res.headers.get("x-cache"), n: (await res.json()).n };
    };
    const a = await get();
    await sleep(120); // entry is stale now
    const b = await get();
    eq(b.cache, "STALE", "second response");
    eq(b.n, a.n, "stale value");
    await sleep(300);
    const c = await fetch(`${base}/api/swr`);
    const cn = (await c.json()).n;
    expect(cn > a.n, `background revalidation did not update the cache (n=${cn})`);
  });

  check("a client abort does not affect other in-flight requests (deduped, req.signal)", async () => {
    const ctl = new AbortController();
    const aborted = fetch(`${base}/api/proxy/users/slow`, { signal: ctl.signal }).catch((e) => e.name);
    const others = [1, 2, 3].map(() => fetch(`${base}/api/proxy/users/slow`).then((r) => r.status));
    await sleep(100);
    ctl.abort();
    eq(await aborted, "AbortError", "aborted request");
    eq(await Promise.all(others), [200, 200, 200], "other requests");
  });

  check("metrics are exposed in Prometheus format", async () => {
    const text = await (await fetch(`${base}/api/metrics`)).text();
    expect(/got_api_engine_requests_total\{service="got-api-engine"\} \d+/.test(text), "requests_total missing");
  });

  return list;
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  mkdirSync(work, { recursive: true });
  const tarball = packTarball();
  const { dir, nextVersion } = prepareApp(tarball);
  const upstream = await startUpstream();
  const env = {
    ...process.env,
    NEXT_MAJOR: String(major),
    GAE_BUNDLE: bundle ? "1" : "0",
    NEXT_TELEMETRY_DISABLED: "1",
    UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
    NODE_ENV: "production",
  };
  let app;
  let failed = 0;
  try {
    app = await startNext(dir, env);
    for (const { name, fn } of checks(app.base)) {
      try {
        await fn();
        log(`✓ ${name}`);
      } catch (err) {
        failed++;
        log(`✗ ${name}\n    ${err.message}`);
      }
    }
    if (failed) log(`server output:\n${app.output().slice(-4000)}`);
  } finally {
    app?.child.kill("SIGTERM");
    upstream.close();
    if (!keep && !failed) rmSync(dir, { recursive: true, force: true });
  }
  log(failed ? `${failed} check(s) FAILED on next ${nextVersion}` : `all checks passed on next ${nextVersion}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
