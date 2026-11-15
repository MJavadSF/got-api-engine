# got-api-engine

[![npm](https://img.shields.io/npm/v/got-api-engine.svg)](https://www.npmjs.com/package/got-api-engine)
[![license](https://img.shields.io/npm/l/got-api-engine.svg)](LICENSE)

**[Documentation](https://mjavadsf.github.io/got-api-engine/)** ·
**[مستندات فارسی](https://mjavadsf.github.io/got-api-engine/fa/)** ·
[README فارسی](README.fa.md) ·
[API reference](https://mjavadsf.github.io/got-api-engine/api/) ·
[Benchmarks](bench/RESULTS.md)

A modular HTTP engine for **Node.js** and **Next.js** (App Router, Route Handlers,
Server Actions), built on [got 16](https://github.com/sindresorhus/got).
One `request()` call gives you typed results, retries that respect budgets,
per-host circuit breakers, caching with tags, request collapsing, SSRF and
credential-leak protection, metrics and tracing — with sane, secure defaults.

```ts
import { createEngine, defineEndpoint } from "got-api-engine";
import { z } from "zod";

const api = createEngine({ baseUrl: "https://api.example.com", auth: () => process.env.TOKEN });

const getUser = api.endpoint(defineEndpoint({ path: "/users/:id", response: z.object({ id: z.string(), name: z.string() }) }));

const r = await getUser({ path: { id: "42" } });
if (r.ok) console.log(r.data.name); // typed from the schema
else console.error(r.code, r.error); // never throws (unless you ask it to)
```

---

## Contents

- [Features](#features)
- [Install](#install)
- [Requests and results](#requests-and-results)
- [Typed endpoints and OpenAPI codegen](#typed-endpoints-and-openapi-codegen)
- [Middleware and plugins](#middleware-and-plugins)
- [Resilience](#resilience)
- [Caching](#caching)
- [Authentication](#authentication)
- [Security](#security)
- [Next.js](#nextjs)
- [Observability](#observability)
- [Testing your app](#testing-your-app)
- [Configuration reference](#configuration-reference)
- [Error codes](#error-codes)
- [Architecture](#architecture)
- [Upgrading to v4](#upgrading-to-v4)
- [Development](#development)

## Features

| Area | What you get |
| --- | --- |
| **Results** | Plain, serialisable `ApiResult` (`ok` / `data` / `error` / `code`), or `throwOnError` / `requestData()` / `unwrap()` |
| **Types** | Typed endpoints with inferred path params, Standard Schema v1 (Zod, Valibot, ArkType), OpenAPI → TypeScript codegen |
| **Resilience** | Retries with backoff + `Retry-After`, retry budgets, per-host circuit breakers, token-bucket + adaptive rate limiting, bulkheads (AIMD), hedged requests, multi-upstream failover, fallbacks, overall deadlines |
| **Caching** | Fresh / stale-while-revalidate / stale-if-error, ETag revalidation, `Cache-Control` + `Vary`, tags, mutation invalidation, Redis store, prefetch |
| **Dedupe** | Identical in-flight GET/HEAD collapse into one upstream call — even with per-caller `AbortSignal`s |
| **Security** | SSRF guard (incl. DNS rebinding), credential scoping + stripping on redirects, path-traversal guard, body size limits, HMAC'd cache keys, log redaction |
| **Next.js** | Route Handler proxy, catch-all BFF with allowlist, cookie auth + CSRF, SSE streaming, Server Actions with `useActionState` form state |
| **Observability** | Metrics (Prometheus text), per-route latency, `health()`, phase timings, `toCurl()`, OpenTelemetry middleware |
| **Extensibility** | Koa-style middleware, HMAC / AWS SigV4 signing, OAuth2 client credentials, pluggable cache store and rate limiter |
| **i18n** | Engine error messages in English or Persian (`messages: "fa"`), or your own catalog |

## Install

```bash
npm i got-api-engine
```

Requires **Node.js ≥ 22.12** (got 16 is ESM-only; the CommonJS build relies on
`require(esm)`). Runs on the Node.js runtime — not on the Edge runtime.

Entry points: `got-api-engine`, `got-api-engine/next`, `got-api-engine/node`,
`got-api-engine/redis`, `got-api-engine/testing`, `got-api-engine/codegen`.

## Requests and results

```ts
const api = createEngine({ baseUrl: "https://api.example.com", defaultAuth: false });

const r = await api.get<User[]>("/users", { params: { page: 2, tag: ["a", "b"] } });
await api.post("/users", { name: "Sara" });          // objects → JSON
await api.put("/files/1", buffer);                    // Buffer / string / Blob / FormData / streams as-is
await api.query("/search", { q: "x" });               // HTTP QUERY (safe, with a body)
await api.get("/export", { responseType: "buffer" }); // "auto" | "json" | "text" | "buffer" | "stream"
```

Every call resolves to an `ApiResult`:

```ts
type ApiResult<T> =
  | { ok: true; data: T; status: number; headers?: Record<string, string>; meta?: ResultMeta }
  | { ok: false; error: string; status: number; code?: ErrorCode; details?: unknown; meta?: ResultMeta };
```

`meta` carries `requestId`, `durationMs`, `attempts`, `cached`, `stale`,
`deduped`, `hedged`, `fallback`, `upstream` and per-phase `timings`
(`dns`, `tcp`, `tls`, `firstByte`, `download`, `total`).

Prefer exceptions?

```ts
const user = await api.requestData<User>({ endpoint: "/users/1" }); // throws ApiError
const api2 = createEngine({ baseUrl, throwOnError: true });           // every call
const data = unwrap(await api.get<User>("/users/1"));                 // one call

if (isApiError(r, "TIMEOUT", "CIRCUIT_OPEN")) showRetryLater();
const names = mapResult(r, (users) => users.map((u) => u.name));
```

Other per-request options: `timeoutMs`, `totalTimeoutMs`, `retry`, `signal`,
`cache`, `dedupe`, `idempotencyKey`, `fallback`, `transformKeys`,
`maxResponseBytes`, `onUploadProgress`, `onDownloadProgress`, `hedge`,
`schema`, `responseSchema`, `invalidateTags`.

**Safe paths.** Relative endpoints may not contain `.`/`..` segments or escape
the base path. Build them with the `path` tag, which encodes each value as one
segment:

```ts
import { path } from "got-api-engine";
await api.get(path`/users/${userInput}/orders`); // "../admin" throws, "a/b" → "a%2Fb"
```

**Pagination and batching:**

```ts
for await (const order of api.paginate<Order>("/orders", { strategy: "cursor" })) { … } // "link" | "cursor" | "page" | custom next()

const users = api.batcher<string, User>(async (ids) => unwrap(await api.get<User[]>("/users", { params: { ids: ids.join(",") } })));
await Promise.all([users.load("1"), users.load("2")]); // one upstream call
```

## Typed endpoints and OpenAPI codegen

```ts
const updatePost = api.endpoint(
  defineEndpoint({ method: "PUT", path: "/users/:userId/posts/:postId", body: PostInput, response: Post }),
);

await updatePost({ path: { userId: 1, postId: "a/b" }, query: { notify: true }, body: { title: "Hi" } });
// path params are required, typed and percent-encoded; body validated before sending.

// TanStack Query
useQuery(getUser.queryOptions({ path: { id } }));
useMutation(updatePost.mutationOptions());
```

Generate everything from an OpenAPI 3.x JSON document:

```bash
npx got-api-engine-codegen openapi.json -o src/api.generated.ts
```

```ts
import { endpoints } from "./api.generated";
const client = api.endpoints(endpoints);
await client.getUser({ path: { id: "1" } }); // fully typed
```

Schemas: anything implementing [Standard Schema v1](https://standardschema.dev)
(Zod ≥ 3.24, Valibot, ArkType — async validation included) or exposing
`safeParse`.

## Middleware and plugins

Middleware sees and may change the request (headers are mutable), may
short-circuit, and observes the raw result:

```ts
api.use(async (ctx, next) => {
  ctx.headers["X-Tenant"] = currentTenant();
  const result = await next();
  if (!result.ok) audit(ctx.method, ctx.url, result.code);
  return result;
});
```

Built-in middleware:

```ts
import { hmacSign, awsSigV4, otel } from "got-api-engine";

api.use(hmacSign({ secret: process.env.SIGNING_SECRET! }));                 // X-Timestamp + X-Signature
api.use(awsSigV4({ region: "eu-west-1", service: "execute-api", credentials })); // AWS Signature V4
api.use(otel({ tracer: trace.getTracer("app"), inject: (h) => propagation.inject(context.active(), h) }));
```

Hooks (`onRequest`, `onResponse`, `onError`, `onRetry`, `onCircuitStateChange`)
remain available as observers. `onError` receives a sanitised `{ name, message, code }`.

## Resilience

```ts
createEngine({
  baseUrl: ["https://a.api.com", "https://b.api.com"], // failover (or upstreamStrategy: "round-robin")
  totalTimeoutMs: 30_000,                               // deadline incl. retries (default)
  retry: { limit: 2, baseDelayMs: 200, budget: { ratio: 0.2 } },
  circuitBreaker: { enabled: true, failureThreshold: 5, scope: "host" },
  rateLimit: { enabled: true, requestsPerInterval: 20, adaptive: true },
  concurrency: { max: 64, maxQueue: 500, adaptive: { min: 8 } },
  hedge: { afterMs: "p95" },
});
```

- **Retries** — idempotent methods (and POST/PATCH with `Idempotency-Key`) on
  408/425/429/5xx and network errors, exponential backoff with jitter,
  `Retry-After` honoured (and capped by `maxRetryAfterMs`). A **retry budget**
  caps retries relative to traffic so an outage does not multiply load.
- **Client errors are not upstream failures** — an invalid header or a
  non-serialisable body is `REQUEST_INVALID` (400): never retried, never
  counted by the circuit breaker.
- **Circuit breakers** per host (or per engine / custom key), with consecutive
  and rate-based tripping over a time-bounded window and limited half-open probes.
  With several upstreams an open circuit fails over to the next one.
- **Rate limiting** — token bucket (`wait` FIFO or `reject`); `adaptive: true`
  pauses when upstream sends `RateLimit`, `X-RateLimit-*` or 429 `Retry-After`.
  Plug in `RedisRateLimiter` to share a quota across instances.
- **Bulkhead** — caps concurrent upstream attempts; AIMD shrinks the limit on
  timeouts / 429 / 503 and grows it back on success.
- **Hedging** — a safe request slower than p95 gets a parallel attempt (on another
  upstream when available); the first response wins.
- **Fallbacks** — `fallback: [] | (err) => value` returns success with `meta.fallback`.

## Caching

```ts
const api = createEngine({
  baseUrl,
  cache: {
    enabled: true,
    ttlMs: 30_000,
    staleWhileRevalidate: true,
    staleIfError: true,
    respectCacheControl: true,
    store: new RedisCacheStore(redis),       // default: in-memory LRU (entries + bytes bounded)
    keySecret: process.env.CACHE_KEY_SECRET, // same secret on every instance sharing the store
  },
  waitUntil: after,                          // Next.js: keep background revalidation alive
  onInvalidateTags: (tags) => tags.forEach((t) => revalidateTag(t)),
});

await api.get("/users/1", { cache: { tags: ["user:1", "users"] } });
await api.patch("/users/1", body, { invalidateTags: ["users"] }); // resource + tags dropped on success
await api.invalidateTags("users");
await api.warm(["/config", "/menu"]);
```

- Entries are partitioned per credential (HMAC), header variant and response
  type; `Vary` is honoured; `shared: true` builds a public cache (and refuses
  `Cache-Control: private`).
- Upstream `no-store` is always honoured; with `respectCacheControl` also
  `max-age`, `s-maxage` (shared), `no-cache`, `must-revalidate`,
  `stale-while-revalidate=` and `stale-if-error=`.
- `copy: "clone"` (default) protects cached data from caller mutation;
  `"freeze"` is faster for read-only data.
- A successful POST/PUT/PATCH/DELETE drops cached reads of the resource, its
  `Location` and its parent collection.

## Authentication

```ts
auth: "token"                                  // static
auth: () => getToken()                         // function (sync or async)
auth: createApiKeyAuth("k", "X-API-Key")        // custom header
auth: createBasicAuth("user", "pass")
auth: createRefreshableAuth({ refresh: fetchToken })       // cached until expiry (JWT exp read), single-flight
auth: createOAuth2ClientCredentials({ tokenUrl, clientId, clientSecret, scope })
refreshAuth: async () => newToken              // optional: called single-flight on 401, request replayed once
```

`defaultAuth` (`true` by default) makes credentials required; use `auth: false`,
`"optional"` or `authToken` per request. Engine credentials are only sent to the
`baseUrl` origins and `credentialHosts` (`CREDENTIALS_BLOCKED` otherwise).

## Security

| Protection | Default |
| --- | --- |
| TLS verification in every environment; custom CA / mTLS via `tls` | on |
| Credentials only to trusted origins; stripped (incl. custom headers) on redirects elsewhere | on |
| Path traversal guard (`strictPath`) | on |
| Response size cap (`maxResponseBytes`) | 50 MiB |
| Next.js request body cap (`maxBodyBytes`) | 10 MiB |
| HMAC'd credentials / query strings in cache keys | on |
| Log + hook redaction (`authorization`, `cookie`, `*token*`, `*secret*`, `session`, …) | on |
| Generic error messages to browsers for infra errors / upstream 5xx (Next.js) | on |
| SSRF guard: private ranges, DNS rebinding, redirect checks (`ssrfProtection`) | opt-in |
| CSRF origin check for cookie-auth routes (`csrf`) | opt-in |

Enable `ssrfProtection: true` for any engine that requests user-supplied URLs.

## Next.js

Tested end-to-end on **Next.js 14, 15 and 16** (`next build` + `next start`,
bundled and external) in CI. Recommended `next.config`:

```js
// Next 15 / 16
export default { serverExternalPackages: ["got-api-engine", "got"] };
// Next 14
export default { experimental: { serverComponentsExternalPackages: ["got-api-engine", "got"] } };
```

```ts
// lib/api.ts
import { createNextEngine } from "got-api-engine/next";
export const api = createNextEngine({ baseUrl: process.env.API_URL!, messages: "fa", waitUntil: after });
```

**Route Handler proxy**

```ts
// app/api/users/route.ts
export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/users", forwardRequestHeaders: ["accept-language"] });
export const POST = (req: Request) => api.handleRoute(req, { endpoint: "/users", method: "POST", schema: NewUser });
```

**Catch-all BFF with an allowlist**

```ts
// app/api/[...path]/route.ts
export const { GET, POST, PUT, PATCH, DELETE } = createProxy(api, {
  prefix: "/api",
  allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
  cookieAuth: { name: "access_token" }, // httpOnly cookie → Authorization: Bearer
  csrf: true,                           // unsafe methods must come from your origin
});
```

`handleRoute` options: `schema` (JSON only — other content types get 415),
`maxBodyBytes`, `forwardQuery`, `forwardRequestHeaders`,
`forwardResponseHeaders`, `forwardClientIp` (off; enable only behind a trusted
proxy), `cookieAuth`, `csrf`, `useEngineAuth`, `responseType: "stream"` (SSE /
downloads), `exposeUpstreamDetails`, `mapError`, `requestOptions`
(cache, fallback, …). Responses carry `X-Request-Id` and `X-Cache`.

**Server Actions**

```ts
"use server";
export async function createUser(_prev: unknown, form: FormData) {
  return api.serverForm("POST", "/users", form); // { ok, data } | { ok: false, message, fieldErrors }
}
// in a component: const [state, action] = useActionState(createUser, null);

const r = await api.serverGet<User>("/me", { session: await auth() }); // Auth.js session token
```

## Observability

```ts
api.getMetrics();          // counts, statuses, error codes, latency percentiles, per-route stats
api.metricsText();         // Prometheus exposition format
await api.health({ ping: "/health" }); // { status: "ok" | "degraded" | "down", circuits, upstreams, … }
await api.toCurl({ endpoint: "/users", method: "POST", body }); // credentials redacted
api.getCircuitState("api.example.com");
```

Logging: bring any logger with `debug/info/warn/error(/child)`, or use the
built-in console logger (`logLevel`, `LOG_LEVEL`) or `await createLogger()`
(Winston, optional peer). All metadata passes through the redactor.

## Testing your app

```ts
import { createMockEngine, recorder } from "got-api-engine/testing";

const api = createMockEngine({
  "GET /users/:id": ({ params }) => ({ body: { id: params.id } }),
  "POST /users": { status: 201, body: { id: "1" } },
  "* /flaky": { status: 503 },
});

// Record real responses once, replay them in CI:
createEngine({ baseUrl, middleware: [recorder({ dir: "test/fixtures", mode: process.env.CI ? "replay" : "auto" })] });
```

## Configuration reference

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | — | URL or array of URLs (multi-upstream) |
| `upstreamStrategy` / `upstreamCooldownMs` | `"failover"` / `10000` | Multi-upstream routing |
| `auth` / `refreshAuth` / `defaultAuth` / `credentialHosts` | — / — / `true` / `[]` | Credentials |
| `timeoutMs` / `timeouts` / `totalTimeoutMs` | `10000` / — / `30000` | Per-attempt, per-phase, overall |
| `retryLimit` / `retry` | `2` / — | Retry policy incl. `budget` |
| `circuitBreaker` | off | `scope`, thresholds, windows |
| `rateLimit` | off | token bucket, `adaptive`, custom `limiter` |
| `concurrency` | off | bulkhead `max`, `maxQueue`, `adaptive` |
| `hedge` | off | `afterMs: number \| "p95"` |
| `cache` | off | see [Caching](#caching) |
| `dedupe` / `idempotency` | `true` / `false` | |
| `responseType` / `maxResponseBytes` | `"auto"` / 50 MiB | |
| `ssrfProtection` / `strictPath` / `redactKeys` | off / `true` / — | |
| `tls` / `rejectUnauthorized` / `agentOptions` / `agent` / `http2` / `dnsCache` | — / `true` / keep-alive / — / `false` / `false` | Transport |
| `compressRequest` | off | gzip / deflate / br above a threshold |
| `middleware` / `hooks` | — | |
| `transformKeys` / `messages` / `throwOnError` | — / `"en"` / `false` | |
| `waitUntil` / `onInvalidateTags` | — | Serverless + Next.js cache bridges |
| `logger` / `logLevel` / `debug` / `serviceName` / `metrics` | console / `info` / `false` / `LOG_NAME` / `true` | |

## Error codes

`HTTP_ERROR` · `NETWORK_ERROR` · `TIMEOUT` · `ABORTED` · `PARSE_ERROR` ·
`REQUEST_VALIDATION` · `RESPONSE_VALIDATION` · `REQUEST_INVALID` · `INVALID_URL` ·
`AUTH_REQUIRED` · `AUTH_PROVIDER_ERROR` · `CREDENTIALS_BLOCKED` · `SSRF_BLOCKED` ·
`CIRCUIT_OPEN` · `RATE_LIMITED` · `CONCURRENCY_LIMITED` · `RESPONSE_TOO_LARGE` ·
`ENGINE_DISPOSED` · `INTERNAL_ERROR` · `MOCK_NOT_FOUND` (exported as `ERROR_CODES`).

## Architecture

```
request(options)
  └─ prepare      url (normalised, traversal + SSRF checks) · credentials (scoped) · headers · body · retry · signals
  └─ middleware   user / plugin middleware (Koa-style)
  └─ dedupe       single-flight with per-caller abort
  └─ cache        fresh │ stale-while-revalidate │ conditional 304 │ stale-if-error │ tags
  └─ network      upstream pick → circuit → rate limit → bulkhead → (hedged) send → classify → retry / 401 refresh
  └─ finalize     per caller: key transforms → responseSchema → fallback → meta
```

```
src/
  core/          engine facade, runtime wiring, config, upstream pool, results
  pipeline/      prepare, body, dedupe, executor (cache policy), network, hedge, transport, finalize, middleware
  cache/         cache keys, response cache policy, memory store
  resilience/    backoff, retry budget, circuit breaker + registry, token bucket, bulkhead
  security/      SSRF, redaction, host scoping, HMAC fingerprints
  auth/          credential manager, providers, OAuth2
  http/          url, headers, decoding, directives, schema, transforms, curl
  observability/ logger, metrics (+ Prometheus), hooks
  features/      typed endpoints, pagination, batching
  plugins/       signing (HMAC, SigV4), OpenTelemetry
  adapters/      next/ (engine, proxy, incoming, outgoing, form), node
  stores/        redis
  testing/       mocks, recorder
  cli/           OpenAPI codegen
```

## Upgrading to v4

```bash
npx got-api-engine-codemod v4 src/ --dry               # report what needs attention (file:line)
npx got-api-engine-codemod v4 src/ --preserve-behavior # pin v3 defaults, then opt in to v4 ones
```

See the **Breaking changes** table in [CHANGELOG.md](CHANGELOG.md#400---2026-11-15).
The most visible: Node ≥ 22.12, a default 30 s overall deadline, per-host
circuit breakers, `NETWORK_ERROR` is 502, Next.js no longer forwards
`X-Forwarded-For` by default and hides internal error details.

## Development

```bash
npm ci
npm run check                        # Biome lint + tsc + Vitest with coverage + tsdown build + publint/attw
node test/next-app/run.mjs --next 16 # real Next.js app: next build + next start + end-to-end checks
cd bench && npm i && npm run bench   # benchmarks against fetch, undici, got, axios, ky, ofetch
cd docs && npm i && npm run dev      # documentation site (English + Persian) with the API reference
cd codemod && npm i && npm test      # v3 → v4 codemod
```

Tooling is chosen for speed: **TypeScript 7** (native compiler), **Biome** (lint
+ format, written in Rust) and **tsdown** (Rolldown/Oxc, written in Rust). The
runtime itself stays TypeScript: the engine is I/O-bound, so a native (Rust)
core would add per-platform binaries without a measurable gain.

## License

MIT © [MJavadSF](https://github.com/MJavadSF)
