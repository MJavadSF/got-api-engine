<div dir="rtl">

# got-api-engine

[English](README.md) · [مستندات کامل](https://mjavadsf.github.io/got-api-engine/fa/)

یک موتور HTTP ماژولار برای **Node.js** و **Next.js** (App Router، Route Handler، Server Action)
که روی [got 16](https://github.com/sindresorhus/got) ساخته شده است. با یک فراخوانی `request()`
نتیجه‌ی تایپ‌شده، retry با بودجه، circuit breaker جدا برای هر host، کش با tag، تجمیع درخواست‌های
یکسان، محافظت در برابر SSRF و نشت اطلاعات احراز هویت، metric و tracing می‌گیرید — با پیش‌فرض‌های امن.

</div>

```ts
import { createEngine, defineEndpoint } from "got-api-engine";
import { z } from "zod";

const api = createEngine({ baseUrl: "https://api.example.com", auth: () => process.env.TOKEN, messages: "fa" });

const getUser = api.endpoint(defineEndpoint({ path: "/users/:id", response: z.object({ id: z.string(), name: z.string() }) }));

const r = await getUser({ path: { id: "42" } });
if (r.ok) console.log(r.data.name);
else console.error(r.code, r.error); // پیام خطاهای engine به فارسی
```

<div dir="rtl">

## قابلیت‌ها

| حوزه | چه چیزی می‌گیرید |
| --- | --- |
| **نتیجه** | `ApiResult` ساده و قابل‌سریال‌سازی، یا در صورت تمایل `throwOnError` / `requestData()` / `unwrap()` |
| **تایپ** | endpointهای تایپ‌شده با پارامترهای استنتاج‌شده، Standard Schema (Zod، Valibot، ArkType)، تولید کد از OpenAPI |
| **تاب‌آوری** | retry با backoff و `Retry-After`، retry budget، circuit breaker برای هر host، rate limit تطبیقی، bulkhead، hedging، failover، fallback |
| **کش** | stale-while-revalidate، stale-if-error، ETag، `Cache-Control` و `Vary`، tag، باطل‌سازی بعد از تغییر، Redis |
| **امنیت** | SSRF (حتی DNS rebinding)، محدود کردن و حذف اطلاعات احراز هویت در redirect، جلوگیری از path traversal، سقف حجم، کلید کش HMAC‌شده، redact لاگ |
| **Next.js** | پروکسی Route Handler، BFF با allowlist، احراز هویت با cookie و CSRF، استریم SSE، Server Action آماده‌ی `useActionState` |
| **مشاهده‌پذیری** | metric (خروجی Prometheus)، تأخیر هر route، `health()`، زمان‌بندی مراحل، `toCurl()`، OpenTelemetry |
| **فارسی** | پیام خطاهای engine به فارسی با `messages: "fa"` |

## نصب

</div>

```bash
npm i got-api-engine
```

<div dir="rtl">

به **Node.js نسخه‌ی ۲۲.۱۲ یا بالاتر** نیاز دارد و روی runtime خود Node اجرا می‌شود (نه Edge).

## Next.js در یک فایل

</div>

```ts
// app/api/[...path]/route.ts
import { createNextEngine, createProxy } from "got-api-engine/next";

const api = createNextEngine({ baseUrl: process.env.API_URL!, messages: "fa" });

export const { GET, POST, PUT, PATCH, DELETE } = createProxy(api, {
  prefix: "/api",
  allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
  cookieAuth: { name: "access_token" },
  csrf: true,
});
```

<div dir="rtl">

روی Next.js ۱۴، ۱۵ و ۱۶ به‌صورت end-to-end در CI تست می‌شود.

## مهاجرت از v3

</div>

```bash
npx got-api-engine-codemod v4 src/ --dry
```

<div dir="rtl">

جزئیات در [راهنمای مهاجرت](https://mjavadsf.github.io/got-api-engine/fa/guide/migration) و
[CHANGELOG.md](CHANGELOG.md).

## مجوز

MIT © [MJavadSF](https://github.com/MJavadSF)

</div>
