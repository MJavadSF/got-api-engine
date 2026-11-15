# Next.js

روی **Next.js ۱۴، ۱۵ و ۱۶** به‌صورت end-to-end در CI تست می‌شود (`next build` و `next start`،
هم با bundle شدن پکیج و هم به‌صورت external).

## راه‌اندازی

```ts
// lib/api.ts
import { after } from "next/server";
import { createNextEngine } from "got-api-engine/next";

export const api = createNextEngine({ baseUrl: process.env.API_URL!, messages: "fa", waitUntil: after });
```

```js
// next.config.mjs — Next 15 / 16
export default { serverExternalPackages: ["got-api-engine", "got"] };
// Next 14
export default { experimental: { serverComponentsExternalPackages: ["got-api-engine", "got"] } };
```

## پروکسی Route Handler

```ts
export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/users", forwardRequestHeaders: ["accept-language"] });
export const POST = (req: Request) => api.handleRoute(req, { endpoint: "/users", method: "POST", schema: NewUser });
```

وقتی `schema` تعریف شده، فقط JSON پذیرفته می‌شود و هر نوع دیگر **۴۱۵** می‌گیرد؛ پس اعتبارسنجی
دور زده نمی‌شود.

## BFF کامل در یک فایل

```ts
// app/api/[...path]/route.ts
export const { GET, POST, PUT, PATCH, DELETE } = createProxy(api, {
  prefix: "/api",
  allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
  cookieAuth: { name: "access_token" }, // cookie از نوع httpOnly → Authorization: Bearer
  csrf: true,                           // متدهای تغییردهنده فقط از origin خودتان
});
```

بررسی CSRF از hostی استفاده می‌کند که مرورگر واقعاً به آن وصل شده (`Host` یا
`X-Forwarded-Host`)، پس پشت `next start` و reverse proxy هم درست کار می‌کند.

## استریم (SSE، دانلود، خروجی LLM)

```ts
export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/events", responseType: "stream" });
```

## Server Action

```ts
"use server";
export async function createUser(_prev: unknown, form: FormData) {
  return api.serverForm("POST", "/users", form); // { ok, data } | { ok: false, message, fieldErrors }
}
// const [state, action] = useActionState(createUser, null);
```

خطاهای زیرساختی و 5xx فقط با یک پیام عمومی (و با `messages: "fa"`، فارسی) به مرورگر می‌رسند
و هیچ host، IP یا stack traceی لو نمی‌رود.
