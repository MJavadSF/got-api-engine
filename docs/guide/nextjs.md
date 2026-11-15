# Next.js

Tested end to end on **Next.js 14, 15 and 16** in CI (`next build` +
`next start`, with the package bundled and external).

## Setup

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

## Route Handler proxy

```ts
// app/api/users/route.ts
export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/users", forwardRequestHeaders: ["accept-language"] });
export const POST = (req: Request) => api.handleRoute(req, { endpoint: "/users", method: "POST", schema: NewUser });
```

With a `schema`, only JSON is accepted (other content types get **415**, so
validation cannot be bypassed). Responses carry `X-Request-Id` and `X-Cache`.

## Catch-all BFF

```ts
// app/api/[...path]/route.ts
export const { GET, POST, PUT, PATCH, DELETE } = createProxy(api, {
  prefix: "/api",
  allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
  cookieAuth: { name: "access_token" }, // httpOnly cookie → Authorization: Bearer
  csrf: true,                           // unsafe methods must come from your own origin
});
```

The CSRF check uses the host the browser actually talked to (`Host` /
`X-Forwarded-Host`), so it works behind `next start` and reverse proxies.

## Streaming (SSE, downloads, LLM output)

```ts
export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/events", responseType: "stream" });
```

## Server Actions

```ts
"use server";
export async function createUser(_prev: unknown, form: FormData) {
  return api.serverForm("POST", "/users", form); // { ok, data } | { ok: false, message, fieldErrors }
}
// const [state, action] = useActionState(createUser, null);

const me = await api.serverGet<User>("/me", { session: await auth() }); // Auth.js session token
```

## Options of `handleRoute`

`schema`, `maxBodyBytes`, `forwardQuery`, `forwardRequestHeaders`,
`forwardResponseHeaders`, `forwardClientIp` (off — enable only behind a
trusted proxy), `cookieAuth`, `csrf`, `useEngineAuth`, `responseType`,
`exposeUpstreamDetails`, `mapError`, `requestOptions`.

Infrastructure errors and upstream 5xx reach the browser with a generic
(localised) message only — no internal hosts, IPs or stack traces.
