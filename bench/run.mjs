#!/usr/bin/env node
// Benchmarks got-api-engine against fetch, undici, got, axios, ky and ofetch.
//
//   cd bench && npm install && node run.mjs [--rounds 3] [--only got,axios] [--out RESULTS.md]
//
// Every (client, scenario, round) runs in a fresh process against an upstream
// running in its own process. The median of the rounds is reported.

import { fork } from "node:child_process";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { clients } from "./clients.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const rounds = Number(arg("rounds", "3"));
const only = arg("only")?.split(",");
const out = arg("out");
const names = Object.keys(clients).filter((n) => !only || only.includes(n));
const scenarios = ["get-small-serial", "get-small-c50", "get-large-c10", "post-json-c50", "identical-burst"];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function runChild(file, argv) {
  return new Promise((resolve, reject) => {
    const child = fork(join(here, file), argv, { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.once("message", resolve);
    child.once("exit", (code) => code && reject(new Error(`${file} ${argv.join(" ")} exited ${code}`)));
  });
}

const server = fork(join(here, "server.mjs"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
const { port } = await new Promise((r) => server.once("message", r));
const base = `http://127.0.0.1:${port}`;

const results = {}; // scenario → client → { rps, p50, p99, rssMb }
for (const scenario of scenarios) {
  results[scenario] = {};
  for (const name of names) {
    const samples = [];
    // Rounds interleave clients across time to spread machine noise evenly.
    for (let r = 0; r < rounds; r++) samples.push(await runChild("worker.mjs", [name, scenario, base]));
    results[scenario][name] = {
      rps: median(samples.map((s) => s.rps)),
      p50: median(samples.map((s) => s.p50)),
      p99: median(samples.map((s) => s.p99)),
      rssMb: median(samples.map((s) => s.rssMb)),
      upstreamCalls: median(samples.map((s) => s.upstreamCalls)),
      cpuUs: median(samples.map((s) => s.cpuUs)),
    };
    console.log(scenario.padEnd(18), name.padEnd(24), JSON.stringify(results[scenario][name]));
  }
}
server.send("stop");

// ── Markdown report ─────────────────────────────────────────────
const titles = {
  "get-small-serial": "GET small JSON, 1 in flight (latency)",
  "get-small-c50": "GET small JSON, 50 in flight (throughput)",
  "get-large-c10": "GET ~400 KB JSON, 10 in flight (parsing)",
  "post-json-c50": "POST JSON, 50 in flight",
  "identical-burst": "Feature: 5,000 identical GETs, 50 in flight (cache stampede)",
};
const lines = [
  "# Benchmark results",
  "",
  `Node ${process.version} · ${cpus().length} × ${cpus()[0]?.model ?? "CPU"} · median of ${rounds} rounds · ${new Date().toISOString().slice(0, 10)}`,
  "",
  "Each run is a fresh process with a 2,000-request warm-up; the upstream runs in its own process on the same machine.",
  "Absolute numbers depend on the machine — compare the columns, not across machines.",
  "**CPU µs/req** (client process only) is the most stable column on shared machines; req/s and latency include the upstream and OS scheduling.",
  "",
];
for (const scenario of scenarios) {
  const rows = Object.entries(results[scenario]).sort((a, b) => b[1].rps - a[1].rps);
  const best = rows[0]?.[1].rps ?? 1;
  const burst = scenario === "identical-burst";
  lines.push(
    `## ${titles[scenario]}`,
    "",
    burst
      ? "Not a speed contest: it shows request collapsing. Only got-api-engine (dedupe on by default) sends fewer requests upstream; \"lean\" disables dedupe."
      : "Unique URL per request, so no client can collapse requests.",
    "",
    `| Client | req/s | relative | CPU µs/req | p50 ms | p99 ms | RSS MB${burst ? " | upstream calls" : ""} |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---:${burst ? " | ---:" : ""} |`,
  );
  for (const [name, r] of rows) {
    const label = name.startsWith("got-api-engine") ? `**${name}**` : name;
    const extra = burst ? ` | ${r.upstreamCalls.toLocaleString("en-US")}` : "";
    lines.push(
      `| ${label} | ${r.rps.toLocaleString("en-US")} | ${Math.round((r.rps / best) * 100)}% | ${r.cpuUs} | ${r.p50} | ${r.p99} | ${r.rssMb}${extra} |`,
    );
  }
  lines.push("");
}
const md = lines.join("\n");
if (out) writeFileSync(join(here, out), md);
console.log(`\n${md}`);
