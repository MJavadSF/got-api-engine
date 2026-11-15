# معماری

```
request(options)
  └─ prepare      URL (یک بار parse، بررسی traversal و SSRF) · احراز هویت · هدر · body · retry · لغو
  └─ middleware   middlewareهای کاربر و پلاگین‌ها
  └─ dedupe       تجمیع درخواست‌های یکسان با لغو مستقل هر caller
  └─ cache        تازه │ stale-while-revalidate │ ۳۰۴ │ stale-if-error │ tag
  └─ network      انتخاب upstream → circuit → rate limit → bulkhead → هوک هر تلاش → ارسال (hedge) → retry / تمدید 401
  └─ finalize     برای هر caller: تبدیل کلیدها → responseSchema → fallback → meta
```

## اصول طراحی

- داخل pipeline **نتیجه برمی‌گردد نه exception**؛ `throwOnError` فقط در لبه‌ی بیرونی اعمال می‌شود.
- **برای هر درخواست یک cancellation** (بدون `AbortSignal.any` در مسیر داغ) که دلیل لغو را هم ثبت می‌کند.
- **خطای سمت کلاینت هیچ‌وقت به circuit breaker یا حلقه‌ی retry نمی‌رسد.**
- **هر چیزی که engine می‌سازد با `dispose()` آزاد می‌شود**: سوکت‌ها، sessionهای HTTP/2، تایمرها و کارهای پس‌زمینه.
- خود runtime به TypeScript می‌ماند: engine منتظر شبکه است نه CPU، پس هسته‌ی native فقط باینری
  جدا برای هر پلتفرم اضافه می‌کرد. ابزارها جایی native هستند که سود دارد: TypeScript 7، Biome و tsdown (Rust).
