# امنیت

| محافظت | پیش‌فرض |
| --- | --- |
| بررسی گواهی TLS در همه‌ی محیط‌ها؛ CA سفارشی و mTLS با `tls` | فعال |
| اطلاعات احراز هویت فقط به originهای مجاز و حذف آن در redirect | فعال |
| جلوگیری از path traversal (`strictPath`) | فعال |
| سقف حجم پاسخ (`maxResponseBytes`) | ۵۰ مگابایت |
| سقف حجم body ورودی در Next.js (`maxBodyBytes`) | ۱۰ مگابایت |
| HMAC اطلاعات احراز هویت و query در کلید کش | فعال |
| redact لاگ‌ها و hookها | فعال |
| پیام عمومی به مرورگر برای خطاهای زیرساختی و 5xx | فعال |
| ارسال `X-Forwarded-For` | غیرفعال |
| محافظت SSRF (`ssrfProtection`) | اختیاری |
| بررسی origin برای CSRF (`csrf`) | اختیاری |

## SSRF

برای هر engineی که URL را از کاربر می‌گیرد `ssrfProtection: true` را فعال کنید. محدوده‌های
خصوصی، loopback، link-local و رزروشده (IPv4 و IPv6، شامل IPv4-mapped، Teredo و NAT64) را
مسدود می‌کند، **آدرس resolve‌شده** را موقع اتصال بررسی می‌کند (در برابر DNS rebinding، حتی در
HTTP/2) و هر redirect را هم چک می‌کند.

## گزارش آسیب‌پذیری

[SECURITY.md](https://github.com/MJavadSF/got-api-engine/blob/main/SECURITY.md) را ببینید.
