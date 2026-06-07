// =================================================================
// examples/nextjs-usage.ts
// Complete Next.js App Router example
// =================================================================

import { createNextEngine, createNextAuthProvider } from "got-api-engine/next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth"; // your next-auth config
import { z } from "zod";

// ── 1. Create ONE engine instance (share across your app) ─────────
export const apiEngine = createNextEngine({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  serviceName: "MyApp",
  debug: process.env.NODE_ENV !== "production",
  timeoutMs: 15_000,
  retryLimit: 2,
  defaultHeaders: {
    "Accept-Language": "en",
    "X-App-Version": "1.0.0",
  },
  // Auth is sourced from incoming request headers in Route Handlers,
  // but for Server Actions you supply the session:
  hooks: {
    onRequest: (ctx) => {
      console.log(`→ ${ctx.method} ${ctx.url}`);
    },
    onResponse: (ctx) => {
      console.log(`← ${ctx.status} in ${ctx.durationMs}ms`);
    },
  },
});

// ── 2. Route Handler (app/api/users/route.ts) ─────────────────────
// This proxies GET /api/users → YOUR_BACKEND/users
export async function GET(req: Request) {
  return apiEngine.handleRoute(req, {
    endpoint: "/users",
    method: "GET",
    auth: true, // requires Bearer token
  });
}

// ── 3. Route Handler with body validation (app/api/users/route.ts) ─
const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

export async function POST(req: Request) {
  return apiEngine.handleRoute(req, {
    endpoint: "/users",
    method: "POST",
    schema: CreateUserSchema,
  });
}

// ── 4. Route Handler — dynamic segment (app/api/users/[id]/route.ts)
export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
) {
  return apiEngine.handleRoute(req, {
    endpoint: `/users/${params.id}`,
    method: "PUT",
    schema: CreateUserSchema.partial(),
  });
}

// ── 5. Server Action (app/actions/user.ts) ────────────────────────
"use server";

export async function fetchCurrentUser() {
  const session = await getServerSession(authOptions);

  const result = await apiEngine.serverGet("/me", {
    session, // automatically extracts session.access_token
    auth: true,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data;
}

export async function createUserAction(data: { name: string; email: string }) {
  const session = await getServerSession(authOptions);

  return apiEngine.serverPost("/users", data, {
    session,
    schema: CreateUserSchema,
  });
}

// ── 6. Using buildRouteHandlers() for compact route files ─────────
// app/api/products/route.ts
const routes = apiEngine.buildRouteHandlers();

export const GET2 = (req: Request) => routes.GET(req, "/products");
export const POST2 = (req: Request) =>
  routes.POST(req, { endpoint: "/products", schema: z.any() });
