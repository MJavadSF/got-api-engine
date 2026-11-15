# کش

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
    store: new RedisCacheStore(redis),       // پیش‌فرض: LRU در حافظه با سقف تعداد و حجم
    keySecret: process.env.CACHE_KEY_SECRET, // روی همه‌ی instanceهایی که store مشترک دارند یکسان باشد
  },
});
```

## چه چیزی کش می‌شود

GET و HEAD (قابل تنظیم؛ body درخواست‌های `QUERY` بخشی از کلید می‌شود) با وضعیت ۲۰۰، ۲۰۳ یا ۲۰۴.
ورودی‌ها برای **هر کاربر** (HMAC اطلاعات احراز هویت)، هر ترکیب هدر و هر responseType جدا هستند و
`Vary` هم رعایت می‌شود. در کلید کش هیچ‌وقت توکن یا query string خام ذخیره نمی‌شود.

## تازگی

| upstream بگوید | رفتار |
| --- | --- |
| `no-store` | هرگز ذخیره نمی‌شود |
| `max-age`، `s-maxage` | TTL (با `respectCacheControl`) |
| `no-cache` | ذخیره می‌شود اما هر بار اعتبارسنجی می‌شود |
| `must-revalidate` | پاسخ کهنه هرگز داده نمی‌شود |
| `ETag` / `Last-Modified` | اعتبارسنجی شرطی؛ ۳۰۴ ورودی را تازه می‌کند |

## Tag و باطل‌سازی

```ts
await api.get("/users/1", { cache: { tags: ["user:1", "users"] } });
await api.patch("/users/1", body, { invalidateTags: ["users"] });
await api.invalidateTags("users");
```

هر POST / PUT / PATCH / DELETE موفق، کش همان منبع، `Location` آن و مجموعه‌ی والدش را پاک می‌کند.
هر دو store منبع‌ها و tagها را ایندکس می‌کنند، پس باطل‌سازی هیچ‌وقت کل keyspace را اسکن نمی‌کند.

## Next.js

```ts
createNextEngine({
  baseUrl,
  cache: { enabled: true, staleWhileRevalidate: true },
  waitUntil: after,
  onInvalidateTags: (tags) => tags.forEach((t) => revalidateTag(t)),
});
```
