// =================================================================
// examples/vanilla-usage.ts
// Node.js / Plain JavaScript / React (browser-side) usage
// =================================================================

import {
  createEngine,
  createStaticAuth,
  createDynamicAuth,
  createBrowserStorageAuth,
  batchRequests,
  withRetry,
} from "got-api-engine";

// ── 1. Basic instance ─────────────────────────────────────────────
const api = createEngine({
  baseUrl: "https://api.example.com",
  debug: true,
  serviceName: "ExampleService",
  defaultHeaders: {
    "X-Client": "my-app/1.0",
  },
});

// Simple requests
const users = await api.get("/users");
if (users.ok) {
  console.log(users.data); // typed as unknown by default
}

// Typed response
interface User { id: number; name: string; email: string; }
const user = await api.get<User>("/users/1");
if (user.ok) {
  console.log(user.data.name); // ✅ typed
}

// POST with body
const created = await api.post<User, { name: string; email: string }>(
  "/users",
  { name: "Ali", email: "ali@example.com" },
);

// ── 2. Static auth token ──────────────────────────────────────────
const authedApi = createEngine({
  baseUrl: "https://api.example.com",
  auth: createStaticAuth("my-secret-token"),
  // or simply:
  // auth: "my-secret-token",
});

// ── 3. Dynamic auth (e.g. refresh token each call) ────────────────
const dynamicApi = createEngine({
  baseUrl: "https://api.example.com",
  auth: createDynamicAuth(async () => {
    const token = localStorage.getItem("access_token");
    if (!token) return null;

    // Optionally refresh if expired...
    return token;
  }),
});

// ── 4. Browser localStorage auth ─────────────────────────────────
const browserApi = createEngine({
  baseUrl: "https://api.example.com",
  auth: createBrowserStorageAuth("jwt_token", "localStorage"),
  debug: false,
});

// ── 5. Per-request auth override ─────────────────────────────────
const result = await api.get("/admin/stats", {
  authToken: "temporary-admin-token",
  auth: "bearer",
});

// ── 6. Query params ───────────────────────────────────────────────
const filtered = await api.get<User[]>("/users", {
  params: { role: "admin", page: 1, limit: 20 },
});

// ── 7. Hooks (logging, analytics, etc.) ──────────────────────────
const trackedApi = createEngine({
  baseUrl: "https://api.example.com",
  hooks: {
    onRequest: (ctx) => {
      console.log(`→ ${ctx.method} ${ctx.url}`);
    },
    onResponse: (ctx) => {
      if (ctx.durationMs > 2000) {
        console.warn(`Slow request: ${ctx.url} took ${ctx.durationMs}ms`);
      }
    },
    onError: (ctx) => {
      // Send to your error tracking (Sentry, etc.)
      console.error("Request error", ctx.error);
    },
  },
});

// ── 8. Extend — fork with overrides ─────────────────────────────
const adminApi = api.extend({
  defaultHeaders: { "X-Admin": "true" },
  timeoutMs: 30_000,
});

const v2Api = api.extend({
  baseUrl: "https://api.example.com/v2",
});

// ── 9. Batch requests (parallel) ─────────────────────────────────
const [usersResult, postsResult] = await Promise.all([
  api.get("/users"),
  api.get("/posts"),
]);

// Or with batchRequests for keyed results:
const batchResult = await batchRequests(api, [
  { key: "users", options: { endpoint: "/users", method: "GET" } },
  { key: "posts", options: { endpoint: "/posts", method: "GET" } },
  { key: "tags", options: { endpoint: "/tags", method: "GET" } },
]);

console.log(batchResult.users); // ApiResult
console.log(batchResult.posts); // ApiResult

// With controlled concurrency:
const batch2 = await batchRequests(
  api,
  [
    { key: "a", options: { endpoint: "/resource/a", method: "GET" } },
    { key: "b", options: { endpoint: "/resource/b", method: "GET" } },
    { key: "c", options: { endpoint: "/resource/c", method: "GET" } },
    { key: "d", options: { endpoint: "/resource/d", method: "GET" } },
  ],
  { concurrency: 2 }, // 2 at a time
);

// ── 10. Retry with custom backoff ────────────────────────────────
const resilientResult = await withRetry(
  () => api.get("/flaky-endpoint"),
  {
    retries: 5,
    baseDelayMs: 500, // 500ms, 1s, 2s, 4s, 8s
    shouldRetry: (r) => !r.ok && (r as any).status >= 500,
  },
);

// ── 11. Custom logger (bring your own) ───────────────────────────
import pino from "pino";

const pinoLogger = pino();

const apiWithPino = createEngine({
  baseUrl: "https://api.example.com",
  logger: {
    debug: (msg, meta) => pinoLogger.debug(meta ?? {}, msg),
    info: (msg, meta) => pinoLogger.info(meta ?? {}, msg),
    warn: (msg, meta) => pinoLogger.warn(meta ?? {}, msg),
    error: (msg, meta) => pinoLogger.error(meta ?? {}, msg),
    child: (childMeta) => {
      const child = pinoLogger.child(childMeta);
      return {
        debug: (msg, meta) => child.debug(meta ?? {}, msg),
        info: (msg, meta) => child.info(meta ?? {}, msg),
        warn: (msg, meta) => child.warn(meta ?? {}, msg),
        error: (msg, meta) => child.error(meta ?? {}, msg),
      };
    },
  },
});

// ── 12. Zod response validation ───────────────────────────────────
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

const validatedUser = await api.get<z.infer<typeof UserSchema>>("/users/1", {
  responseSchema: UserSchema,
});

if (validatedUser.ok) {
  // data is guaranteed to match UserSchema
  console.log(validatedUser.data.email);
}
