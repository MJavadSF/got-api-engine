// =================================================================
// examples/nextjs-usage.ts
// Next.js App Router (13 → 16): Route Handlers + Server Actions
// =================================================================

import { createNextEngine } from "got-api-engine/next";
import { createNextAuthProvider } from "got-api-engine";
import { auth } from "@/lib/auth"; // Auth.js (next-auth v5) — your config
import { z } from "zod";

// ── 1. Create ONE engine instance (share it across your app) ─────
export const apiEngine = createNextEngine({
  baseUrl: process.env.API_URL!, // server-side env — no NEXT_PUBLIC_ needed
  serviceName: "MyApp",
  timeoutMs: 15_000,
  defaultHeaders: { "Accept-Language": "fa", "X-App-Version": "1.0.0" },

  // For Server Actions / RSC: read the Auth.js session on every call.
  // (Route Handlers forward the *caller's* Authorization header instead.)
  auth: createNextAuthProvider(() => auth()),

  // Correlate logs across services: incoming X-Request-Id is reused and
  // sent to the backend under this header.
  requestIdHeader: "X-Request-Id",

  cache: { enabled: true, ttlMs: 10_000, staleWhileRevalidate: true },
  circuitBreaker: { enabled: true },
});

// ── 2. Route Handler (app/api/users/route.ts) ────────────────────
// GET /api/users?page=2 → BACKEND/users?page=2   (query string is forwarded)
export async function GET(req: Request) {
  return apiEngine.handleRoute(req, { endpoint: "/users", method: "GET", auth: true });
}

// ── 3. Body validation ───────────────────────────────────────────
const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.email(),
});

export async function POST(req: Request) {
  return apiEngine.handleRoute(req, {
    endpoint: "/users",
    method: "POST",
    schema: CreateUserSchema, // 400 + field errors before touching the backend
  });
}

// ── 4. Dynamic segment (app/api/users/[id]/route.ts) ─────────────
// Next.js 15+: `params` is a Promise — await it.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiEngine.handleRoute(req, {
    endpoint: `/users/${encodeURIComponent(id)}`, // always encode user-controlled segments
    method: "PUT",
    schema: CreateUserSchema.partial(),
  });
}

// ── 5. Binary / file proxy (app/api/invoices/[id]/pdf/route.ts) ──
// PDFs and other binary payloads stream through with their content-type,
// and Content-Disposition is forwarded so the browser downloads it properly.
export async function GET_PDF(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiEngine.handleRoute(req, {
    endpoint: `/invoices/${encodeURIComponent(id)}/pdf`,
    responseType: "buffer",
    forwardResponseHeaders: ["content-disposition", "etag"],
  });
}

// ── 6. Server Actions ────────────────────────────────────────────
// Put these in a file that starts with "use server".
export async function fetchCurrentUser() {
  "use server";
  // The engine's Auth.js provider attaches the session token automatically.
  const result = await apiEngine.serverGet<{ id: string; name: string }>("/me");
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export async function createUserAction(data: { name: string; email: string }) {
  "use server";
  return apiEngine.serverPost("/users", data, { schema: CreateUserSchema });
}

// ── 7. Compact route files with buildRouteHandlers() ─────────────
const routes = apiEngine.buildRouteHandlers();
export const GET2 = (req: Request) => routes.GET(req, "/products");
export const POST2 = (req: Request) =>
  routes.POST(req, { endpoint: "/products", schema: z.looseObject({}) });

// ── 8. Security knobs for proxies ────────────────────────────────
// • By default a Route Handler only forwards the caller's own Authorization
//   header. It never falls back to the engine's service credentials, because
//   that would let anonymous visitors act with them. Opt in explicitly:
export const SERVICE_PUBLIC = (req: Request) =>
  apiEngine.handleRoute(req, { endpoint: "/catalog", useEngineAuth: true });
// • Backend 5xx bodies are not echoed to the browser (they may contain stack
//   traces); 4xx field errors are. Override with `exposeUpstreamDetails`.
