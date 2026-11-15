# Caching

```ts
import { RedisCacheStore } from "got-api-engine/redis";

const api = createEngine({
  baseUrl,
  cache: {
    enabled: true,
    ttlMs: 30_000,
    staleWhileRevalidate: true,
    staleIfError: true,
    respectCacheControl: true,
    store: new RedisCacheStore(redis),       // default: in-memory LRU bounded by entries and bytes
    keySecret: process.env.CACHE_KEY_SECRET, // same secret on every instance sharing the store
  },
});
```

## What is cached

GET and HEAD (configurable — `QUERY` bodies become part of the key) with
status 200 / 203 / 204. Entries are partitioned per **credential** (HMAC),
header variant and response type; `Vary` is honoured. `shared: true` builds a
public cache and refuses `Cache-Control: private` responses.

## Freshness

| Upstream says | Behaviour |
| --- | --- |
| `no-store` | never stored (always honoured) |
| `max-age`, `s-maxage` (shared) | TTL (with `respectCacheControl`) |
| `no-cache` | stored, revalidated on every use |
| `must-revalidate` | no stale serving |
| `stale-while-revalidate=`, `stale-if-error=` | per-entry stale window |
| `ETag` / `Last-Modified` | conditional revalidation, 304 refreshes the entry |

## Tags and invalidation

```ts
await api.get("/users/1", { cache: { tags: ["user:1", "users"] } });
await api.patch("/users/1", body, { invalidateTags: ["users"] });
await api.invalidateTags("users");
await api.invalidateResource("/users/1");
```

A successful POST / PUT / PATCH / DELETE drops cached reads of the resource,
its `Location` and its parent collection. Both stores index resources and
tags, so invalidation never scans the whole keyspace.

## Next.js

```ts
createNextEngine({
  baseUrl,
  cache: { enabled: true, staleWhileRevalidate: true },
  waitUntil: after,                                    // keep background revalidation alive
  onInvalidateTags: (tags) => tags.forEach((t) => revalidateTag(t)),
});
```

## Copy protection

`copy: "clone"` (default) gives each caller its own copy; `"freeze"` returns
deep-frozen shared data (faster, read-only); `"none"` shares the object.

## Warming

```ts
await api.prefetch("/config");
await api.warm(["/config", "/menu"], 4);
```
