# Requests and results

## Verbs

```ts
await api.get<User>("/users/1");
await api.post("/users", { name: "Sara" });            // objects → JSON
await api.put("/files/1", buffer);                      // Buffer / string / Blob / FormData / streams as-is
await api.patch("/users/1", { name: "Ali" });
await api.delete("/users/1");
await api.query("/search", { q: "x" });                 // HTTP QUERY: safe, with a body
await api.request({ endpoint: "/x", method: "OPTIONS" });
```

## Results

```ts
type ApiResult<T> =
  | { ok: true; data: T; status: number; headers?: Record<string, string>; meta?: ResultMeta }
  | { ok: false; error: string; status: number; code?: ErrorCode; details?: unknown; meta?: ResultMeta };
```

`meta` carries `requestId`, `durationMs`, `attempts`, `cached`, `stale`,
`deduped`, `hedged`, `fallback`, `upstream` and per-phase `timings`
(`dns`, `tcp`, `tls`, `firstByte`, `download`, `total`).

Results are plain objects, so they can be returned from Server Actions.

### Prefer exceptions?

```ts
import { unwrap, isApiError, mapResult, ApiError } from "got-api-engine";

const user = await api.requestData<User>({ endpoint: "/users/1" }); // throws ApiError
const same = unwrap(await api.get<User>("/users/1"));
const api2 = createEngine({ baseUrl, throwOnError: true });

if (isApiError(r, "TIMEOUT", "CIRCUIT_OPEN")) showRetryLater();
const names = mapResult(r, (users) => users.map((u) => u.name));
```

## Options

| Option | Purpose |
| --- | --- |
| `params` | query string; arrays become repeated keys |
| `headers`, `responseType` | `"auto"`, `"json"`, `"text"`, `"buffer"`, `"stream"` |
| `timeoutMs`, `totalTimeoutMs`, `retry`, `signal` | timing and cancellation |
| `schema`, `responseSchema` | request / response validation |
| `cache`, `dedupe`, `invalidateTags` | caching |
| `fallback` | value (or function) returned as success when the request fails |
| `transformKeys` | `snake` ⇄ `camel` |
| `idempotencyKey`, `maxResponseBytes`, `hedge` | safety and tail latency |
| `onUploadProgress`, `onDownloadProgress` | progress callbacks |
| `throwOnError`, `metricsLabel` | ergonomics, metrics |

## Safe paths

Relative endpoints may not contain `.` / `..` segments or escape the base
path (`strictPath`). Build paths from user input with the `path` tag:

```ts
import { path } from "got-api-engine";
await api.get(path`/users/${userId}/orders`); // "../admin" throws, "a/b" → "a%2Fb"
```

## Pagination

```ts
for await (const order of api.paginate<Order>("/orders", { strategy: "cursor" })) {
  …
}
// strategies: "link" (RFC 8288), "cursor", "page", or a custom next()
```

## Batching (N+1)

```ts
const users = api.batcher<string, User>(async (ids) =>
  unwrap(await api.get<User[]>("/users", { params: { ids: ids.join(",") } })),
);
await Promise.all([users.load("1"), users.load("2")]); // one upstream call
```

## Streaming

```ts
const r = await api.get<ReadableStream<Uint8Array>>("/events", { responseType: "stream" });
if (r.ok) for await (const chunk of r.data) …
```
