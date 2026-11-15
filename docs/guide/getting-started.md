# Getting started

## Install

```bash
npm i got-api-engine
```

Requires **Node.js ≥ 22.12** and runs on the Node.js runtime (not the Edge runtime).

| Entry point | Contents |
| --- | --- |
| `got-api-engine` | engine, typed endpoints, auth providers, plugins, helpers |
| `got-api-engine/next` | `createNextEngine`, `createProxy`, form helpers |
| `got-api-engine/node` | `batchRequests`, `withRetry` |
| `got-api-engine/redis` | `RedisCacheStore`, `RedisRateLimiter` |
| `got-api-engine/testing` | `createMockEngine`, `recorder` |
| `got-api-engine/codegen` | `generateFromOpenApi` (also the `got-api-engine-codegen` CLI) |

## First request

```ts
import { createEngine } from "got-api-engine";

export const api = createEngine({
  baseUrl: "https://api.example.com",
  auth: () => process.env.API_TOKEN, // credentials are required by default
});

const r = await api.get<User[]>("/users", { params: { page: 2 } });
if (r.ok) console.log(r.data);
else console.error(r.code, r.status, r.error);
```

Calls never throw by default — they resolve to an [`ApiResult`](./requests#results).
Create **one engine per upstream** and reuse it: it owns connection pools,
caches, circuit breakers and metrics.

## Sensible defaults

| Setting | Default |
| --- | --- |
| Per-attempt timeout | 10 s |
| Overall deadline (incl. retries) | 30 s |
| Retries | 2 (idempotent methods, network errors, 408/425/429/5xx) |
| Dedupe of identical in-flight GET/HEAD | on |
| Credentials | required, only sent to `baseUrl` origins |
| Response size cap | 50 MiB |
| TLS verification | on, everywhere |

Next: [Requests and results](./requests).
