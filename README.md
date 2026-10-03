# got-api-engine

[![npm version](https://img.shields.io/npm/v/got-api-engine.svg)](https://www.npmjs.com/package/got-api-engine)
[![license](https://img.shields.io/npm/l/got-api-engine.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/got-api-engine.svg)](./dist/index.d.mts)

A **modular, framework-agnostic HTTP proxy engine** built on [got](https://github.com/sindresorhus/got) **16**.
Works with **Next.js** (App Router, Route Handlers, Server Actions), **Node.js**, and plain **TypeScript / JavaScript** servers.

Built and tested with **TypeScript 7.0.2** (the native compiler), **got 16.0.0** and **Node.js 22+**.

> **Upgrading from v2?** Read [Upgrading from v2](#upgrading-from-v2) — v3 tightens several insecure defaults.

---

## Features

- **Resilient by design** — circuit breaker, exponential-backoff retries (honours `Retry-After`), client-side rate limiting, request de-duplication, overall deadline (`totalTimeoutMs`)
- **Response caching** — in-memory LRU or your own store; TTL, `stale-while-revalidate`, `stale-if-error`, ETag / Last-Modified revalidation, `Cache-Control` support, automatic invalidation after mutations
- **Safe retries** — only idempotent methods are retried; `POST`/`PATCH` join them only when an `Idempotency-Key` is present
- **Token refresh** — `refreshAuth` handles `401` once, single-flight, then replays the request
- **Security built in** — SSRF guard (IPv4/IPv6, redirects and DNS-rebinding-proof connect-time checks), credentials never sent to foreign origins, TLS verification always on by default, log redaction
- **Any payload** — JSON, text, binary (`Buffer`), `FormData`, `URLSearchParams`, streams; `responseType: "auto" | "json" | "text" | "buffer"`
- **Modern HTTP** — HTTP/2 (`http2: true`), the `QUERY` method, `HEAD`/`OPTIONS`, repeated query keys for arrays
- **Observability** — metrics (counts, latency p50/p95/p99, circuit state), request-id propagation, lifecycle hooks, structured logging
- **Pluggable auth** — static, dynamic, Auth.js / next-auth, browser storage, API key, Basic, self-refreshing tokens
- **Next.js adapter** — Route Handler proxy (binary-safe, header allow-list, query forwarding) and Server Actions, with **no runtime dependency on `next/server`**
- **Schema validation** — Zod-compatible request & response validation (no hard dependency)
- **Lifecycle** — `dispose()` / `await using`, `extend()` that inherits the *full* configuration
- **Tiny footprint** — a single runtime dependency (`got`); dual ESM + CJS build with bundled types

---

## Installation

**Requirements:** Node.js **22+** (required by got 16, which is ESM-only).
TypeScript **5.2+** is enough for consumers (`await using` needs 5.2); the package itself is built and type-checked with TypeScript **7.0.2**.

```bash
npm install got-api-engine
# or
pnpm add got-api-engine
# or
yarn add got-api-engine
```

**Optional peer dependencies** (nothing is installed for you):

```bash
npm install zod        # only if you use Zod schemas — any safeParse() library works
npm install winston    # only if you want the Winston-backed logger (see Logging)
```

`next` and `react` are declared as *optional* peers purely to document compatibility; the package does not import either.

---

## Quick Start

### Node.js / plain TypeScript

```ts
import { createEngine } from "got-api-engine";

const api = createEngine({
  baseUrl: "https://api.example.com",
  auth: "my-secret-token",
});

const result = await api.get<User>("/users/1");

if (result.ok) {
  console.log(result.data); // User
} else {
  console.error(result.code, result.status, result.error);
}
```

Errors never throw: every call resolves to an `ApiResult` — `{ ok: true, data, status }` or `{ ok: false, error, status, code }`.

### Next.js App Router

```ts
// lib/api.ts — create once, share everywhere
import { createNextEngine } from "got-api-engine/next";
import { createNextAuthProvider } from "got-api-engine";
import { auth } from "@/auth"; // Auth.js (next-auth v5)

export const api = createNextEngine({
  baseUrl: process.env.API_URL!,
  auth: createNextAuthProvider(() => auth()), // used by Server Actions / RSC
  requestIdHeader: "X-Request-Id",
});
```

```ts
// app/api/users/route.ts  — GET /api/users?page=2 → BACKEND/users?page=2
import { api } from "@/lib/api";

export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/users" });

export const POST = (req: Request) =>
  api.handleRoute(req, { endpoint: "/users", method: "POST", schema: CreateUserSchema });
```

```ts
// app/api/users/[id]/route.ts  — Next.js 15+: `params` is a Promise
import { api } from "@/lib/api";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api.handleRoute(req, {
    endpoint: `/users/${encodeURIComponent(id)}`, // always encode user-controlled segments
    method: "PUT",
    schema: UpdateUserSchema,
  });
}
```

```ts
// app/actions/user.ts
"use server";
import { api } from "@/lib/api";

export async function getProfile() {
  return api.serverGet("/me"); // the Auth.js provider attaches the session token
}
```

---

## Compatibility notes: got 16 and TypeScript 7

**got 16.** The engine uses got 16's native request path with `responseType: "buffer"` and decodes bodies itself, which is what enables `text`/`buffer` responses and keeps the real HTTP status when a gateway returns a non-JSON error page. It also takes advantage of:

| got 16 feature | Where it shows up |
|---|---|
| `QUERY` method | `api.query(endpoint, body)` and `method: "QUERY"` |
| `dnsLookup` | connect-time SSRF check (works alongside `dnsCache`) |
| Native HTTP/2 client | `http2: true` |
| Built-in DNS cache | `dnsCache: true` |
| Redirect hooks | SSRF redirect guard compares against the *redirecting* origin |
| `signal` | `RequestOptions.signal` and `totalTimeoutMs` |

**TypeScript 7.0.2.** TypeScript 7 is the native (Go) compiler and no longer ships the JavaScript compiler API that many build tools depend on. Practical consequences for this package:

- The build uses **tsdown** instead of tsup (tsup's `.d.ts` bundler calls the removed JS API and crashes on TS 7).
- `tsconfig.json` uses only options that TS 7 supports (`moduleResolution: "bundler"`, `verbatimModuleSyntax`, `strict` family) — no deprecated options, no `baseUrl`.
- Source, tests and examples are all type-checked with `tsc` 7.0.2 (`npm run typecheck`).
- The published types are `.d.mts` / `.d.cts`, validated with [publint](https://publint.dev) and [attw](https://arethetypeswrong.github.io) (`npm run lint:package`).

If *your* project pins an older TypeScript (5.2+), the shipped declarations work unchanged.

---

## How a request flows

```
prepare (URL · credentials · headers · body validation · SSRF static check)
  └─ dedupe  (identical in-flight GET/HEAD share one upstream call)
       └─ cache  (fresh hit · stale-while-revalidate · conditional revalidation)
            └─ attempt loop ─ circuit breaker → rate limiter → got
                 ├─ network error / retryable status → backoff (Retry-After aware) → next attempt
                 ├─ 401 → refreshAuth (single-flight) → replay once
                 └─ decode → validate → cache store / mutation invalidation → metrics
```

The circuit breaker and rate limiter guard **real upstream attempts only**: cache hits and de-duplicated followers never consume tokens or breaker capacity, and every retry passes through both gates again.

---

## Production features

Everything is **opt-in** and composable.

```ts
const api = createEngine({
  baseUrl: "https://api.example.com",
  auth: tokens,
  refreshAuth: () => tokens.refreshNow(),

  timeoutMs: 8_000,        // per attempt
  totalTimeoutMs: 20_000,  // whole request, including retries and backoff
  http2: true,

  cache: {
    enabled: true,
    ttlMs: 30_000,
    staleWhileRevalidate: true,  // answer instantly from stale, refresh in the background (once per key)
    staleIfError: true,          // serve the last good copy while upstream is failing
    respectCacheControl: true,   // max-age / no-cache / no-store from the API
    invalidateOnMutation: true,  // default: PUT /users/1 drops cached GET /users/1 and /users
    staleTtlMs: 300_000,         // how long past expiry an entry stays usable
    maxEntries: 500,
  },

  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,         // consecutive failures…
    failureRateThreshold: 0.5,   // …or 50% failures over the rolling window
    rollingWindow: 20,
    resetTimeoutMs: 30_000,
    successThreshold: 2,
    halfOpenMaxConcurrent: 1,    // probes allowed while half-open
  },

  rateLimit: { enabled: true, requestsPerInterval: 20, intervalMs: 1_000, burst: 40, onLimit: "wait" },

  retry: {
    limit: 3,
    baseDelayMs: 200,
    maxDelayMs: 10_000,
    jitter: 0.2,
    respectRetryAfter: true,
    maxRetryAfterMs: 10_000,     // a longer Retry-After is not slept on: the error is returned
  },

  dedupe: true,
  idempotency: true,             // auto Idempotency-Key on POST/PUT/PATCH (makes POST/PATCH retryable)
  ssrfProtection: true,
  metrics: true,
  redactKeys: ["x-internal-token"],
});
```

### Retry rules

- Retried: network errors, timeouts, and statuses in `retryStatusCodes` (default `408, 425, 429, 500, 502, 503, 504`).
- **Methods:** `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, `QUERY` by default. `POST` and `PATCH` are retried only when the request carries an `Idempotency-Key` (set `idempotency: true`, pass `idempotencyKey`, or send the header yourself). Setting `retry.methods` explicitly overrides this.
- Streamed request bodies cannot be replayed, so they are never retried.
- Per-request `retry` and `retryLimit` **merge over** the engine's retry configuration.

### Cache behaviour

- Keys include the URL, a **hash of the credentials** (principals never share entries) and a fingerprint of custom request headers / response type (so `Accept-Language` variants don't collide).
- The **raw decoded body** is cached, so a different `responseSchema` per call works. Data is cloned on write and read (`cloneOnRead`, default `true`) so callers can't corrupt the cache.
- Upstream `Cache-Control: no-store` is always honoured. `private` is cacheable because entries are keyed per credential.
- Mutations (`POST`/`PUT`/`PATCH`/`DELETE`) that succeed invalidate cached reads of the same resource, any `Location` / `Content-Location`, and the parent collection.

### Observability & control

```ts
const m = api.getMetrics();
// { totalRequests, successCount, errorCount, retryCount, cacheHits, cacheMisses,
//   staleServed, dedupeHits, rateLimitedCount, circuitRejectedCount, authRefreshes,
//   circuitState, latency: { p50, p95, p99, mean, min, max, count }, byStatus }

api.getCircuitState();                       // "closed" | "open" | "half-open"
api.resetCircuit();
api.resetMetrics();
await api.clearCache();
await api.invalidateCache("GET", "/users/1"); // one exact entry
await api.invalidateResource("/users");       // every variant of a resource
await api.dispose();                          // release sockets and timers
```

### Per-request overrides

```ts
await api.get("/feed", { cache: { ttlMs: 5_000, staleWhileRevalidate: true } });
await api.get("/live", { cache: false });                    // bypass the cache
await api.post("/pay", body, { idempotencyKey: "order-42" });
await api.get("/once", { dedupe: false, retry: false });
await api.get("/slow", { signal: controller.signal });       // AbortSignal
await api.get("/report", { totalTimeoutMs: 60_000, retry: { limit: 5 } });
await api.get<Buffer>("/invoice.pdf", { responseType: "buffer" });
await api.get("/items", { params: { tag: ["a", "b"], page: 2 } }); // ?tag=a&tag=b&page=2
```

### Result metadata and error codes

```ts
const r = await api.get("/users");
r.meta?.cached;     // served from cache
r.meta?.stale;      // a stale copy was served…
r.meta?.staleReason; // …"revalidating" (SWR) or "error" (stale-if-error)
r.meta?.deduped;    // joined an in-flight request
r.meta?.attempts;   // upstream calls made (1 = no retry)
r.meta?.durationMs;
r.meta?.requestId;  // correlation id
r.meta?.retryAfterMs; // a Retry-After too long to honour
```

| `code` | Status | Meaning |
|---|---|---|
| `HTTP_ERROR` | upstream | Upstream replied ≥ 400. The upstream body is in `details`. |
| `REQUEST_VALIDATION` | 400 | Request body failed your schema (nothing was sent). |
| `INVALID_URL` | 400 | The endpoint is not a valid `http(s)` URL. |
| `AUTH_REQUIRED` | 401 | Auth required but no credentials available. |
| `AUTH_PROVIDER_ERROR` | 500 | Your `auth` provider threw (does **not** trip the circuit). |
| `CREDENTIALS_BLOCKED` | 403 | Refused to send engine credentials to a foreign origin. |
| `SSRF_BLOCKED` | 403 | Blocked by SSRF protection (static check, DNS result, or redirect). |
| `RATE_LIMITED` | 429 | Client-side rate limit (reject mode, or `maxWaitMs` exceeded). |
| `CIRCUIT_OPEN` | 503 | Circuit breaker is open. |
| `TIMEOUT` | 504 | Per-attempt timeout or `totalTimeoutMs`. |
| `ABORTED` | 499 | Caller's `AbortSignal` fired. |
| `NETWORK_ERROR` | 500 | Connection-level failure. |
| `PARSE_ERROR` | 502 | A success response could not be decoded. |
| `RESPONSE_VALIDATION` | 502 | Response failed your `responseSchema`. |
| `ENGINE_DISPOSED` | 503 | `dispose()` was called. |
| `INTERNAL_ERROR` | 500 | Unexpected engine error (please report it). |

### Custom cache store (e.g. Redis)

```ts
import type { CacheStore } from "got-api-engine";

const redisStore: CacheStore = {
  async get(key) { /* … */ return undefined; },
  async set(key, value, ttlMs) { /* ttlMs = fresh TTL + stale window: expire the key yourself */ },
  async delete(key) { /* … */ },
  async clear() { /* … */ },
  // optional — lets invalidateOnMutation / invalidateResource reach every variant
  async deleteMatching(predicate) { /* … */ },
};

createEngine({ baseUrl, cache: { enabled: true, store: redisStore } });
```

---

## Security

| Concern | What the engine does |
|---|---|
| **TLS** | Certificates are verified **in every environment**. Disable only for local development with `rejectUnauthorized: false` (a warning is logged). |
| **Credential leaks** | Engine credentials (`auth`, `refreshAuth` tokens) are sent **only** to the `baseUrl` origin and hosts in `credentialHosts`. A caller-controlled absolute URL can't harvest your token: the request fails with `CREDENTIALS_BLOCKED`. Use `auth: false`, an explicit `authToken`, or `credentialHosts` to opt in deliberately. `auth: "optional"` silently omits credentials for foreign origins. |
| **SSRF** | `ssrfProtection` blocks private / loopback / link-local / reserved / multicast ranges for IPv4 **and IPv6** (including IPv4-mapped, NAT64 and 6to4 forms), non-HTTP schemes, embedded credentials and cross-origin redirects, and validates the addresses a hostname **resolves to at connect time** (defeats DNS rebinding and public names that point at internal IPs). Supports `allowHosts` / `blockHosts` (`*.suffix` patterns). |
| **Log redaction** | Authorization, cookies, API keys, tokens and any `redactKeys` are stripped from every log line — including custom loggers — and from URLs in log output. |
| **Proxy hygiene** | Route Handlers forward only the *caller's* `Authorization`; they don't fall back to engine credentials unless you opt in with `useEngineAuth`. Backend `5xx` bodies are not echoed to browsers. |
| **Request ids** | Incoming ids are accepted only if header-safe (`[\w.:-]{1,128}`). |

```ts
const safeProxy = createEngine({
  baseUrl: "https://api.example.com",
  defaultAuth: false,
  ssrfProtection: {
    allowPrivateNetworks: false,
    sameOriginRedirectsOnly: true,
    checkResolvedAddresses: true,
    blockHosts: ["*.internal.corp"],
  },
});
```

---

## API Reference

### `createEngine(config)` / `createNextEngine(config)`

```ts
createEngine({
  baseUrl: string;                // required; must be http(s)

  // ── auth ──
  auth?: string | (() => string | null | undefined | Promise<…>) | AuthProvider;
  defaultAuth?: true | false | "optional" | "none" | "bearer";  // default: true
  refreshAuth?: (ctx) => string | void | Promise<string | void>;
  credentialHosts?: string[];     // extra hosts allowed to receive credentials

  // ── timing & retries ──
  timeoutMs?: number;             // per attempt, default 10_000
  totalTimeoutMs?: number;        // whole request incl. retries; default: none
  retryLimit?: number;            // default 2
  retry?: RetryConfig;

  // ── transport ──
  responseType?: "auto" | "json" | "text" | "buffer";           // default "auto"
  http2?: boolean;                // got 16 native HTTP/2, default false
  dnsCache?: boolean;             // got 16 DNS cache, default false
  rejectUnauthorized?: boolean;   // default true (every environment)
  defaultHeaders?: Record<string, string>;
  requestIdHeader?: string;       // e.g. "X-Request-Id": send the correlation id upstream

  // ── resilience (all opt-in) ──
  cache?: CacheConfig;
  circuitBreaker?: CircuitBreakerConfig;
  rateLimit?: RateLimitConfig;
  dedupe?: boolean;               // default true
  idempotency?: boolean;          // default false
  ssrfProtection?: boolean | SsrfConfig;

  // ── observability ──
  metrics?: boolean;              // default true
  logger?: LoggerInterface;
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
  debug?: boolean;                // shorthand for logLevel "debug"
  serviceName?: string;           // default: LOG_NAME env or "got-api-engine"
  redactKeys?: string[];
  hooks?: { onRequest?, onResponse?, onError?, onRetry?, onCircuitStateChange? };
});
```

### Instance methods

```ts
api.get<T>(endpoint, options?)
api.head(endpoint, options?)
api.options<T>(endpoint, options?)
api.post<T, TBody>(endpoint, body?, options?)
api.put<T, TBody>(endpoint, body?, options?)
api.patch<T, TBody>(endpoint, body?, options?)
api.delete<T, TBody>(endpoint, options?)            // a body is sent if you pass one
api.query<T, TBody>(endpoint, body?, options?)      // HTTP QUERY (safe + idempotent, with a body)
api.request<T, TBody>({ endpoint, method, … })
```

All return `Promise<ApiResult<T>>`:

```ts
type ApiResult<T> =
  | { ok: true;  data: T; status: number; headers?: Record<string, string>; meta?: ResultMeta }
  | { ok: false; error: string; status: number; code?: string; details?: unknown; meta?: ResultMeta };
```

**Request bodies:** plain objects / arrays → JSON (optionally validated with `schema`); `string`, `Buffer`/`Uint8Array`, `ArrayBuffer`, `Blob`, `URLSearchParams`, `FormData` and streams are sent as-is. Bodies are sent for `POST`, `PUT`, `PATCH`, `DELETE` and `QUERY`.

**Per-request options:**

```ts
interface RequestOptions<TBody, TResponse> {
  endpoint: string;                        // path or absolute URL
  method?: HttpMethod;                     // GET POST PUT PATCH DELETE HEAD OPTIONS QUERY
  auth?: AuthMode;
  authToken?: string;                      // explicit token for this request
  body?: TBody | FormData;
  schema?: ZodLike<TBody>;                 // validate the request body
  responseSchema?: ZodLike<TResponse>;     // validate the response
  responseType?: "auto" | "json" | "text" | "buffer";
  timeoutMs?: number;
  totalTimeoutMs?: number;
  retryLimit?: number;
  retry?: RetryConfig | false;             // merges over the engine's retry config
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | null | undefined | Array<…>>;
  requestId?: string;
  signal?: AbortSignal;
  cache?: boolean | number | { ttlMs?: number; staleWhileRevalidate?: boolean };
  dedupe?: boolean;
  idempotencyKey?: string;
}
```

`responseType: "auto"` decodes by `Content-Type`: JSON → object, text → string, binary (`image/*`, `application/pdf`, …) → `Buffer`; with no content type it sniffs for JSON. Error bodies are always decoded leniently, so a malformed or HTML error page never masks the real HTTP status.

### `api.extend(overrides)` — fork an engine

```ts
const adminApi = api.extend({ defaultHeaders: { "X-Role": "admin" }, timeoutMs: 30_000 });
const v2Api = api.extend({ baseUrl: "https://api.example.com/v2" });
```

The fork inherits the parent's **complete** configuration (SSRF, cache, breaker, rate limit, retry, metrics…). Config objects (`cache`, `circuitBreaker`, `rateLimit`, `retry`, `ssrfProtection`) are shallow-merged, `defaultHeaders` are merged case-insensitively, `hooks` are **appended**, and `redactKeys` / `credentialHosts` are unioned. Runtime state (cache contents, breaker, metrics, sockets) is **not** shared. On a `NextApiEngine`, `extend()` returns a `NextApiEngine`.

### Lifecycle

```ts
await api.dispose();               // destroys keep-alive agents, stops the rate limiter
// later calls resolve to { ok: false, code: "ENGINE_DISPOSED" }

await using tmp = createEngine({ baseUrl }); // disposed automatically at block end
```

---

### Next.js-specific methods (`got-api-engine/next`)

#### `engine.handleRoute(req, options)` → `Promise<Response>`

Proxies a Route Handler request to your backend using only the standard Web `Response`.

```ts
api.handleRoute(req, {
  endpoint: "/orders/1",
  method: "PUT",
  schema: UpdateOrderSchema,
  auth: true,
  forwardClientIp: true,          // default true (sanitised X-Forwarded-For)
  forwardQuery: true,             // default true, for every HTTP method
  responseType: "buffer",         // decode mode for the upstream response
  forwardResponseHeaders: ["content-disposition", "etag"], // default: content-disposition, content-language,
                                  // etag, last-modified, retry-after · `false` = none · Set-Cookie never unless listed
  exposeUpstreamDetails: undefined, // default: upstream error details for 4xx, hidden for 5xx
  useEngineAuth: false,           // default false — see Security
});
```

- Body handling: JSON (validated if `schema`), `multipart/form-data`, and any other content type (text, `x-www-form-urlencoded`, `octet-stream`…) is proxied **verbatim**. An empty body with a JSON content type is fine.
- Responses: JSON, text and binary payloads are returned with the upstream `Content-Type`; `204`/`304` are null-body responses. Every response carries `X-Request-Id` (the incoming id if valid, otherwise generated).
- Errors: `{ error, details?, code? }` with the upstream status; `Retry-After` is forwarded for throttled responses.
- The incoming request's `signal` is passed down, so a client disconnect cancels the upstream call.

#### `engine.serverGet/Post/Put/Patch/Delete(endpoint, body?, options?)`

For Server Actions and RSC. Pass `session` (with `access_token` or `accessToken`) or configure an `auth` provider on the engine:

```ts
"use server";
export async function updateOrder(id: string, data: OrderUpdate) {
  return api.serverPatch(`/orders/${encodeURIComponent(id)}`, data); // engine `auth` supplies the token
}
```

#### `engine.buildRouteHandlers()`

```ts
const routes = api.buildRouteHandlers();
export const GET = (req: Request) => routes.GET(req, "/products");
export const POST = (req: Request) => routes.POST(req, { endpoint: "/products" });
```

---

### Auth providers

```ts
import {
  createStaticAuth, createDynamicAuth, createNextAuthProvider, createBrowserStorageAuth,
  createApiKeyAuth, createBasicAuth, createRefreshableAuth,
} from "got-api-engine";

createEngine({ baseUrl, auth: "token" });                              // string → "Bearer token"
createEngine({ baseUrl, auth: createDynamicAuth(async () => getToken()) });
createEngine({ baseUrl, auth: createNextAuthProvider(() => auth()) }); // access_token or accessToken
createEngine({ baseUrl, auth: createBrowserStorageAuth("jwt", "localStorage") });
createEngine({ baseUrl, auth: createApiKeyAuth("k-123") });            // X-API-Key header (configurable)
createEngine({ baseUrl, auth: createBasicAuth("user", "pass") });      // Authorization: Basic …
```

A value that already carries a scheme (`Bearer …`, `Basic …`, `ApiKey …`) is used as-is; a bare token gets `Bearer`.

**Self-refreshing tokens + 401 handling**

```ts
const tokens = createRefreshableAuth({
  refresh: async () => (await fetchNewToken()).access_token, // or { token, expiresInSec }
  skewMs: 30_000,  // refresh 30s before expiry; JWT `exp` is read automatically
});

const api = createEngine({
  baseUrl,
  auth: tokens,
  refreshAuth: () => tokens.refreshNow(), // on a 401: refresh once (shared), then replay the request
});
```

`refreshAuth` runs single-flight — a burst of concurrent `401`s causes exactly one refresh — and the request is replayed at most once. If your hook returns a string, the engine uses it from then on.

**Custom provider**

```ts
import type { AuthProvider } from "got-api-engine";

class MyAuth implements AuthProvider {
  async getAuthHeader() {
    const t = await store.get();
    return t ? `Bearer ${t}` : null;
  }
  // optional extra credential headers:
  getHeaders() { return { "X-Tenant": "acme" }; }
}
```

---

### Logging

The engine logs through a built-in, dependency-free console logger. Successful requests log at `debug`; failures at `warn` / `error`. Control it with:

```ts
createEngine({ baseUrl, logLevel: "warn" });   // "debug" | "info" | "warn" | "error" | "silent"
createEngine({ baseUrl, debug: true });        // shorthand for "debug"
// or the LOG_LEVEL environment variable
```

**Winston (optional).** Install `winston` and pass the logger explicitly:

```ts
import { createEngine, createLogger } from "got-api-engine";

const api = createEngine({ baseUrl, logger: await createLogger("my-service") }); // falls back to console if winston is absent
```

**Bring your own logger** (Pino shown):

```ts
import pino from "pino";
const log = pino();

const wrap = (l: pino.Logger) => ({
  debug: (m: string, meta?: object) => l.debug(meta ?? {}, m),
  info:  (m: string, meta?: object) => l.info(meta ?? {}, m),
  warn:  (m: string, meta?: object) => l.warn(meta ?? {}, m),
  error: (m: string, meta?: object) => l.error(meta ?? {}, m),
  child: (c: object) => wrap(l.child(c)),
});

createEngine({ baseUrl, logger: wrap(log) });
```

Whatever logger you use, sensitive values are redacted before they reach it.

---

### Lifecycle hooks

```ts
createEngine({
  baseUrl,
  hooks: {
    onRequest:  (ctx) => { /* { url, method, headers (mutable), body, requestId } — once per request, after a cache miss */ },
    onResponse: (ctx) => { /* { url, method, status, body, durationMs, requestId } — per upstream response */ },
    onError:    (ctx) => { /* { url, method, error, durationMs, requestId } — network / timeout / abort / SSRF */ },
    onRetry:    (ctx) => { /* { url, method, attempt, delayMs, reason } */ },
    onCircuitStateChange: (ctx) => { /* { from, to, serviceName, failureCount } */ },
  },
});
```

Pass an array for several hooks per event. A hook that throws is logged and ignored.

---

### Schema validation (Zod or any `safeParse` library)

```ts
import { z } from "zod";

const CreateUser = z.object({ name: z.string().min(2), email: z.email() });
await api.post("/users", form, { schema: CreateUser });          // 400 REQUEST_VALIDATION before sending

const User = z.object({ id: z.number(), name: z.string() });
const user = await api.get<z.infer<typeof User>>("/users/1", { responseSchema: User });
```

A schema that throws is reported as a validation error; it never crashes the request or triggers retries.

---

### Batch requests

```ts
import { batchRequests, BatchRequestError } from "got-api-engine";

const results = await batchRequests(api, [
  { key: "users",    options: { endpoint: "/users" } },
  { key: "products", options: { endpoint: "/products" } },
], { concurrency: 3 });

results.users.ok;

// Stop on the first failure: unstarted requests are skipped and in-flight ones are aborted.
try {
  await batchRequests(api, items, { concurrency: 2, failFast: true, signal });
} catch (e) {
  if (e instanceof BatchRequestError) console.error(e.key, e.result);
}
```

Keys must be unique (a duplicate throws `TypeError`).

---

### `withRetry`

For retrying *around* a call (for example a whole workflow) — separate from the engine's built-in retry:

```ts
import { withRetry } from "got-api-engine";

const result = await withRetry(
  (attempt) => api.get("/flaky-service", { retry: false }),
  {
    retries: 5,
    baseDelayMs: 300,        // exponential with jitter: ~300ms, 600ms, 1.2s … capped at maxDelayMs
    maxDelayMs: 10_000,
    signal,                   // abortable during backoff
    onRetry: ({ attempt, delayMs }) => console.warn(attempt, delayMs),
    // default policy: network errors, 408/425/429, 5xx except 501/505. Never aborts or 4xx.
    shouldRetry: (r) => !r.ok && r.status >= 500,
  },
);
```

Avoid stacking `withRetry` on top of the engine's own retry unless you disable one of them: the attempts multiply.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `LOG_LEVEL` | Minimum log level (`debug`, `info`, `warn`, `error`, `silent`) for the built-in and Winston loggers. `logLevel` / `debug` take precedence. |
| `LOG_NAME` | Default `serviceName`. |
| `NODE_ENV` | Only affects the **Winston** logger's output format (colourised vs JSON). It no longer influences TLS verification. |

---

## Upgrading from v2

v3 fixes a number of bugs and tightens insecure defaults. Most applications need no changes; check these points.

| # | Change | Action |
|---|---|---|
| 1 | **TLS is verified in every environment.** v2 disabled certificate verification whenever `NODE_ENV !== "production"` (including unset, `test`, `staging`). | If you rely on a self-signed certificate locally, set `rejectUnauthorized: false` explicitly. |
| 2 | **Credentials are scoped.** v2 sent the engine's token to *any* absolute URL passed as `endpoint`. Now only the `baseUrl` origin and `credentialHosts` receive it. | For other hosts use `auth: false`, `authToken`, or add them to `credentialHosts`. Code `CREDENTIALS_BLOCKED` tells you when this triggers. |
| 3 | **`POST`/`PATCH` are not retried by default** (v2's code retried them, contradicting its docs, which risks double-charging). | Enable `idempotency: true` or pass `idempotencyKey` to make them retryable, or list them in `retry.methods`. |
| 4 | **`ApiKeyAuthProvider`** now sends the key in its own header (`X-API-Key` by default). v2 produced the invalid `Authorization: Bearer ApiKey …`. | Nothing, unless you relied on the broken header. Pass a custom header name if needed. |
| 5 | **`extend()` keeps the full config.** v2 silently dropped the parent's `cache`, `circuitBreaker`, `rateLimit`, `retry`, `ssrfProtection`, `metrics`… unless re-specified; hooks were replaced. | Review forks: hooks are now *appended*. |
| 6 | **Response decoding.** Bodies are decoded by the engine: text responses are returned as strings (v2 failed on non-JSON success bodies) and binary responses as `Buffer`. `Buffer`/`Uint8Array` request bodies are sent raw (v2 JSON-serialised them). | Use `responseType: "json"` to force strict JSON parsing. |
| 7 | **Successful requests log at `debug`** (v2: `info`, which is noisy in production). | Use `logLevel: "info"` / `debug: true` to see them. |
| 8 | **Winston is optional and explicit.** It is no longer a dependency, and the engine does not auto-detect it (v2's README said it did, the code didn't). | `logger: await createLogger("name")` to use Winston. |
| 9 | **Route Handlers:** forward the caller's `Authorization` (any scheme, not just `Bearer`); never fall back to engine credentials unless `useEngineAuth: true`; hide upstream 5xx bodies; no longer import `next/server`. | v2 returned no upstream error body at all; 4xx details are now forwarded. Set `exposeUpstreamDetails: true` to forward 5xx details too, or `false` to forward none. |
| 10 | **Packaging.** Runtime dependencies are just `got ^16`. `uuid` and `winston` are gone (ids use `crypto.randomUUID`), `got` is no longer a peer, and `react` / `next` / `zod` / `winston` are *optional* peers (npm no longer auto-installs React). Build output is `.cjs` / `.mjs` with `.d.cts` / `.d.mts`. | None for normal imports; deep imports of `dist/*.js` must change. |
| 11 | **Stricter `baseUrl`.** The constructor throws a `TypeError` for a missing or non-`http(s)` `baseUrl`. | Make sure env vars are set at module load. |

Other bug fixes worth knowing about (no action needed): cache hits and de-duplicated followers no longer consume rate-limit tokens or get blocked by an open circuit; rate limiting and the breaker now apply to every retry; per-request `retryLimit` is honoured; per-request `retry` merges instead of resetting the engine's config; `Retry-After` is capped; SSRF IPv4-mapped IPv6 bypass (`http://[::ffff:127.0.0.1]/`) closed; SSRF errors are reported as `SSRF_BLOCKED` instead of being retried as network errors; the 32-bit FNV-1a credential fingerprint in cache keys replaced with a 132-bit SHA-256 prefix (a 32-bit hash can collide across principals); dedupe keys now include headers and credentials; aborting one caller no longer fails callers that joined its request; half-open now admits a single probe; token functions are called once per request; `safeStringify` no longer mislabels shared references as circular. See [CHANGELOG.md](./CHANGELOG.md) for the complete list.

---

## Development

```bash
npm install
npm run typecheck     # tsc 7.0.2 over src, tests and examples
npm test              # vitest: real local HTTP servers, no mocks
npm run build         # tsdown → dist (ESM + CJS + types)
npm run lint:package  # publint + are-the-types-wrong
```

Set `TEST_CERT_DIR` to a directory containing `k.pem` / `c.pem` to also run the HTTP/2 tests:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/cert/k.pem -out /tmp/cert/c.pem \
  -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
TEST_CERT_DIR=/tmp/cert npm test
```

---

## Architecture

```
got-api-engine
├── src/
│   ├── core/
│   │   ├── engine.ts          ← GotApiEngine: the request pipeline
│   │   ├── circuit-breaker.ts ← three-state breaker with bounded half-open probes
│   │   ├── cache-store.ts     ← in-memory LRU with physical TTL
│   │   ├── rate-limiter.ts    ← FIFO token bucket (abortable waiters)
│   │   ├── metrics.ts         ← counters + latency percentiles
│   │   ├── backoff.ts         ← backoff, Retry-After, method policy
│   │   └── security.ts        ← SSRF guard, guarded DNS lookup, credential scoping, redaction
│   ├── adapters/
│   │   ├── next.ts            ← NextApiEngine (Route Handlers + Server Actions)
│   │   └── node.ts            ← batchRequests, withRetry
│   ├── plugins/
│   │   └── auth-providers.ts  ← Static, Dynamic, NextAuth, BrowserStorage, ApiKey, Basic, Refreshable
│   ├── utils/
│   │   ├── logger.ts          ← console + optional Winston logger
│   │   └── helpers.ts         ← URL/headers/body decoding, error parsing, cache keys
│   ├── types/index.ts         ← public types
│   └── index.ts               ← public API barrel
├── test/                      ← vitest suites (HTTP servers, HTTP/2, security, adapters)
├── examples/                  ← type-checked usage examples
└── tsdown.config.mts          ← build config
```

---

## License

MIT — [code-plate](https://www.npmjs.com/~code-plate)
