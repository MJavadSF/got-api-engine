# مهاجرت به v4

## Codemod

```bash
npx got-api-engine-codemod v4 src/            # تغییرات امن + گزارش مواردی که تصمیم شما را لازم دارد
npx got-api-engine-codemod v4 src/ --dry      # فقط گزارش
npx got-api-engine-codemod v4 src/ --preserve-behavior
```

- **همیشه:** `cache.cloneOnRead` به `copy` تبدیل می‌شود و روی auth منسوخ‌شده‌ی browser storage یک TODO گذاشته می‌شود.
- **با `--preserve-behavior`:** پیش‌فرض‌های v3 صریحاً ثابت می‌شوند (`totalTimeoutMs: 0`، `strictPath: false`،
  `circuitBreaker.scope: "engine"`، `forwardClientIp: true`) تا ارتقا هیچ رفتاری را عوض نکند.
- **فقط گزارش (با شماره‌ی خط):** بررسی `status === 500`، `body: null`، `successCount`/`errorCount`،
  routeهایی که به `X-Forwarded-For` وابسته‌اند و importهای مستقیم از داخل پکیج.

## تغییرات ناسازگار

| مورد | v3 | v4 |
| --- | --- | --- |
| Node.js | `>=22.0.0` | `>=22.12.0` |
| مهلت کل | ندارد | `totalTimeoutMs: 30000` (با `0` غیرفعال) |
| وضعیت خطای شبکه | ۵۰۰ | **۵۰۲** (`NETWORK_ERROR`) |
| خطای سمت کلاینت | `NETWORK_ERROR` و retry | `REQUEST_INVALID` (۴۰۰) |
| circuit breaker | یکی برای کل engine | یکی برای هر host |
| `forwardClientIp` در Next.js | `true` | `false` |
| خطای 5xx و زیرساختی در Next.js | پیام upstream | پیام عمومی و بومی‌شده |
| path traversal | مجاز | رد می‌شود |
| `body: null` و عدد | حذف / `String()` | به‌صورت JSON |
| peer dependencyها | `next`، `react`، `zod`، `winston` | فقط `winston` (اختیاری) |
