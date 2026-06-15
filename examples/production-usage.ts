// =================================================================
// examples/production-usage.ts
// Resilience & observability features (v2.1)
// =================================================================

import { createEngine } from "got-api-engine";
import type { CacheStore, CachedResponse } from "got-api-engine";

// ── 1. Fully-loaded resilient engine ─────────────────────────────
const api = createEngine({
  baseUrl: "https://api.example.com",
  serviceName: "checkout-service",

  // Response cache for GET/HEAD
  cache: {
    enabled: true,
    ttlMs: 30_000,
    staleWhileRevalidate: true,
    conditional: true, // ETag / If-None-Match revalidation
    maxEntries: 1000,
  },

  // Stop hammering a failing upstream
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    failureRateThreshold: 0.5,
    rollingWindow: 20,
    resetTimeoutMs: 30_000,
    successThreshold: 2,
  },

  // Smooth out bursts
  rateLimit: {
    enabled: true,
    requestsPerInterval: 50,
    intervalMs: 1_000,
    burst: 100,
    onLimit: "wait",
  },

  // Retry transient failures with backoff + jitter
  retry: {
    limit: 3,
    baseDelayMs: 200,
    maxDelayMs: 5_000,
    jitter: 0.25,
    respectRetryAfter: true,
  },

  dedupe: true,
  idempotency: true,
  ssrfProtection: true,
  metrics: true,

  hooks: {
    onRetry: ({ attempt, delayMs, reason }) =>
      console.warn(`retry #${attempt} in ${delayMs}ms — ${reason}`),
    onCircuitStateChange: ({ from, to }) =>
      console.warn(`circuit ${from} → ${to}`),
  },
});

// ── 2. Per-request overrides ─────────────────────────────────────
async function reads() {
  // Short-lived cache + serve stale while revalidating
  await api.get("/feed", { cache: { ttlMs: 5_000, staleWhileRevalidate: true } });

  // Bypass the cache for live data
  await api.get("/live-prices", { cache: false });

  // Disable dedupe + retry for a one-off
  await api.get("/health", { dedupe: false, retry: false });

  // Cancel with an AbortSignal
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  await api.get("/slow", { signal: controller.signal });
}

// ── 3. Idempotent mutations ──────────────────────────────────────
async function pay() {
  const res = await api.post("/payments", { amount: 4200 }, { idempotencyKey: "order-42" });
  if (!res.ok) {
    // Machine-readable error code for branching
    if (res.code === "CIRCUIT_OPEN") console.error("Upstream down, try later");
    if (res.code === "RATE_LIMITED") console.error("Slow down");
    return;
  }
  console.log("paid", res.data, "in", res.meta?.durationMs, "ms");
}

// ── 4. Observability ─────────────────────────────────────────────
function observe() {
  const m = api.getMetrics();
  if (m) {
    console.log("requests:", m.totalRequests, "errors:", m.errorCount);
    console.log("cache:", m.cacheHits, "/", m.cacheHits + m.cacheMisses);
    console.log("latency p95:", m.latency.p95, "ms");
    console.log("circuit:", m.circuitState);
  }

  // Manual control
  console.log("circuit state:", api.getCircuitState());
  void api.invalidateCache("GET", "/feed");
  void api.clearCache();
  api.resetCircuit();
}

// ── 5. Custom cache store (e.g. Redis-backed) ────────────────────
const memoryFallback = new Map<string, CachedResponse>();
const customStore: CacheStore = {
  get: (key) => memoryFallback.get(key),
  set: (key, value) => void memoryFallback.set(key, value),
  delete: (key) => void memoryFallback.delete(key),
  clear: () => memoryFallback.clear(),
};

const apiWithStore = createEngine({
  baseUrl: "https://api.example.com",
  cache: { enabled: true, store: customStore, ttlMs: 60_000 },
});

// ── 6. SSRF-safe proxy for user-supplied URLs ────────────────────
const safeProxy = createEngine({
  baseUrl: "https://api.example.com",
  ssrfProtection: {
    enabled: true,
    allowPrivateNetworks: false,
    sameOriginRedirectsOnly: true,
    blockHosts: ["*.internal.corp"],
  },
});

export { api, apiWithStore, safeProxy, reads, pay, observe };
