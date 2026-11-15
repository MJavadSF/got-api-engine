---
layout: home
hero:
  name: got-api-engine
  text: موتور HTTP امن و تاب‌آور
  tagline: برای Node.js و Next.js — endpointهای تایپ‌شده، کش، retry، circuit breaker، تجمیع درخواست‌ها و پیش‌فرض‌های امن، روی got 16.
  actions:
    - theme: brand
      text: شروع کنید
      link: /fa/guide/getting-started
    - theme: alt
      text: مرجع API
      link: /api/
    - theme: alt
      text: English
      link: /
features:
  - title: نتیجه به‌جای exception
    details: هر فراخوانی یک ApiResult ساده و قابل‌سریال‌سازی برمی‌گرداند که از Server Action هم قابل بازگرداندن است. اگر exception می‌خواهید، throwOnError و requestData() و unwrap() هست.
  - title: تایپ‌شده از سر تا ته
    details: پارامترهای مسیر از "/users/:id" استنتاج می‌شوند، اعتبارسنجی با Standard Schema (Zod، Valibot، ArkType) و تولید کد TypeScript از OpenAPI.
  - title: ساخته‌شده برای ترافیک واقعی
    details: retry budget، circuit breaker جدا برای هر host، bulkhead، hedging، rate limit تطبیقی و failover بین چند upstream.
  - title: کشی که درست می‌ماند
    details: stale-while-revalidate، اعتبارسنجی با ETag، Vary، tag، باطل‌سازی بعد از تغییر داده و store مشترک Redis.
  - title: امن به‌صورت پیش‌فرض
    details: اطلاعات احراز هویت فقط به API خودتان می‌رود و در redirect به مقصد دیگر حذف می‌شود؛ محافظت SSRF و path traversal، سقف حجم و لاگ redact‌شده.
  - title: BFF کامل Next.js در یک فایل
    details: پروکسی Route Handler، allowlist کلی، احراز هویت با cookie و CSRF، استریم SSE و Server Action آماده‌ی useActionState — تست‌شده روی Next 14 و 15 و 16.
---
