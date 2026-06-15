# got-api-engine

[![npm version](https://img.shields.io/npm/v/got-api-engine.svg)](https://www.npmjs.com/package/got-api-engine)
[![license](https://img.shields.io/npm/l/got-api-engine.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/got-api-engine.svg)](./dist/index.d.ts)

A **modular, framework-agnostic HTTP proxy engine** built on [got](https://github.com/sindresorhus/got).  
Works with **Next.js** (App Router, Route Handlers, Server Actions), **plain React**, **Node.js**, and **vanilla JavaScript**.

---

## Features

- **Instance-based** — create isolated engine instances with their own config, auth, and logger
- **Framework-agnostic** — core works anywhere; Next.js adapter available separately
- **Circuit breaker** — three-state breaker stops hammering a failing upstream and recovers automatically
- **Response caching** — in-memory LRU (or bring your own store) with TTL, `stale-while-revalidate`, and ETag/Last-Modified conditional revalidation
- **Request deduplication** — identical in-flight GET/HEAD requests share a single upstream call (single-flight)
- **Resilient retries** — exponential backoff with jitter, `Retry-After` support, configurable status codes/methods
- **Client-side rate limiting** — token-bucket with `wait` or `reject` strategies
- **SSRF protection** — blocks private/loopback/link-local targets and cross-origin redirects; host allow/block lists
- **Metrics & observability** — request counts, error/retry/cache/dedupe counters, latency percentiles (p50/p95/p99), live circuit state
- **Idempotency keys** — auto-attach `Idempotency-Key` to mutating requests so safe retries don't double-execute
- **Log redaction** — tokens, cookies, and secrets are stripped from logs automatically
- **Pluggable auth** — static token, dynamic callback, next-auth session, localStorage, or custom
- **Lifecycle hooks** — `onRequest`, `onResponse`, `onError`, `onRetry`, `onCircuitStateChange`
- **Schema validation** — Zod-compatible request & response validation (no hard dependency)
- **Structured logging** — Winston (if installed) or built-in console logger; fully replaceable
- **Batch requests** — true sliding-window concurrency pool
- **`extend()`** — fork an engine with partial config overrides
- **Full TypeScript** — strict types throughout, zero `any` leaks in public API
- **Zero heavyweight crypto deps** — JWT id extraction is decode-only and dependency-free

---

## Installation

**Requirements:** Node.js **22+** (required by `got` v15, which is ESM-only and Node 22+ only).

```bash
npm install got-api-engine
# or
pnpm add got-api-engine
# or
yarn add got-api-engine
```

**Optional peer dependencies:**

```bash
npm install zod          # for schema validation
npm install winston      # for enhanced logging (auto-detected, falls back to console)
npm install next         # for Next.js adapter
```

---

## Quick Start

### Vanilla JS / Node.js / React (client-side)

```ts
import { createEngine } from "got-api-engine";

const api = createEngine({
  baseUrl: "https://api.example.com",
  auth: "my-secret-token",
  debug: true,
});

const result = await api.get<User>("/users/1");

if (result.ok) {
  console.log(result.data); // User
} else {
  console.error(result.error, result.status);
}
```

### Next.js App Router

```ts
// lib/api.ts — create once, share everywhere
import { createNextEngine } from "got-api-engine/next";

export const api = createNextEngine({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  serviceName: "MyApp",
  debug: process.env.NODE_ENV !== "production",
});
```

```ts
// app/api/users/route.ts
import { api } from "@/lib/api";

export async function GET(req: Request) {
  return api.handleRoute(req, { endpoint: "/users", method: "GET" });
}

export async function POST(req: Request) {
  return api.handleRoute(req, {
    endpoint: "/users",
    method: "POST",
    schema: CreateUserSchema, // Zod schema
  });
}
```

```ts
// app/actions/user.ts
"use server";
import { api } from "@/lib/api";
import { getServerSession } from "next-auth";

export async function getProfile() {
  const session = await getServerSession(authOptions);
  return api.serverGet("/me", { session });
}
```

---

## Production Features (v2.1)

All resilience features are **opt-in** and composable. They run as a pipeline:
`rate-limit → circuit-breaker → dedupe → cache → request (retry/backoff) → validate → metrics`.

```ts
const api = createEngine({
  baseUrl: "https://api.example.com",

  // Response cache (GET/HEAD), in-memory LRU by default
  cache: {
    enabled: true,
    ttlMs: 30_000,
    staleWhileRevalidate: true,   // serve stale, refresh in background
    conditional: true,           // ETag / If-None-Match revalidation
    maxEntries: 500,
  },

  // Circuit breaker
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,         // consecutive failures to open
    failureRateThreshold: 0.5,   // OR 50% error rate over the rolling window
    rollingWindow: 20,
    resetTimeoutMs: 30_000,      // cooldown before half-open probe
    successThreshold: 2,         // successes in half-open to close
  },

  // Client-side rate limiting (token bucket)
  rateLimit: {
    enabled: true,
    requestsPerInterval: 20,
    intervalMs: 1_000,
    burst: 40,
    onLimit: "wait",             // or "reject" → fail fast with 429
  },

  // Retry layer (exponential backoff + jitter, engine-managed)
  retry: {
    limit: 3,
    baseDelayMs: 200,
    maxDelayMs: 10_000,
    jitter: 0.2,
    retryStatusCodes: [408, 425, 429, 500, 502, 503, 504],
    respectRetryAfter: true,
  },

  dedupe: true,                  // collapse identical in-flight GET/HEAD
  idempotency: true,             // auto Idempotency-Key on POST/PUT/PATCH
  ssrfProtection: true,          // block private/loopback + cross-origin redirects
  metrics: true,                 // default on
  redactKeys: ["x-internal-token"],
});
```

### Observability & control

```ts
const m = api.getMetrics();
// { totalRequests, successCount, errorCount, retryCount, cacheHits,
//   cacheMisses, dedupeHits, rateLimitedCount, circuitRejectedCount,
//   circuitState, latency: { p50, p95, p99, mean, min, max, count }, byStatus }

api.getCircuitState();   // "closed" | "open" | "half-open"
api.resetCircuit();
await api.clearCache();
await api.invalidateCache("GET", "/users/1");
api.resetMetrics();
```

### Per-request overrides

```ts
await api.get("/feed", { cache: { ttlMs: 5_000, staleWhileRevalidate: true } });
await api.get("/live", { cache: false });            // bypass cache
await api.post("/pay", body, { idempotencyKey: "order-42" });
await api.get("/once", { dedupe: false, retry: false });
await api.get("/slow", { signal: controller.signal }); // AbortSignal
```

### Result metadata

Every result carries a `meta` block:

```ts
const r = await api.get("/users");
r.meta?.cached;     // served from cache?
r.meta?.stale;      // stale-while-revalidate hit?
r.meta?.deduped;    // joined an in-flight request?
r.meta?.attempts;   // number of attempts (1 = no retry)
r.meta?.durationMs; // total wall-clock time
```

Error results also include a machine-readable `code`: `CIRCUIT_OPEN`,
`RATE_LIMITED`, `TIMEOUT`, `SSRF_BLOCKED`, `AUTH_REQUIRED`, `HTTP_ERROR`,
`REQUEST_VALIDATION`, `RESPONSE_VALIDATION`, `NETWORK_ERROR`, `ABORTED`.

### Custom cache store (e.g. Redis)

```ts
import type { CacheStore, CachedResponse } from "got-api-engine";

const redisStore: CacheStore = {
  async get(key) { /* … */ return undefined; },
  async set(key, value, ttlMs) { /* … */ },
  async delete(key) { /* … */ },
  async clear() { /* … */ },
};

createEngine({ baseUrl, cache: { enabled: true, store: redisStore } });
```

---

## API Reference

### `createEngine(config)` / `createNextEngine(config)`

Creates a new engine instance.

```ts
const api = createEngine({
  baseUrl: string;             // required — backend base URL

  auth?:                       // optional auth source
    | string                   //   static token
    | (() => string | null)    //   sync/async callback
    | AuthProvider;            //   provider object

  defaultAuth?:                // auth mode for all requests
    | true                     //   (default) auth required
    | false                    //   no auth
    | "optional"               //   forward if present
    | "none"                   //   alias for false
    | "bearer";                //   alias for true

  timeoutMs?: number;          // default: 10_000
  retryLimit?: number;         // default: 2  (GET + PUT only)
  debug?: boolean;             // verbose logging, default: false
  serviceName?: string;        // log prefix, default: "got-api-engine"
  rejectUnauthorized?: boolean;// TLS cert validation (auto-false in dev)
  defaultHeaders?: Record<string, string>;
  logger?: LoggerInterface;    // custom logger

  hooks?: {
    onRequest?: RequestHook | RequestHook[];
    onResponse?: ResponseHook | ResponseHook[];
    onError?: ErrorHook | ErrorHook[];
  };
});
```

---

### Instance methods

#### `api.get<TResponse>(endpoint, options?)`
#### `api.post<TResponse, TBody>(endpoint, body?, options?)`
#### `api.put<TResponse, TBody>(endpoint, body?, options?)`
#### `api.patch<TResponse, TBody>(endpoint, body?, options?)`
#### `api.delete<TResponse>(endpoint, options?)`

All return `Promise<ApiResult<TResponse>>`:

```ts
type ApiResult<T> =
  | { ok: true;  data: T; status: number; headers?: Record<string, string> }
  | { ok: false; error: string; status: number; details?: unknown };
```

**Per-request options:**

```ts
interface RequestOptions<TBody, TResponse> {
  endpoint: string;
  method?: HttpMethod;
  auth?: AuthMode;           // override engine-level auth mode
  authToken?: string;        // override token for this request only
  body?: TBody | FormData;
  schema?: ZodLike<TBody>;   // validate request body
  responseSchema?: ZodLike<TResponse>; // validate response
  timeoutMs?: number;
  retryLimit?: number;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
}
```

---

---

#### Observability & control methods

```ts
api.getMetrics():       MetricsSnapshot | null   // null if metrics disabled
api.resetMetrics():     void
api.getCircuitState():  "closed" | "open" | "half-open"
api.resetCircuit():     void
api.clearCache():       Promise<void>
api.invalidateCache(method, endpoint, opts?): Promise<void>
```

---

#### `api.extend(overrides)` — fork engine

```ts
const adminApi = api.extend({
  defaultHeaders: { "X-Role": "admin" },
  timeoutMs: 30_000,
});

const v2Api = api.extend({ baseUrl: "https://api.example.com/v2" });
```

---

### Next.js-specific methods (`got-api-engine/next`)

#### `engine.handleRoute(req, options)` → `Promise<Response>`

Proxies a Next.js Route Handler request to your backend.

```ts
// app/api/orders/[id]/route.ts
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  return api.handleRoute(req, {
    endpoint: `/orders/${params.id}`,
    method: "PUT",
    schema: UpdateOrderSchema,
    forwardClientIp: true, // default: true
  });
}
```

#### `engine.serverGet/Post/Put/Patch/Delete(endpoint, body?, options?)`

For use in Server Actions and RSC:

```ts
"use server";
export async function updateOrder(id: string, data: OrderUpdate) {
  const session = await getServerSession(authOptions);
  return api.serverPatch(`/orders/${id}`, data, { session });
}
```

#### `engine.buildRouteHandlers()`

Returns a compact route handler set:

```ts
const routes = api.buildRouteHandlers();

export const GET = (req: Request) => routes.GET(req, "/products");
export const POST = (req: Request) => routes.POST(req, { endpoint: "/products" });
```

---

### Auth Providers

```ts
import {
  createStaticAuth,
  createDynamicAuth,
  createNextAuthProvider,
  createBrowserStorageAuth,
} from "got-api-engine";

// Static token
const api = createEngine({ baseUrl: "...", auth: createStaticAuth("token123") });

// Dynamic (async) callback
const api = createEngine({
  baseUrl: "...",
  auth: createDynamicAuth(async () => {
    const token = await getTokenFromSomewhere();
    return token;
  }),
});

// next-auth session
const api = createEngine({
  baseUrl: "...",
  auth: createNextAuthProvider(() => getServerSession(authOptions)),
});

// Browser localStorage
const api = createEngine({
  baseUrl: "...",
  auth: createBrowserStorageAuth("jwt_token", "localStorage"),
});
```

**Custom AuthProvider:**

```ts
import type { AuthProvider } from "got-api-engine";

class MyCustomAuth implements AuthProvider {
  async getAuthHeader(): Promise<string | null> {
    const token = await myTokenStore.get();
    return token ? `Bearer ${token}` : null;
  }
}
```

---

### Logging

Built-in logger (winston if installed, console otherwise). Override with your own:

```ts
// Pino example
import pino from "pino";
const log = pino();

const api = createEngine({
  baseUrl: "...",
  logger: {
    debug: (msg, meta) => log.debug(meta ?? {}, msg),
    info:  (msg, meta) => log.info(meta ?? {}, msg),
    warn:  (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
    child: (childMeta) => {
      const child = log.child(childMeta);
      return {
        debug: (msg, meta) => child.debug(meta ?? {}, msg),
        info:  (msg, meta) => child.info(meta ?? {}, msg),
        warn:  (msg, meta) => child.warn(meta ?? {}, msg),
        error: (msg, meta) => child.error(meta ?? {}, msg),
      };
    },
  },
});
```

Enable debug mode:

```ts
const api = createEngine({
  baseUrl: "...",
  debug: true, // logs every request/response detail
});
```

---

### Lifecycle Hooks

```ts
const api = createEngine({
  baseUrl: "...",
  hooks: {
    onRequest: (ctx) => {
      // ctx: { url, method, headers, body }
      console.log(`→ ${ctx.method} ${ctx.url}`);
    },
    onResponse: (ctx) => {
      // ctx: { url, method, status, body, durationMs }
      if (ctx.durationMs > 2000) {
        console.warn(`Slow: ${ctx.url} took ${ctx.durationMs}ms`);
      }
    },
    onError: (ctx) => {
      // ctx: { url, method, error, durationMs }
      Sentry.captureException(ctx.error);
    },
  },
});
```

Multiple hooks per event are supported (pass an array).

---

### Schema Validation (Zod)

```ts
import { z } from "zod";

const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.email(),
});

// Validate request body
const result = await api.post("/users", formData, {
  schema: CreateUserSchema,
});

// Validate response
const UserSchema = z.object({ id: z.number(), name: z.string() });

const user = await api.get<z.infer<typeof UserSchema>>("/users/1", {
  responseSchema: UserSchema,
});
```

Any Zod-compatible library with a `safeParse` method works — no hard peer-dep required.

---

### Batch Requests

```ts
import { batchRequests } from "got-api-engine";

// Parallel — all at once
const results = await batchRequests(api, [
  { key: "users",    options: { endpoint: "/users",    method: "GET" } },
  { key: "products", options: { endpoint: "/products", method: "GET" } },
  { key: "tags",     options: { endpoint: "/tags",     method: "GET" } },
]);

console.log(results.users.ok);    // boolean
console.log(results.products.ok); // boolean

// With concurrency limit
const results2 = await batchRequests(api, items, { concurrency: 3 });
```

---

### Custom Retry

```ts
import { withRetry } from "got-api-engine";

const result = await withRetry(
  () => api.get("/flaky-service"),
  {
    retries: 5,
    baseDelayMs: 300,      // exponential: 300ms, 600ms, 1.2s, 2.4s, 4.8s
    shouldRetry: (r) => !r.ok && r.status >= 500,
  },
);
```

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` enables strict TLS, JSON logs |
| `LOG_LEVEL` | Winston log level (`debug`, `info`, `warn`, `error`) |
| `LOG_NAME` | Override default log service name |

---

## Architecture

```
got-api-engine
├── src/
│   ├── core/
│   │   ├── engine.ts          ← GotApiEngine class (framework-agnostic pipeline)
│   │   ├── circuit-breaker.ts ← three-state circuit breaker
│   │   ├── cache-store.ts     ← in-memory LRU response cache
│   │   ├── rate-limiter.ts    ← token-bucket rate limiter
│   │   ├── metrics.ts         ← metrics collector (latency percentiles)
│   │   ├── backoff.ts         ← exponential backoff + jitter helpers
│   │   └── security.ts        ← SSRF guard + log redaction
│   ├── adapters/
│   │   ├── next.ts            ← NextApiEngine (Route Handlers + Server Actions)
│   │   └── node.ts            ← batchRequests, withRetry
│   ├── plugins/
│   │   └── auth-providers.ts  ← StaticAuth, DynamicAuth, NextAuth, BrowserStorage
│   ├── utils/
│   │   ├── logger.ts          ← winston/console logger factory
│   │   └── helpers.ts         ← URL builder, error parser, header utils
│   ├── types/
│   │   └── index.ts           ← All public TypeScript types
│   └── index.ts               ← Public API barrel
```

---

## License

MIT — [code-plate](https://www.npmjs.com/~code-plate)
