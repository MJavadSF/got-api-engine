// Runs one scenario for one client in a fresh process and reports the numbers.
//   node worker.mjs <client> <scenario> <baseUrl>

import { performance } from "node:perf_hooks";
import { clients } from "./clients.mjs";

const [name, scenario, base] = process.argv.slice(2);

const SCENARIOS = {
  // Latency: one request at a time.
  "get-small-serial": { path: "/small", concurrency: 1, requests: 3000, method: "get" },
  // Throughput: many requests in flight.
  "get-small-c50": { path: "/small", concurrency: 50, requests: 10_000, method: "get" },
  // Parsing cost: ~400 KB JSON responses.
  "get-large-c10": { path: "/large", concurrency: 10, requests: 400, method: "get", warmup: 300 },
  // JSON request bodies.
  "post-json-c50": { path: "/echo", concurrency: 50, requests: 5000, method: "post" },
  // Feature scenario: bursts of 50 *identical* GETs (cache stampede). Measures
  // how many requests actually reach the upstream.
  "identical-burst": { path: "/small", concurrency: 50, requests: 5000, method: "get", identical: true },
};

const s = SCENARIOS[scenario];
const client = await clients[name](base);
const payload = { name: "Sara", items: [1, 2, 3], nested: { a: true } };
// Every request gets a unique URL so no client can collapse identical requests
// (except in the explicitly labelled "identical-burst" scenario).
let seq = 0;
const call = () => {
  const path = s.identical ? s.path : `${s.path}?i=${seq++}`;
  return s.method === "get" ? client.get(path) : client.post(path, payload);
};
const upstreamCount = async () => Number((await (await fetch(`${base}/__count`)).text()));

// Warm-up: connections and JIT. It must be long enough for every library to
// reach steady state — process.cpuUsage() also counts the JIT compiler threads,
// so a short warm-up penalises libraries with more code.
for (let i = 0; i < (s.warmup ?? 2000); i++) await call();

const before = await upstreamCount();
const cpu0 = process.cpuUsage();
const latencies = new Float64Array(s.requests);
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: s.concurrency }, async () => {
    for (let i = next++; i < s.requests; i = next++) {
      const t = performance.now();
      const data = await call();
      latencies[i] = performance.now() - t;
      if (data === undefined || data === null) throw new Error("empty response");
    }
  }),
);
const elapsed = performance.now() - started;
const cpu = process.cpuUsage(cpu0);
const upstreamCalls = (await upstreamCount()) - before;
await client.close();

latencies.sort();
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
process.send?.({
  rps: Math.round((s.requests / elapsed) * 1000),
  p50: +pct(0.5).toFixed(2),
  p99: +pct(0.99).toFixed(2),
  rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  upstreamCalls,
  cpuUs: +((cpu.user + cpu.system) / s.requests).toFixed(1),
});
