# تاب‌آوری

```ts
createEngine({
  baseUrl: ["https://a.api.com", "https://b.api.com"], // failover (یا upstreamStrategy: "round-robin")
  totalTimeoutMs: 30_000,
  retry: { limit: 2, baseDelayMs: 200, budget: { ratio: 0.2 } },
  circuitBreaker: { enabled: true, failureThreshold: 5 },
  rateLimit: { enabled: true, requestsPerInterval: 20, adaptive: true },
  concurrency: { max: 64, maxQueue: 500, adaptive: { min: 8 } },
  hedge: { afterMs: "p95" },
});
```

## Retry

متدهای idempotent (و POST/PATCH دارای `Idempotency-Key`) در خطای شبکه و کدهای
408 / 425 / 429 / 5xx با backoff نمایی و jitter دوباره تلاش می‌شوند و `Retry-After` رعایت می‌شود.

**retry budget** تعداد retryها را نسبت به ترافیک اخیر محدود می‌کند تا در زمان قطعی، بار روی
سرویسی که مشکل دارد چند برابر نشود.

**خطای سمت کلاینت هیچ‌وقت retry نمی‌شود.** هدر نامعتبر یا body غیرقابل‌سریال‌سازی
(`bigint`، ارجاع حلقوی) با کد `REQUEST_INVALID` (۴۰۰) برمی‌گردد و روی circuit breaker هم اثری ندارد.

## Circuit breaker

به‌صورت پیش‌فرض **برای هر host یکی** است (`scope: "engine"` یا یک تابع دلخواه هم ممکن است).
با خطاهای پشت‌سرهم یا نرخ خطا در یک پنجره‌ی محدود به تعداد *و* زمان باز می‌شود. وقتی چند
upstream دارید، circuit باز بدون مصرف retry به upstream بعدی می‌رود.

## Rate limit

token bucket در حالت `"wait"` (صف FIFO) یا `"reject"`. با `adaptive: true` وقتی upstream بگوید
سهمیه تمام شده (`RateLimit`، `X-RateLimit-*`، یا `Retry-After` در 429/503) مکث می‌کند.
`RedisRateLimiter` سهمیه را بین چند instance مشترک می‌کند.

## Bulkhead

`concurrency.max` تعداد تلاش‌های هم‌زمان را محدود می‌کند و `maxQueue` اندازه‌ی صف را. با `adaptive`
در timeout و 429 و 503 سقف کم می‌شود (AIMD) و با موفقیت دوباره بالا می‌رود.

## Hedging

درخواست امنی که از p95 کندتر شود یک تلاش موازی می‌گیرد (اگر upstream دیگری باشد، روی آن). اولین
پاسخ برنده است و تلاش دیگر لغو می‌شود.

## Fallback

```ts
const banners = await api.get<string[]>("/banners", { fallback: [] });
```
