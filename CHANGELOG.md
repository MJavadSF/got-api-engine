# Changelog

All notable changes to **got-api-engine** are documented here.

## [3.0.0] - 2026-09-30

A **compatibility, security and correctness** release. The library is now built
and tested against **got 16.0.0**, **TypeScript 7.0.2** and Node.js 22+, and
a full review of the engine fixed a number of bugs, several of them
security-relevant. Some insecure defaults changed, hence the major version: see
"Breaking changes" and the migration table in the README.

### Compatibility

* **got 16** (`^16.0.0`, Node >= 22): request/response handling now goes through
  got's buffer path, and the engine takes advantage of `QUERY`, `dnsLookup`,
  native HTTP/2, the DNS cache and the updated redirect hooks.
* **TypeScript 7.0.2** (native compiler): `tsconfig.json` rewritten for TS 7
  (`moduleResolution: "bundler"`, `verbatimModuleSyntax`, no deprecated options,
  no `baseUrl`). Source, tests and examples all type-check with `tsc` 7.0.2.
* **Build tooling:** `tsup` replaced by `tsdown`. tsup's declaration bundler
  depends on the JavaScript compiler API, which TypeScript 7 no longer ships,
  and it crashes. Output is `dist/*.cjs` / `*.mjs` with `*.d.cts` / `*.d.mts`;
  the package is validated with `publint` and `@arethetypeswrong/cli`.

### Security

* **TLS verification was disabled whenever `NODE_ENV !== "production"`** (unset,
  `test`, `staging`...). It is now on in every environment; opt out explicitly
  with `rejectUnauthorized: false`.
* **Credential leak:** the engine's token was sent to *any* absolute URL given as
  `endpoint`. Credentials are now sent only to the `baseUrl` origin and to
  `credentialHosts`; other hosts get `CREDENTIALS_BLOCKED` (or no credentials
  with `auth: "optional"`).
* **SSRF bypass:** `http://[::ffff:127.0.0.1]/` is normalised by the URL parser to
  `::ffff:7f00:1`, which the old check did not recognise. Address checks now use
  `net.BlockList` and cover IPv4-mapped, NAT64, 6to4, unique-local, link-local,
  multicast, CGNAT, benchmarking, documentation and reserved ranges.
* **SSRF, DNS rebinding:** addresses a hostname *resolves to* are now validated at
  connect time via got's `dnsLookup` (`checkResolvedAddresses`, default on).
* **SSRF, redirects:** the same-origin redirect check compared against `baseUrl`
  rather than the origin being redirected, and used the raw `Location` header.
  It now uses the resolved redirect URL and the redirecting origin. SSRF errors
  raised inside got were wrapped and then **retried as network errors**; they
  are now unwrapped and reported as `SSRF_BLOCKED`.
* **`extend()` silently dropped the parent's `ssrfProtection`** (see Fixed).
* **Cache poisoning / cross-principal leaks:** cache keys used a 32-bit FNV-1a
  hash of the credentials (collision-prone) and ignored custom headers. Keys now
  use a SHA-256 prefix of the credentials plus a fingerprint of request headers
  and response type.
* **Log redaction** now applies to all log output (including custom loggers) and
  to URLs (query tokens, userinfo), not only to validation errors.

### Breaking changes

* TLS verification default (above), credential scoping (above).
* **`POST` / `PATCH` are no longer retried by default.** v2 retried them despite
  documenting GET/PUT only, which can double-execute non-idempotent calls. They
  are retried when an `Idempotency-Key` is present (`idempotency: true`,
  `idempotencyKey`, or your own header) or when listed in `retry.methods`.
* `ApiKeyAuthProvider` sends the key in its own header (`X-API-Key` by default).
  Previously it produced the invalid `Authorization: Bearer ApiKey <key>`.
* `extend()` inherits the full configuration; `hooks` are appended instead of
  replaced; config objects are merged.
* Response bodies are decoded by the engine (`responseType`, default `"auto"`):
  text is returned as a string, binary as a `Buffer`. `Buffer` / `Uint8Array`
  request bodies are sent raw (previously JSON-serialised).
* Successful requests are logged at `debug` (was `info`).
* `winston` and `uuid` are no longer dependencies. Winston is an optional peer,
  used through `createLogger()` (v2 documented auto-detection, but the engine
  never used it). IDs use `crypto.randomUUID()`.
* `got` is no longer a `peerDependency` (it is a regular dependency). `react`,
  `next`, `zod` and `winston` are **optional** peers (a required `react` peer
  was force-installed by npm 7+ although the package never imports it).
* Route Handlers (`handleRoute`): forward the caller's `Authorization` (any
  scheme), never fall back to engine credentials unless `useEngineAuth: true`,
  no longer import `next/server`, and do not echo upstream 5xx bodies.
* The constructor throws `TypeError` for a missing or non-`http(s)` `baseUrl`.
* `package.json` now declares `"type": "commonjs"` and a new `exports` map.

### Fixed

* **Rate limiter and circuit breaker ran before the cache and dedupe**, so cache
  hits and deduplicated followers consumed tokens and were rejected by an open
  circuit (defeating caching during an outage). Gates now guard real upstream
  attempts only, and apply to **every retry**.
* **Retry bugs:** per-request `retryLimit` was ignored; per-request `retry`
  replaced (instead of merged over) the engine's retry config; `Retry-After`
  was uncapped (`Retry-After: 3600` slept for an hour; now bounded by
  `maxRetryAfterMs`); errors thrown by a response schema were retried as
  network errors.
* **`extend()`** dropped `cache`, `circuitBreaker`, `rateLimit`, `retry`,
  `ssrfProtection`, `metrics`, `idempotency`, `redactKeys`... unless
  re-specified, and returned the base class for `NextApiEngine`.
* **Dedupe:** keys ignored headers and credentials; one aborted caller failed
  every caller that had joined its request; followers shared (and could mutate)
  the leader's data object.
* **Circuit breaker:** half-open admitted unlimited concurrent probes; late
  failures from pre-open requests extended the cooldown.
* **Rate limiter:** replaced racy polling with a FIFO queue, one timer, abortable
  waiters and an early reject when `maxWaitMs` could never be met.
* **Cache:** entries never expired physically (TTL ignored by the store); cached
  data was shared by reference with callers; the post-`responseSchema` value was
  cached, so a later call with a different schema got the wrong shape;
  mutations did not invalidate cached reads; `private` responses were skipped.
* **Bodies:** `Buffer`s were JSON-serialised; `DELETE` bodies and non-JSON Route
  Handler bodies were dropped; an empty body with a JSON content type was a 400.
* **Headers** were merged case-sensitively, so `authorization` and
  `Authorization` could both be sent; the `Idempotency-Key` check was
  case-sensitive.
* **Errors:** a failing `auth` function was reported as `NETWORK_ERROR` and
  counted against the circuit (now `AUTH_PROVIDER_ERROR`); invalid URLs were
  retried as network errors (now `INVALID_URL`); HTTP error bodies were
  dropped (now in `details`); `onError` always reported `durationMs: 0`.
* `getUserIdFromBearerToken` mangled non-ASCII JWT payloads.
* `safeStringify` marked repeated (non-circular) references as `[Circular]` and
  its depth limit was unreliable.
* `parseApiError` missed `errors[]` arrays and nested `{ error: { message } }`.
* `batchRequests` was not fail-fast in any meaningful way, and a key like
  `__proto__` corrupted the result object.
* `withRetry` had no jitter, cap, abort support, or `Retry-After` awareness and
  retried every 5xx including 501.
* `BrowserStorageAuthProvider` threw when storage access was denied.
* `LOG_LEVEL` and `LOG_NAME` were documented but not honoured by the built-in
  logger.

### Added

* `refreshAuth` hook: single-flight `401` refresh and one replay;
  `createRefreshableAuth()` (caches until expiry, reads JWT `exp`).
* `credentialHosts`; `totalTimeoutMs` (overall deadline including retries);
  `requestId` / `requestIdHeader` propagation; `logLevel`.
* `responseType: "auto" | "json" | "text" | "buffer"` (engine-wide and per request).
* `http2` and `dnsCache` options (got 16); `QUERY`, `HEAD`, `OPTIONS` methods
  (`api.query()`, `api.head()`, `api.options()`).
* Cache: `staleIfError`, `staleTtlMs`, `respectCacheControl`,
  `invalidateOnMutation`, `cloneOnRead`, `deleteMatching` on stores;
  `api.invalidateResource()`; `meta.staleReason`; `staleServed` metric.
* `retry.maxRetryAfterMs`; `meta.retryAfterMs`; `circuitBreaker.halfOpenMaxConcurrent`.
* `api.dispose()` and `await using` (`Symbol.asyncDispose`).
* Auth: `ApiKeyAuthProvider` (header), `BasicAuthProvider`, `RefreshableAuthProvider`;
  `NextAuthProvider` accepts `access_token` and `accessToken` (Auth.js v5).
* Route Handlers: `forwardResponseHeaders`, `exposeUpstreamDetails`, `useEngineAuth`,
  `forwardQuery`, `responseType`; binary and text passthrough; raw body proxying;
  `X-Request-Id` on every response; client disconnect cancels the upstream call.
* Array query params (`?tag=a&tag=b`); `DELETE`/`QUERY` request bodies.
* `batchRequests`: `failFast` (aborts in-flight work), `signal`, `BatchRequestError`.
* `withRetry`: `maxDelayMs`, `jitter`, `signal`, `onRetry`, attempt index.
* Exports: `mergeEngineConfig`, `isPrivateAddress`, `redactUrl`, `withRedaction`,
  `buildGuardedLookup`, `findSsrfError`, and the new types.
* Test suite (153 tests: real local HTTP servers, HTTP/2, security, adapters)
  and type-checked examples; `typecheck`, `test`, `lint:package` scripts.

### Notes

* Node.js >= 22 is unchanged (required by got 16).
* The examples were updated for Next.js 15+ (`params` is a Promise) and Auth.js v5.

## [2.1.1] - 2026-09-05

A maintenance release focused on **dependency updates and React 19 compatibility**. No runtime API or behaviour changes were introduced.

### Changed — Dependencies

* Added **React 19.2+** as a peer dependency to explicitly declare compatibility with React-based consumers.
* Updated **`got`** from `^15.0.5` to `^15.1.0`.
* Updated **`uuid`** from `^14.0.0` to `^14.0.2`.
* Updated **`zod`** development dependency from `^4.4.3` to `^4.5.4`.

### Compatibility

* React `>=19.2.0` is now explicitly declared as a peer dependency.
* Existing Node.js requirement remains unchanged: **Node.js >=22.0.0**.
* Existing `next` and `zod` peer dependency requirements remain unchanged.
* No changes were made to the public API, exports, runtime behaviour, or build configuration.

### Notes

This release is backward compatible with `2.1.0`. The update primarily aligns the package metadata and dependency versions with the current supported ecosystem.


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
