// =================================================================
// examples/production-usage.ts
// Resilience, security & observability (v3)
// =================================================================

import type { CachedResponse, CacheStore } from "got-api-engine";
import { createEngine, createRefreshableAuth } from "got-api-engine";

// ── 1. Fully-loaded resilient engine ─────────────────────────────
const tokens = createRefreshableAuth({
  // Called single-flight; the JWT `exp` claim decides when to refresh again.
  refresh: async () => {
    const res = await fetch("https://auth.example.com/token", { method: "POST" });
    return ((await res.json()) as { access_token: string }).access_token;
  },
});

const api = createEngine({
  baseUrl: "https://api.example.com",
  serviceName: "checkout-service",
  auth: tokens,

  // On a 401 the engine refreshes ONCE (shared by all concurrent requests)
  // and replays the request with the new token.
  refreshAuth: () => tokens.refreshNow(),

  timeoutMs: 8_000, // per attempt
  totalTimeoutMs: 20_000, // whole request incl. retries and backoff
  http2: true, // got 16 native HTTP/2 (ALPN, pooled sessions)

  cache: {
    enabled: true,
    ttlMs: 30_000,
    staleWhileRevalidate: true, // instant answers, refreshed in the background
    staleIfError: true, // keep serving the last good copy while upstream is down
    respectCacheControl: true, // max-age / no-cache / no-store from the API
    invalidateOnMutation: true, // PUT /users/1 drops cached GET /users/1 and /users
    maxEntries: 1000,
  },

  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    failureRateThreshold: 0.5,
    rollingWindow: 20,
    resetTimeoutMs: 30_000,
    halfOpenMaxConcurrent: 1, // a single probe while half-open
  },

  rateLimit: { enabled: true, requestsPerInterval: 50, intervalMs: 1_000, burst: 100, onLimit: "wait" },

  retry: {
    limit: 3,
    baseDelayMs: 200,
    maxDelayMs: 5_000,
    jitter: 0.25,
    respectRetryAfter: true,
    maxRetryAfterMs: 10_000, // never sleep for "Retry-After: 3600"
  },

  // Also send our correlation id to the backend:
  requestIdHeader: "X-Request-Id",

  dedupe: true,
  idempotency: true, // auto Idempotency-Key on POST/PUT/PATCH → POST becomes safely retryable
  metrics: true,
  logLevel: "warn", // or set LOG_LEVEL=debug

  hooks: {
    onRetry: ({ attempt, delayMs, reason }) => console.warn(`retry #${attempt} in ${delayMs}ms — ${reason}`),
    onCircuitStateChange: ({ from, to }) => console.warn(`circuit ${from} → ${to}`),
  },
});

// ── 2. Per-request overrides ─────────────────────────────────────
async function reads() {
  await api.get("/feed", { cache: { ttlMs: 5_000, staleWhileRevalidate: true } });
  await api.get("/live-prices", { cache: false }); // bypass cache
  await api.get("/health", { dedupe: false, retry: false }); // one-off probe

  // Retry only what you choose — `retry` merges over the engine's config
  await api.get("/reports", { retry: { limit: 5, retryStatusCodes: [503] } });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  await api.get("/slow", { signal: controller.signal });
}

// ── 3. Mutations, downloads and HTTP QUERY ───────────────────────
async function writes() {
  const res = await api.post("/payments", { amount: 4200 }, { idempotencyKey: "order-42" });
  if (!res.ok) {
    // Machine-readable codes for branching
    if (res.code === "CIRCUIT_OPEN") console.error("Upstream down, try later");
    if (res.code === "RATE_LIMITED") console.error("Slow down");
    if (res.code === "HTTP_ERROR") console.error("Backend said:", res.details); // upstream error body
    return;
  }
  console.log("paid", res.data, `in ${res.meta?.durationMs}ms after ${res.meta?.attempts} attempt(s)`);

  // Binary download (PDF, images…): data is a Node.js Buffer
  const pdf = await api.get<Buffer>("/invoices/42.pdf", { responseType: "buffer" });
  if (pdf.ok) console.log("pdf bytes:", pdf.data.length);

  // HTTP QUERY — safe, idempotent, carries a body (supported by got 16)
  await api.query("/search", { filter: { status: "open" }, limit: 50 });
}

// ── 4. Observability ─────────────────────────────────────────────
function observe() {
  const m = api.getMetrics();
  if (m) {
    console.log("requests:", m.totalRequests, "errors:", m.errorCount, "retries:", m.retryCount);
    console.log("cache hit/miss/stale:", m.cacheHits, m.cacheMisses, m.staleServed);
    console.log("auth refreshes:", m.authRefreshes, "| latency p95:", m.latency.p95, "ms");
    console.log("circuit:", m.circuitState);
  }
}

async function control() {
  await api.invalidateCache("GET", "/feed"); // one exact entry
  await api.invalidateResource("/users"); // every variant of a resource
  await api.clearCache();
  api.resetCircuit();
}

// ── 5. Custom cache store (e.g. Redis-backed) ────────────────────
// `set` receives the TTL (fresh + stale window) so the store can expire entries itself.
const memoryFallback = new Map<string, CachedResponse>();
const customStore: CacheStore = {
  get: (key) => memoryFallback.get(key),
  set: (key, value, _ttlMs) => void memoryFallback.set(key, value),
  delete: (key) => void memoryFallback.delete(key),
  clear: () => memoryFallback.clear(),
  // Optional — lets invalidateOnMutation / invalidateResource reach every variant:
  deleteMatching: (predicate) => {
    for (const k of [...memoryFallback.keys()]) if (predicate(k)) memoryFallback.delete(k);
  },
};

const apiWithStore = createEngine({
  baseUrl: "https://api.example.com",
  cache: { enabled: true, store: customStore, ttlMs: 60_000 },
});

// ── 6. SSRF-safe proxy for user-supplied URLs ────────────────────
// Checks literal IPs (incl. IPv4-mapped IPv6), hostnames, redirects, AND the
// addresses a hostname actually resolves to at connect time (DNS rebinding).
const safeProxy = createEngine({
  baseUrl: "https://api.example.com",
  defaultAuth: false,
  ssrfProtection: {
    enabled: true,
    allowPrivateNetworks: false,
    sameOriginRedirectsOnly: true,
    checkResolvedAddresses: true,
    blockHosts: ["*.internal.corp"],
  },
});

// ── 7. Credentials never leak to other hosts ─────────────────────
// Engine credentials go only to the baseUrl origin + `credentialHosts`.
// Requesting any other absolute URL with auth → CREDENTIALS_BLOCKED.
const multiHost = createEngine({
  baseUrl: "https://api.example.com",
  auth: "service-token",
  credentialHosts: ["*.example.com"], // e.g. your own CDN / sibling services
});
async function foreign() {
  const r = await multiHost.get("https://third-party.test/data", { auth: false }); // explicit, no credentials
  return r;
}

// ── 8. Fork + lifecycle ──────────────────────────────────────────
// extend() inherits the FULL config; config objects merge, hooks append.
const adminApi = api.extend({ defaultHeaders: { "X-Admin": "1" }, circuitBreaker: { failureThreshold: 2 } });

async function shutdown() {
  await Promise.all([api.dispose(), adminApi.dispose(), apiWithStore.dispose(), safeProxy.dispose(), multiHost.dispose()]);
}

// Scoped lifetime (TypeScript 5.2+ / Node 22): disposed automatically at block end.
async function scoped() {
  await using tmp = createEngine({ baseUrl: "https://api.example.com", defaultAuth: false });
  return tmp.get("/ping");
}

export { adminApi, api, apiWithStore, control, foreign, multiHost, observe, reads, safeProxy, scoped, shutdown, writes };
