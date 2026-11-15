# Middleware و پلاگین‌ها

## Middleware

به سبک Koa: درخواست را تغییر دهید، کوتاهش کنید، یا نتیجه را ببینید.

```ts
api.use(async (ctx, next) => {
  ctx.headers["X-Tenant"] = currentTenant();
  const result = await next();
  if (!result.ok) audit(ctx.method, ctx.url, result.code);
  return result;
});
```

### هوک هر تلاش (per-attempt)

هر چیزی که به **مقصد نهایی یا زمان** وابسته است باید برای هر تلاش جدا اجرا شود: هر retry،
هر failover و هر hedge.

```ts
api.use(async (ctx, next) => {
  ctx.onAttempt((attempt) => {
    attempt.headers["X-Signature"] = sign(attempt.method, attempt.url);
  });
  return next();
});
```

هدرهایی که این هوک‌ها اضافه می‌کنند جزو اطلاعات احراز هویت حساب می‌شوند و در redirect به
originهای دیگر حذف می‌شوند.

## پلاگین‌های آماده

```ts
import { hmacSign, awsSigV4, otel } from "got-api-engine";

api.use(hmacSign({ secret: process.env.SIGNING_SECRET! }));
api.use(awsSigV4({ region: "eu-west-1", service: "execute-api", credentials }));
api.use(otel({ tracer: trace.getTracer("app"), inject: (h) => propagation.inject(context.active(), h) }));
```

هر دو امضاکننده برای **هر تلاش** امضا می‌کنند؛ پس retry زمان تازه می‌گیرد و failover به
upstream دیگر برای همان host امضا می‌شود.

## Hookها

`onRequest`، `onResponse`، `onError`، `onRetry` و `onCircuitStateChange` فقط ناظرند.
`onError` یک خطای پاک‌سازی‌شده (`{ name, message, code }`) می‌گیرد و هیچ‌وقت اطلاعات
احراز هویت به آن نمی‌رسد.
