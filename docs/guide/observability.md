# Observability

```ts
api.getMetrics();                           // counters, statuses, error codes, latency, per-route stats
api.metricsText();                          // Prometheus exposition format
await api.health({ ping: "/health" });      // { status: "ok" | "degraded" | "down", circuits, upstreams, … }
await api.toCurl({ endpoint: "/users", method: "POST", body }); // credentials redacted
api.getCircuitState("api.example.com");
```

## Metrics semantics

- `totalRequests`, `successCount`, `errorCount` count calls to `request()` and
  the results they returned — cache hits and deduped callers included.
- `upstreamRequests` / `upstreamErrors` count real network attempts.
- `byRoute` uses typed-endpoint templates (`GET /users/:id`) or
  `METHOD host`, bounded to 200 routes.

```ts
// app/api/metrics/route.ts
export const GET = () => new Response(api.metricsText(), { headers: { "content-type": "text/plain; version=0.0.4" } });
```

## Tracing

```ts
import { trace, context, propagation } from "@opentelemetry/api";
api.use(otel({ tracer: trace.getTracer("app"), inject: (h) => propagation.inject(context.active(), h) }));
```

## Logging

Bring any logger with `debug / info / warn / error` (and optionally `child`
and `isLevelEnabled` — pino and winston have both), or use the built-in
console logger (`logLevel`, `LOG_LEVEL`) or `await createLogger()` (winston,
optional). All metadata is redacted; disabled levels cost nothing.
