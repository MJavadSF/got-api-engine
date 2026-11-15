// ── Catch-all BFF proxy with an allowlist ────────────────────────
//
//   // app/api/[...path]/route.ts
//   export const { GET, POST, PUT, PATCH, DELETE } = createProxy(api, {
//     prefix: "/api",
//     allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
//   });

import { globToRegExp } from "../../http/glob";
import type { HttpMethod } from "../../types/http";
import type { NextApiEngine } from "./engine";
import { jsonResponse } from "./outgoing";
import type { NextRouteHandlerOptions } from "./types";

export interface ProxyRule extends Omit<NextRouteHandlerOptions, "endpoint" | "method"> {
  /** Glob: `*` = one segment, `**` = any depth. */
  path: string;
  /** Allowed methods. @default all */
  methods?: HttpMethod[];
}

export interface ProxyOptions extends Omit<NextRouteHandlerOptions, "endpoint" | "method"> {
  /** Path prefix of the route in your app, stripped before matching. @default "/api" */
  prefix?: string;
  /** Prefix prepended to the upstream endpoint. @default "" */
  upstreamPrefix?: string;
  /** Allowed upstream paths. Anything else → 404. */
  allow: Array<string | ProxyRule>;
}

/** A Route ProxyHandler for one HTTP method. */
export type ProxyHandler = (req: Request) => Promise<Response>;

export { globToRegExp };

export function createProxy(engine: NextApiEngine, options: ProxyOptions): Record<HttpMethod, ProxyHandler> {
  const { prefix = "/api", upstreamPrefix = "", allow, ...defaults } = options;
  const rules = allow.map((r) => {
    const rule: ProxyRule = typeof r === "string" ? { path: r } : r;
    return { rule, re: globToRegExp(rule.path) };
  });
  const base = prefix.replace(/\/+$/, "");

  const handle =
    (method: HttpMethod): ProxyHandler =>
    async (req) => {
      const pathname = new URL(req.url).pathname;
      const requestId = req.headers.get("x-request-id") ?? "proxy";
      if (!(pathname === base || pathname.startsWith(`${base}/`))) return jsonResponse({ error: "Not found." }, 404, requestId);
      const path = pathname.slice(base.length) || "/";
      const match = rules.find(({ rule, re }) => re.test(path) && (!rule.methods || rule.methods.includes(method)));
      if (!match) return jsonResponse({ error: "Not found.", code: "NOT_ALLOWED" }, 404, requestId);
      const { path: _glob, methods: _methods, ...ruleOptions } = match.rule;
      return engine.handleRoute(req, { ...defaults, ...ruleOptions, endpoint: `${upstreamPrefix}${path}`, method });
    };

  return {
    GET: handle("GET"),
    HEAD: handle("HEAD"),
    OPTIONS: handle("OPTIONS"),
    POST: handle("POST"),
    PUT: handle("PUT"),
    PATCH: handle("PATCH"),
    DELETE: handle("DELETE"),
    QUERY: handle("QUERY"),
  };
}
