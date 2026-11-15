# Middleware and plugins

## Middleware

Koa-style: change the request, short-circuit, or observe the raw result.

```ts
api.use(async (ctx, next) => {
  ctx.headers["X-Tenant"] = currentTenant();
  const result = await next();
  if (!result.ok) audit(ctx.method, ctx.url, result.code);
  return result;
});
```

`ctx` exposes `requestId`, `method`, `url`, mutable `headers`, the encoded
`body`, the request `options`, the caller's `signal` and a `state` object
shared between middleware.

### Per-attempt hooks

Anything that depends on the **final target or the time** must run per
upstream attempt — every retry, failover and hedge:

```ts
api.use(async (ctx, next) => {
  ctx.onAttempt((attempt) => {
    attempt.headers["X-Signature"] = sign(attempt.method, attempt.url);
  });
  return next();
});
```

Headers added by attempt hooks are treated as credentials: they are stripped
on redirects to foreign origins.

## Built-in plugins

```ts
import { hmacSign, awsSigV4, otel } from "got-api-engine";

api.use(hmacSign({ secret: process.env.SIGNING_SECRET! }));               // X-Timestamp + X-Signature
api.use(awsSigV4({ region: "eu-west-1", service: "execute-api", credentials }));
api.use(otel({ tracer: trace.getTracer("app"), inject: (h) => propagation.inject(context.active(), h) }));
```

Both signers sign **per attempt**, so retries get a fresh timestamp and a
failover to another upstream is signed for that host. AWS credentials may be
a function (rotating STS / IMDS credentials are resolved per attempt).

## Hooks

`onRequest`, `onResponse`, `onError`, `onRetry` and `onCircuitStateChange`
observe the request lifecycle. `onError` receives a sanitised
`{ name, message, code }` — never request options or credentials.
