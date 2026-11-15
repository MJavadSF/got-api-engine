// =================================================================
// examples/v4-features.ts — what's new in v4
// =================================================================

import { type ApiResult, createEngine, defineEndpoint, hmacSign, isApiError, otel, path, unwrap } from "got-api-engine";
import { createNextEngine, createProxy, toFormState } from "got-api-engine/next";
import { RedisCacheStore, type RedisLike, RedisRateLimiter } from "got-api-engine/redis";
import { createMockEngine } from "got-api-engine/testing";
import { z } from "zod";

declare const redis: RedisLike; // e.g. new Redis(process.env.REDIS_URL) from ioredis
declare const tracer: Parameters<typeof otel>[0]["tracer"]; // trace.getTracer("app")

// ── 1. A production engine ───────────────────────────────────────
export const api = createEngine({
  baseUrl: ["https://api-a.example.com", "https://api-b.example.com"], // failover
  auth: () => process.env.API_TOKEN,
  messages: "fa", // Persian engine error messages
  transformKeys: { request: "snake", response: "camel" },
  retry: { limit: 2, budget: true }, // no retry storms
  circuitBreaker: { enabled: true }, // one breaker per host
  concurrency: { max: 64, adaptive: true }, // bulkhead (AIMD)
  hedge: { afterMs: "p95" }, // cut tail latency of GETs
  rateLimit: { enabled: true, limiter: new RedisRateLimiter(redis, { limit: 100 }), adaptive: true },
  cache: {
    enabled: true,
    store: new RedisCacheStore(redis),
    keySecret: process.env.CACHE_KEY_SECRET,
    staleWhileRevalidate: true,
  },
  middleware: [otel({ tracer }), hmacSign({ secret: process.env.SIGNING_SECRET ?? "" })],
});

// ── 2. Typed endpoints (path params inferred & encoded) ──────────
const User = z.object({ id: z.string(), fullName: z.string() });
export const getUser = api.endpoint(defineEndpoint({ path: "/users/:id", response: User }));

export async function showUser(id: string): Promise<string> {
  const r = await getUser({ path: { id }, cache: { tags: [`user:${id}`] } });
  if (isApiError(r, "TIMEOUT", "CIRCUIT_OPEN")) return "بعداً دوباره تلاش کنید";
  return unwrap(r).fullName; // r.data is typed from the schema
}

// TanStack Query: useQuery(getUser.queryOptions({ path: { id } }))

// ── 3. Safe paths, pagination, fallbacks ─────────────────────────
export async function listOrders(customerId: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const order of api.paginate(path`/customers/${customerId}/orders`, { strategy: "cursor" })) out.push(order);
  return out;
}

export const banners = (): Promise<ApiResult<string[]>> => api.get<string[]>("/banners", { fallback: [] });

// ── 4. Next.js BFF in one file: app/api/[...path]/route.ts ───────
const bff = createNextEngine({ baseUrl: "https://api.example.com", messages: "fa" });
export const { GET, POST, PUT, PATCH, DELETE } = createProxy(bff, {
  prefix: "/api",
  allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
  cookieAuth: { name: "access_token" }, // httpOnly cookie → Bearer
  csrf: true,
  forwardRequestHeaders: ["accept-language"],
});

// Server Action with useActionState:
export async function createUserAction(_prev: unknown, form: FormData) {
  "use server";
  return bff.serverForm("POST", "/users", form);
}
export { toFormState };

// ── 5. Observability ─────────────────────────────────────────────
// app/api/metrics/route.ts → export const GET = () => new Response(api.metricsText());
// app/api/health/route.ts  → export const GET = async () => Response.json(await api.health({ ping: "/health" }));

// ── 6. Tests without a server ────────────────────────────────────
export const testApi = createMockEngine({
  "GET /users/:id": ({ params }) => ({ body: { id: params.id, full_name: "Test" } }),
  "POST /users": { status: 201, body: { id: "1" } },
});
