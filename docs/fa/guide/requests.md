# درخواست و نتیجه

## متدها

```ts
await api.get<User>("/users/1");
await api.post("/users", { name: "Sara" });            // شیء → JSON
await api.put("/files/1", buffer);                      // Buffer / string / Blob / FormData / stream بدون تغییر
await api.patch("/users/1", { name: "Ali" });
await api.delete("/users/1");
await api.query("/search", { q: "x" });                 // HTTP QUERY: امن و دارای body
```

## نتیجه

```ts
type ApiResult<T> =
  | { ok: true; data: T; status: number; headers?: Record<string, string>; meta?: ResultMeta }
  | { ok: false; error: string; status: number; code?: ErrorCode; details?: unknown; meta?: ResultMeta };
```

`meta` شامل `requestId`، `durationMs`، `attempts`، `cached`، `stale`، `deduped`، `hedged`،
`fallback`، `upstream` و زمان‌بندی مراحل (`timings`: ‏`dns`، `tcp`، `tls`، `firstByte`،
`download`، `total`) است. نتیجه یک شیء ساده است و می‌شود آن را از Server Action برگرداند.

### اگر exception می‌خواهید

```ts
import { unwrap, isApiError, mapResult } from "got-api-engine";

const user = await api.requestData<User>({ endpoint: "/users/1" }); // ApiError پرتاب می‌کند
const same = unwrap(await api.get<User>("/users/1"));

if (isApiError(r, "TIMEOUT", "CIRCUIT_OPEN")) showRetryLater();
const names = mapResult(r, (users) => users.map((u) => u.name));
```

پیام خطاهای خود engine با `messages: "fa"` فارسی می‌شود.

## گزینه‌ها

| گزینه | کاربرد |
| --- | --- |
| `params` | query string؛ آرایه به کلیدهای تکراری تبدیل می‌شود |
| `responseType` | `"auto"`، `"json"`، `"text"`، `"buffer"`، `"stream"` |
| `timeoutMs`، `totalTimeoutMs`، `retry`، `signal` | زمان‌بندی و لغو |
| `schema`، `responseSchema` | اعتبارسنجی درخواست و پاسخ |
| `cache`، `dedupe`، `invalidateTags` | کش |
| `fallback` | مقداری که در صورت شکست به‌عنوان پاسخ موفق برمی‌گردد |
| `transformKeys` | تبدیل `snake` ⇄ `camel` |
| `onUploadProgress`، `onDownloadProgress` | پیشرفت ارسال و دریافت |

## مسیر امن

endpointهای نسبی نمی‌توانند `.` یا `..` داشته باشند یا از مسیر پایه بیرون بزنند. برای ساختن مسیر
از ورودی کاربر از tag ‏`path` استفاده کنید:

```ts
import { path } from "got-api-engine";
await api.get(path`/users/${userId}/orders`); // "../admin" خطا می‌دهد، "a/b" → "a%2Fb"
```

## صفحه‌بندی و batch

```ts
for await (const order of api.paginate<Order>("/orders", { strategy: "cursor" })) { … }

const users = api.batcher<string, User>(async (ids) =>
  unwrap(await api.get<User[]>("/users", { params: { ids: ids.join(",") } })),
);
await Promise.all([users.load("1"), users.load("2")]); // فقط یک درخواست به upstream
```

## استریم

```ts
const r = await api.get<ReadableStream<Uint8Array>>("/events", { responseType: "stream" });
```
