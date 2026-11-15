# تست برنامه

```ts
import { createMockEngine, recorder } from "got-api-engine/testing";

const api = createMockEngine({
  "GET /users/:id": ({ params }) => ({ body: { id: params.id } }),
  "POST /users": { status: 201, body: { id: "1" } },
  "* /flaky": { status: 503 },
});
```

درخواست‌هایی که mock ندارند خطای `MOCK_NOT_FOUND` می‌گیرند (یا با `passthrough: true` به شبکه
می‌روند). mockها به‌صورت middleware اجرا می‌شوند، پس retry، کش و schema دقیقاً مثل محیط واقعی
رفتار می‌کنند.

## ضبط و پخش

```ts
createEngine({
  baseUrl,
  middleware: [recorder({ dir: "test/fixtures", mode: process.env.CI ? "replay" : "auto" })],
});
```
