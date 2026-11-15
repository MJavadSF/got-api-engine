# Architecture

```
request(options)
  └─ prepare      URL (parsed once, traversal + SSRF checks) · credentials (scoped) · headers · body · retry · cancellation
  └─ middleware   user / plugin middleware (Koa-style)
  └─ dedupe       single-flight with per-caller abort
  └─ cache        fresh │ stale-while-revalidate │ conditional 304 │ stale-if-error │ tags
  └─ network      upstream pick → circuit → rate limit → bulkhead → per-attempt hooks → (hedged) send → classify → retry / 401 refresh
  └─ finalize     per caller: key transforms → responseSchema → fallback → meta
```

```
src/
  core/          engine facade, runtime wiring, config, cancellation, upstream pool, results
  pipeline/      prepare, body, dedupe, executor (cache policy), network, hedge, transport, HTTP/2 pool, finalize, middleware
  cache/         keys, response cache policy, memory store
  resilience/    backoff, retry budget, circuit breaker + registry, token bucket, bulkhead
  security/      SSRF, redaction, host scoping, HMAC fingerprints
  auth/          credential manager, providers, OAuth2
  http/          URL, headers, decoding, directives, schema, transforms, cURL
  observability/ logger, metrics (+ Prometheus), hooks
  features/      typed endpoints, pagination, batching
  plugins/       signing (HMAC, SigV4), OpenTelemetry
  adapters/      next/ (engine, proxy, incoming, outgoing, form), node
  stores/        Redis
  testing/       mocks, recorder
  cli/           OpenAPI codegen
```

## Design rules

- **Results, not exceptions** inside the pipeline; `throwOnError` is applied at the edge.
- **One cancellation per request** (no `AbortSignal.any` on the hot path) that records *why* it aborted.
- **Client errors never reach the circuit breaker or the retry loop.**
- **Everything the engine owns is released by `dispose()`**: sockets, HTTP/2 sessions, timers, background work.
- The runtime stays TypeScript: the engine is I/O-bound, so a native core would add per-platform
  binaries without a measurable gain. Tooling is native where it pays off: TypeScript 7, Biome and tsdown (Rust).
