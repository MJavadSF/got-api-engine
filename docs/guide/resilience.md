# Resilience

```ts
createEngine({
  baseUrl: ["https://a.api.com", "https://b.api.com"], // failover (or upstreamStrategy: "round-robin")
  totalTimeoutMs: 30_000,                               // deadline incl. retries (default)
  retry: { limit: 2, baseDelayMs: 200, budget: { ratio: 0.2 } },
  circuitBreaker: { enabled: true, failureThreshold: 5 },
  rateLimit: { enabled: true, requestsPerInterval: 20, adaptive: true },
  concurrency: { max: 64, maxQueue: 500, adaptive: { min: 8 } },
  hedge: { afterMs: "p95" },
});
```

## Retries

Idempotent methods — and POST/PATCH carrying an `Idempotency-Key` — are
retried on network errors and 408 / 425 / 429 / 5xx, with exponential backoff
and jitter. `Retry-After` is honoured (and capped by `maxRetryAfterMs`).

A **retry budget** caps retries relative to recent traffic, so an outage does
not multiply the load on an upstream that is already struggling.

**Client errors are never retried.** An invalid header or a non-serialisable
body (`bigint`, cycles) is `REQUEST_INVALID` (400): not retried and not counted
by the circuit breaker.

## Circuit breakers

One breaker **per host** by default (`scope: "engine"` or a custom key
function are available). It opens on consecutive failures or on a failure
rate over a window bounded by count *and* age, then lets a limited number of
probes through (half-open). With several upstreams, an open circuit fails
over to the next upstream without spending a retry.

## Rate limiting

A token bucket in `"wait"` (FIFO) or `"reject"` mode. With `adaptive: true`
it pauses when the upstream says its quota is exhausted (`RateLimit`,
`X-RateLimit-*`, a 429 / 503 `Retry-After`). Use `RedisRateLimiter` from
`got-api-engine/redis` to share one quota between instances.

## Bulkhead

`concurrency.max` caps upstream attempts in flight; `maxQueue` bounds the
waiting room. With `adaptive`, the limit shrinks (AIMD) on timeouts, 429 and
503 and grows back on success.

## Hedged requests

A safe request slower than the hedge delay (p95 of observed latency by
default) gets a second attempt — on another upstream when there is one. The
first response wins and the other attempt is aborted. Hedges respect the
bulkhead, the rate limiter and the retry budget.

## Failover

`baseUrl` accepts an array. Relative endpoints go to a healthy upstream;
network failures, 5xx and open circuits mark an upstream unhealthy for
`upstreamCooldownMs`. `upstreamStrategy: "round-robin"` spreads load.

## Fallbacks

```ts
const banners = await api.get<string[]>("/banners", { fallback: [] });
// success with meta.fallback = true when the request fails
```
