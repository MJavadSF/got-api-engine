// =================================================================
// examples/vanilla-usage.ts
// Node.js / plain JavaScript usage (the engine runs on Node.js only)
// =================================================================

import {
  BatchRequestError,
  batchRequests,
  createApiKeyAuth,
  createBasicAuth,
  createDynamicAuth,
  createEngine,
  createOAuth2ClientCredentials,
  createStaticAuth,
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
interface User {
  id: number;
  name: string;
  email: string;
}
const user = await api.get<User>("/users/1");
if (user.ok) {
  console.log(user.data.name); // ✅ typed
}

// POST with body
const created = await api.post<User, { name: string; email: string }>("/users", { name: "Ali", email: "ali@example.com" });

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
  auth: createDynamicAuth(async () => process.env.ACCESS_TOKEN ?? null),
});

// ── 4. Service-to-service: OAuth 2.0 client credentials ──────────
// Token is cached, refreshed before expiry and after an upstream 401.
const serviceApi = createEngine({
  baseUrl: "https://api.example.com",
  auth: createOAuth2ClientCredentials({
    tokenUrl: "https://idp.example.com/oauth/token",
    clientId: process.env.CLIENT_ID ?? "",
    clientSecret: process.env.CLIENT_SECRET ?? "",
    scope: ["orders:read"],
  }),
});

// ── 4b. API key / Basic auth ─────────────────────────────────────
// The API key travels in its own header (default X-API-Key), not in Authorization.
const keyApi = createEngine({ baseUrl: "https://api.example.com", auth: createApiKeyAuth("k-123") });
const basicApi = createEngine({ baseUrl: "https://api.example.com", auth: createBasicAuth("user", "pass") });

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

// ── 8. Extend — fork with overrides (inherits the parent's FULL config) ──
const adminApi = api.extend({
  defaultHeaders: { "X-Admin": "true" },
  timeoutMs: 30_000,
});

const v2Api = api.extend({
  baseUrl: "https://api.example.com/v2",
});

// ── 9. Batch requests (parallel) ─────────────────────────────────
const [usersResult, postsResult] = await Promise.all([api.get("/users"), api.get("/posts")]);

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

// Fail fast: the first error aborts in-flight requests and skips the rest.
try {
  await batchRequests(
    api,
    [
      { key: "a", options: { endpoint: "/resource/a" } },
      { key: "b", options: { endpoint: "/resource/b" } },
    ],
    { concurrency: 2, failFast: true },
  );
} catch (err) {
  if (err instanceof BatchRequestError) console.error(`"${err.key}" failed:`, err.message);
}

// ── 10. Retry with custom backoff (outside the engine's own retry) ─
// Default policy retries only transient failures (network, 408/425/429, 5xx except 501/505).
const resilientResult = await withRetry(
  (attempt) => api.get("/flaky-endpoint", { retry: false, headers: { "X-Attempt": String(attempt) } }),
  {
    retries: 5,
    baseDelayMs: 500, // ~500ms, 1s, 2s, 4s, 8s (capped, with jitter)
    maxDelayMs: 10_000,
    shouldRetry: (r) => !r.ok && r.status >= 500, // `r` is fully typed — no `as any`
    onRetry: ({ attempt, delayMs }) => console.warn(`attempt ${attempt} failed, waiting ${delayMs}ms`),
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
  email: z.email(),
});

const validatedUser = await api.get<z.infer<typeof UserSchema>>("/users/1", {
  responseSchema: UserSchema,
});

if (validatedUser.ok) {
  // data is guaranteed to match UserSchema
  console.log(validatedUser.data.email);
}

// ── 13. Cleanup ───────────────────────────────────────────────────
await Promise.all(
  [api, authedApi, dynamicApi, serviceApi, keyApi, basicApi, trackedApi, adminApi, v2Api, apiWithPino].map((e) => e.dispose()),
);
void [users, created, result, filtered, usersResult, postsResult, batchResult, batch2, resilientResult];
