# مشاهده‌پذیری

```ts
api.getMetrics();                       // شمارنده‌ها، کدها، تأخیر، آمار هر route
api.metricsText();                      // خروجی Prometheus
await api.health({ ping: "/health" });  // { status: "ok" | "degraded" | "down", ... }
await api.toCurl({ endpoint: "/users", method: "POST", body }); // با اطلاعات احراز هویت redact‌شده
```

## معنای metricها

- `totalRequests`، `successCount` و `errorCount` تعداد فراخوانی‌های `request()` و نتیجه‌ی آن‌ها را
  می‌شمارند (شامل cache hit و درخواست‌های تجمیع‌شده).
- `upstreamRequests` و `upstreamErrors` تلاش‌های واقعی شبکه را می‌شمارند.

```ts
// app/api/metrics/route.ts
export const GET = () => new Response(api.metricsText(), { headers: { "content-type": "text/plain; version=0.0.4" } });
```

## Tracing

```ts
api.use(otel({ tracer: trace.getTracer("app"), inject: (h) => propagation.inject(context.active(), h) }));
```

## لاگ

هر loggerی با `debug / info / warn / error` قابل استفاده است (و در صورت وجود، `child` و
`isLevelEnabled` — pino و winston هر دو را دارند). همه‌ی metadataها redact می‌شوند و سطح‌های
غیرفعال هیچ هزینه‌ای ندارند.
