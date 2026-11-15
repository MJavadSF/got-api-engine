---
layout: home
hero:
  name: got-api-engine
  text: A secure, resilient HTTP engine
  tagline: For Node.js and Next.js — typed endpoints, caching, retries, circuit breakers, request collapsing and safe defaults on top of got 16.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /api/
    - theme: alt
      text: فارسی
      link: /fa/
features:
  - title: Results, not exceptions
    details: Every call resolves to a plain, serialisable ApiResult — safe to return from Server Actions. Prefer exceptions? throwOnError, requestData() and unwrap().
  - title: Typed end to end
    details: Path params inferred from "/users/:id", Standard Schema validation (Zod, Valibot, ArkType) and an OpenAPI → TypeScript generator.
  - title: Built for production traffic
    details: Retry budgets, per-host circuit breakers, bulkheads, hedged requests, adaptive rate limiting, failover across upstreams.
  - title: Caching that stays correct
    details: Stale-while-revalidate, ETag revalidation, Vary, tags, mutation invalidation and a Redis store shared by instances.
  - title: Secure by default
    details: Credentials scoped to your API and stripped on foreign redirects, SSRF guard, path-traversal guard, body limits, redacted logs.
  - title: Next.js BFF in one file
    details: Route Handler proxy, catch-all allowlist, cookie auth + CSRF, SSE streaming and useActionState-ready Server Actions — tested on Next 14, 15 and 16.
---
