/**
 * Mock engine and record / replay middleware for tests.
 *
 * @packageDocumentation
 * @module got-api-engine/testing
 */
// ── got-api-engine/testing — mocks and record / replay ───────────

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GotApiEngine } from "../core/engine";
import { parseApiError } from "../http/decode";
import { globToRegExp } from "../http/glob";
import { sleep } from "../resilience/backoff";
import type { EngineConfig } from "../types/config";
import type { Middleware, MiddlewareContext } from "../types/middleware";
import type { ApiResult } from "../types/result";

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export type MockHandler = (req: {
  method: string;
  url: URL;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}) => MockResponse | Promise<MockResponse>;

/** `"GET /users/:id"`, `"* /health"`, `"POST /files/**"`. */
export type MockRoutes = Record<string, MockResponse | MockHandler>;

interface CompiledRoute {
  method: string;
  re: RegExp;
  names: string[];
  reply: MockResponse | MockHandler;
}

function compile(routes: MockRoutes): CompiledRoute[] {
  return Object.entries(routes).map(([spec, reply]) => {
    const [method = "*", pattern = "/"] = spec.trim().split(/\s+/, 2);
    const names: string[] = [];
    // Swap `:param` for a placeholder segment, glob the rest, then capture the placeholders.
    const PLACEHOLDER = "__param__";
    const globbed = pattern.replace(/:([A-Za-z_]\w*)/g, (_m, n: string) => {
      names.push(n);
      return PLACEHOLDER;
    });
    const source = globToRegExp(globbed).source.replaceAll(PLACEHOLDER, "([^/]+)");
    return { method: method.toUpperCase(), re: new RegExp(source), names, reply };
  });
}

function decodeMockBody(ctx: MiddlewareContext): unknown {
  if (ctx.body.kind !== "bytes") return ctx.body.kind === "form" ? ctx.body.data : undefined;
  const text = typeof ctx.body.data === "string" ? ctx.body.data : ctx.body.data.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Middleware answering from `routes` (no network). Unmatched → passthrough or 501. */
export function mockMiddleware(routes: MockRoutes, options: { passthrough?: boolean } = {}): Middleware {
  const compiled = compile(routes);
  return async (ctx, next) => {
    const url = new URL(ctx.url);
    for (const route of compiled) {
      if (route.method !== "*" && route.method !== ctx.method) continue;
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]));
      const res =
        typeof route.reply === "function"
          ? await route.reply({ method: ctx.method, url, params, headers: ctx.headers, body: decodeMockBody(ctx) })
          : route.reply;
      if (res.delayMs) await sleep(res.delayMs, ctx.signal);
      const status = res.status ?? 200;
      const headers = { "content-type": "application/json", ...res.headers };
      return status >= 400
        ? {
            ok: false,
            error: parseApiError(res.body),
            status,
            code: "HTTP_ERROR",
            details: res.body,
            headers,
            meta: { attempts: 0 },
          }
        : { ok: true, data: res.body ?? "", status, headers, meta: { attempts: 0 } };
    }
    if (options.passthrough) return next();
    return { ok: false, error: `No mock for ${ctx.method} ${url.pathname}`, status: 501, code: "MOCK_NOT_FOUND" };
  };
}

/** An engine whose requests are answered by `routes`. */
export function createMockEngine(
  routes: MockRoutes,
  config: Partial<EngineConfig> & { passthrough?: boolean } = {},
): GotApiEngine {
  const { passthrough, ...rest } = config;
  return new GotApiEngine({
    baseUrl: "http://mock.local",
    defaultAuth: false,
    logLevel: "silent",
    ...rest,
    middleware: [...(rest.middleware ?? []), mockMiddleware(routes, { passthrough: passthrough ?? false })],
  });
}

export interface RecorderOptions {
  /** Fixture directory. */
  dir: string;
  /** record: always hit network and save; replay: never hit network; auto: replay if present. @default "auto" */
  mode?: "record" | "replay" | "auto";
  /** Header names included in the fixture key. @default none */
  keyHeaders?: string[];
}

/** Record real responses to JSON fixtures and replay them in tests. */
export function recorder(options: RecorderOptions): Middleware {
  const mode = options.mode ?? "auto";
  if (!existsSync(options.dir)) mkdirSync(options.dir, { recursive: true });
  return async (ctx, next) => {
    const keyHeaders = (options.keyHeaders ?? []).map((h) => `${h}:${ctx.headers[h] ?? ""}`).join("|");
    const bodyKey = ctx.body.kind === "bytes" ? ctx.body.data.toString() : "";
    const id = createHash("sha256").update(`${ctx.method} ${ctx.url}|${keyHeaders}|${bodyKey}`).digest("hex").slice(0, 24);
    const file = join(options.dir, `${ctx.method.toLowerCase()}-${id}.json`);

    if (mode !== "record" && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { result: ApiResult<unknown> };
      return { ...saved.result, meta: { ...saved.result.meta, cached: true } };
    }
    if (mode === "replay") {
      return { ok: false, error: `No fixture for ${ctx.method} ${ctx.url}`, status: 501, code: "MOCK_NOT_FOUND" };
    }
    const result = await next();
    const storable = result.ok && Buffer.isBuffer(result.data) ? { ...result, data: result.data.toString("base64") } : result;
    writeFileSync(file, JSON.stringify({ request: { method: ctx.method, url: ctx.url }, result: storable }, null, 2));
    return result;
  };
}
