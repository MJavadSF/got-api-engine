# راه‌اندازی

## نصب

```bash
npm i got-api-engine
```

به **Node.js نسخه‌ی ۲۲.۱۲ یا بالاتر** نیاز دارد و روی runtime خود Node اجرا می‌شود (نه Edge).

| ورودی | محتوا |
| --- | --- |
| `got-api-engine` | موتور، endpointهای تایپ‌شده، auth providerها، پلاگین‌ها |
| `got-api-engine/next` | `createNextEngine`، `createProxy`، ابزارهای فرم |
| `got-api-engine/node` | `batchRequests`، `withRetry` |
| `got-api-engine/redis` | `RedisCacheStore`، `RedisRateLimiter` |
| `got-api-engine/testing` | `createMockEngine`، `recorder` |
| `got-api-engine/codegen` | `generateFromOpenApi` (و CLI به اسم `got-api-engine-codegen`) |

## اولین درخواست

```ts
import { createEngine } from "got-api-engine";

export const api = createEngine({
  baseUrl: "https://api.example.com",
  auth: () => process.env.API_TOKEN, // به‌صورت پیش‌فرض احراز هویت الزامی است
});

const r = await api.get<User[]>("/users", { params: { page: 2 } });
if (r.ok) console.log(r.data);
else console.error(r.code, r.status, r.error);
```

فراخوانی‌ها به‌صورت پیش‌فرض exception پرتاب نمی‌کنند و یک [`ApiResult`](./requests#نتیجه) برمی‌گردانند.
برای **هر upstream یک engine** بسازید و همان را همه‌جا استفاده کنید؛ connection pool، کش،
circuit breaker و metricها متعلق به همان engine هستند.

## پیش‌فرض‌ها

| تنظیم | پیش‌فرض |
| --- | --- |
| timeout هر تلاش | ۱۰ ثانیه |
| مهلت کل (با احتساب retry) | ۳۰ ثانیه |
| retry | ۲ بار (متدهای idempotent، خطای شبکه، 408/425/429/5xx) |
| تجمیع GET/HEADهای یکسانِ هم‌زمان | فعال |
| اطلاعات احراز هویت | الزامی، فقط به originهای `baseUrl` |
| سقف حجم پاسخ | ۵۰ مگابایت |
| بررسی گواهی TLS | فعال، در همه‌ی محیط‌ها |

بعدی: [درخواست و نتیجه](./requests).
