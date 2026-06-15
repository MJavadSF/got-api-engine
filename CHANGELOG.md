# Changelog

All notable changes to **got-api-engine** are documented here.

## [2.1.0] - 2026-06-15

A major **performance + production-resilience** release. Fully backward
compatible — all new behaviour is opt-in, and existing v2.0 code keeps working.

### Added — Resilience & performance

- **Circuit breaker** (`circuitBreaker`) — three-state (closed → open → half-open)
  breaker tripping on consecutive failures and/or rolling failure rate, with an
  automatic half-open probe after a cooldown. Short-circuits with `CIRCUIT_OPEN`.
- **Response cache** (`cache`) — in-memory LRU store (or a custom `CacheStore`,
  e.g. Redis) with TTL, `staleWhileRevalidate`, and **ETag / Last-Modified**
  conditional revalidation (`If-None-Match` / `If-Modified-Since`, 304 handling).
- **In-flight request deduplication** (`dedupe`, default on) — concurrent identical
  GET/HEAD requests share a single upstream call (single-flight).
- **Engine-managed retries** (`retry`) — exponential backoff with full jitter,
  `Retry-After` support, configurable status codes and methods, coordinated with
  the circuit breaker and metrics.
- **Client-side rate limiting** (`rateLimit`) — token-bucket with `wait` (queue)
  or `reject` (fail-fast 429) strategies.
- **Metrics** (`metrics`, default on) — request/error/retry/cache/dedupe counters,
  rate-limited and circuit-rejected counts, latency percentiles (p50/p95/p99),
  per-status breakdown, and live circuit state. Exposed via `getMetrics()`.
- **Idempotency keys** (`idempotency`) — auto-attach `Idempotency-Key` to mutating
  requests; per-request override via `idempotencyKey`.
- New instance methods: `getMetrics()`, `resetMetrics()`, `getCircuitState()`,
  `resetCircuit()`, `clearCache()`, `invalidateCache()`.
- New per-request options: `cache`, `dedupe`, `retry`, `idempotencyKey`, `signal`.
- Result objects now carry `meta` (`cached`, `stale`, `deduped`, `attempts`,
  `durationMs`, `requestId`) and error results carry a machine-readable `code`.
- New lifecycle hooks: `onRetry`, `onCircuitStateChange`.
- Sliding-window concurrency pool for `batchRequests` (higher throughput than the
  previous fixed-chunk approach).

### Added — Security

- **SSRF protection** (`ssrfProtection`) — blocks requests to private, loopback,
  link-local and CGNAT ranges (IPv4 + IPv6, incl. IPv4-mapped), enforces
  same-origin redirects, and supports host allow/block lists.
- **Log redaction** (`redactKeys`) — Authorization, cookies, API keys, tokens and
  other secrets are stripped from all log metadata by default; extendable.
- **HTTP keep-alive** agents for both http and https with tuned socket pools,
  improving throughput and latency under load.

### Changed

- `got`'s built-in retry is now disabled in favour of the engine's coordinated
  retry layer (so retries interact correctly with the circuit breaker, metrics
  and `Retry-After`).
- The Next.js `handleRoute` adapter now routes through the resilient core pipeline,
  so Route Handlers automatically benefit from cache, circuit breaker, rate limit,
  retries and metrics.

### Removed / Security

- **Dropped the `jsonwebtoken` dependency.** `getUserIdFromBearerToken` previously
  used `jsonwebtoken.decode` (no signature verification) purely to read a user id
  for logging. It is now a dependency-free, decode-only base64url parser with an
  explicit warning that it must never be used for authorization. This removes a
  heavyweight transitive dependency surface.

### Fixed

- Removed `any` leaks in `batchRequests` / `withRetry`.
- Hooks that throw no longer abort the request pipeline (errors are logged).
