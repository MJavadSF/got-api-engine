import got from 'got';
import https from 'https';
import { v4 } from 'uuid';
import 'jsonwebtoken';

/**
 * got-api-engine
 * A modular, framework-agnostic HTTP proxy engine built on got.
 * @author code-plate
 * @license MIT
 */

function generateRequestId() {
  return v4();
}
var DEFAULT_ERROR_MESSAGE = "An unexpected error occurred.";
function parseApiError(rawBody) {
  if (!rawBody) return DEFAULT_ERROR_MESSAGE;
  const body = typeof rawBody === "string" ? (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
  })() : rawBody;
  if (typeof body === "string") return body;
  if (typeof body !== "object" || body === null) return DEFAULT_ERROR_MESSAGE;
  const obj = body;
  const fromArray = (field) => {
    if (!Array.isArray(field)) return null;
    const titles = field.map((m) => typeof m === "object" && m !== null ? m.title : null).filter(Boolean);
    return titles.length ? titles.join(", ") : null;
  };
  return fromArray(obj["message"]) ?? fromArray(obj["error"]) ?? (typeof obj["error"] === "string" ? obj["error"] : null) ?? (typeof obj["message"] === "string" ? obj["message"] : null) ?? (typeof obj["detail"] === "string" ? obj["detail"] : null) ?? (typeof obj["msg"] === "string" ? obj["msg"] : null) ?? DEFAULT_ERROR_MESSAGE;
}
function buildUrl(endpoint, baseUrl) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const base = baseUrl.replace(/\/$/, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}
function appendParams(url, params) {
  const entries = Object.entries(params).filter(([, v]) => v !== void 0 && v !== null);
  if (!entries.length) return url;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}
async function resolveAuthHeader(config, overrideToken) {
  if (overrideToken) {
    return overrideToken.startsWith("Bearer ") ? overrideToken : `Bearer ${overrideToken}`;
  }
  const { auth } = config;
  if (!auth) return null;
  if (typeof auth === "string") {
    return auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;
  }
  if (typeof auth === "function") {
    const result = await auth();
    if (!result) return null;
    return result.startsWith("Bearer ") ? result : `Bearer ${result}`;
  }
  if (typeof auth === "object" && "getAuthHeader" in auth) {
    const result = await auth.getAuthHeader();
    if (!result) return null;
    return result.startsWith("Bearer ") ? result : `Bearer ${result}`;
  }
  return null;
}
function isAuthRequired(mode) {
  return mode === true || mode === "bearer";
}
function isAuthOptional(mode) {
  return mode === "optional";
}
function isAuthDisabled(mode) {
  return mode === false || mode === "none";
}
function mergeHeaders(...sources) {
  const result = {};
  for (const src of sources) {
    if (src) Object.assign(result, src);
  }
  return result;
}
function startTimer() {
  const start = Date.now();
  return () => Date.now() - start;
}

// src/utils/logger.ts
var ConsoleLogger = class _ConsoleLogger {
  constructor(serviceName, debugEnabled = false) {
    this.prefix = `[${serviceName}]`;
    this.debugEnabled = debugEnabled;
  }
  format(level, message, meta) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${ts} ${level.toUpperCase().padEnd(5)} ${this.prefix} ${message}${metaStr}`;
  }
  debug(message, meta) {
    if (this.debugEnabled) console.debug(this.format("debug", message, meta));
  }
  info(message, meta) {
    console.info(this.format("info", message, meta));
  }
  warn(message, meta) {
    console.warn(this.format("warn", message, meta));
  }
  error(message, meta) {
    console.error(this.format("error", message, meta));
  }
  child(childMeta) {
    const childLogger = new _ConsoleLogger(this.prefix.slice(1, -1), this.debugEnabled);
    const originalFormat = childLogger["format"].bind(childLogger);
    childLogger["format"] = (level, message, meta) => originalFormat(level, message, { ...childMeta, ...meta });
    return childLogger;
  }
};
function createConsoleLogger(serviceName, debugEnabled = false) {
  return new ConsoleLogger(serviceName, debugEnabled);
}

// src/core/engine.ts
var RETRYABLE_METHODS = ["GET", "PUT"];
var BODY_METHODS = ["POST", "PUT", "PATCH"];
var GotApiEngine = class _GotApiEngine {
  constructor(config) {
    const isDev = process.env.NODE_ENV !== "production";
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      timeoutMs: config.timeoutMs ?? 1e4,
      retryLimit: config.retryLimit ?? 2,
      debug: config.debug ?? false,
      serviceName: config.serviceName ?? "got-api-engine",
      defaultAuth: config.defaultAuth ?? true,
      rejectUnauthorized: config.rejectUnauthorized ?? !isDev,
      auth: config.auth,
      defaultHeaders: config.defaultHeaders,
      hooks: config.hooks,
      logger: config.logger
    };
    this.log = config.logger ?? createConsoleLogger(this.config.serviceName, this.config.debug);
    this.httpClient = got.extend({
      agent: {
        https: new https.Agent({
          keepAlive: true,
          rejectUnauthorized: this.config.rejectUnauthorized
        })
      },
      headers: {
        "Cache-Control": "no-store",
        ...this.config.defaultHeaders
      },
      responseType: "json",
      retry: {
        limit: this.config.retryLimit,
        methods: RETRYABLE_METHODS
      },
      timeout: { request: this.config.timeoutMs },
      throwHttpErrors: false
    });
  }
  // ── Public: make a request ────────────────────────────────────
  async request(options) {
    const {
      endpoint,
      method = "GET",
      body: customBody,
      schema,
      responseSchema,
      timeoutMs,
      retryLimit,
      headers: extraHeaders,
      params,
      authToken: overrideToken
    } = options;
    const authMode = options.auth ?? this.config.defaultAuth;
    const requestId = generateRequestId();
    const elapsed = startTimer();
    const log = this.log.child ? this.log.child({ requestId }) : this.log;
    log.debug(`\u2192 ${method} ${endpoint}`, { authMode });
    try {
      const headers = mergeHeaders(
        { "Cache-Control": "no-store" },
        this.config.defaultHeaders,
        extraHeaders
      );
      if (!isAuthDisabled(authMode)) {
        const authHeader = await resolveAuthHeader(
          { auth: this.config.auth },
          overrideToken
        );
        if (isAuthRequired(authMode) && !authHeader) {
          log.warn("Auth required but no token available");
          return {
            ok: false,
            error: "Authorization token is required.",
            status: 401
          };
        }
        if (authHeader && (isAuthRequired(authMode) || isAuthOptional(authMode))) {
          headers["Authorization"] = authHeader;
        }
      }
      let fullUrl = buildUrl(endpoint, this.config.baseUrl);
      if (params) fullUrl = appendParams(fullUrl, params);
      const requestOpts = {
        headers,
        method,
        retry: {
          limit: retryLimit ?? this.config.retryLimit,
          methods: RETRYABLE_METHODS
        },
        timeout: { request: timeoutMs ?? this.config.timeoutMs },
        throwHttpErrors: false
      };
      if (customBody !== void 0 && BODY_METHODS.includes(method)) {
        if (customBody instanceof FormData) {
          requestOpts.body = customBody;
        } else if (schema) {
          const parsed = schema.safeParse(customBody);
          if (!parsed.success) {
            log.warn("Request body validation failed", {
              errors: parsed.error.flatten()
            });
            return {
              ok: false,
              error: "Validation error.",
              status: 400,
              details: parsed.error.flatten()
            };
          }
          requestOpts.json = parsed.data;
          headers["Content-Type"] = "application/json";
        } else if (typeof customBody === "object") {
          requestOpts.json = customBody;
          headers["Content-Type"] = "application/json";
        } else {
          requestOpts.body = String(customBody);
        }
      }
      if (this.config.hooks?.onRequest) {
        const hooks = Array.isArray(this.config.hooks.onRequest) ? this.config.hooks.onRequest : [this.config.hooks.onRequest];
        for (const hook of hooks) {
          await hook({ url: fullUrl, method, headers, body: customBody });
        }
      }
      log.debug(`Calling: ${fullUrl}`);
      const response = await this.httpClient(fullUrl, { ...requestOpts, responseType: "json" });
      const durationMs = elapsed();
      if (this.config.hooks?.onResponse) {
        const hooks = Array.isArray(this.config.hooks.onResponse) ? this.config.hooks.onResponse : [this.config.hooks.onResponse];
        for (const hook of hooks) {
          await hook({
            url: fullUrl,
            method,
            status: response.statusCode,
            body: response.body,
            durationMs
          });
        }
      }
      if (response.statusCode >= 400) {
        const errorMessage = parseApiError(response.body);
        log.error(`Request failed`, {
          url: fullUrl,
          status: response.statusCode,
          durationMs
        });
        return {
          ok: false,
          error: errorMessage,
          status: response.statusCode
        };
      }
      let data = response.body;
      if (responseSchema) {
        const parsed = responseSchema.safeParse(response.body);
        if (!parsed.success) {
          log.warn("Response validation failed", {
            errors: parsed.error.flatten()
          });
          return {
            ok: false,
            error: "Response validation error.",
            status: 502,
            details: parsed.error.flatten()
          };
        }
        data = parsed.data;
      }
      log.info(`\u2713 ${method} ${endpoint} \u2192 ${response.statusCode} (${durationMs}ms)`);
      return {
        ok: true,
        data,
        status: response.statusCode,
        headers: response.headers
      };
    } catch (error) {
      const durationMs = elapsed();
      if (this.config.hooks?.onError) {
        const hooks = Array.isArray(this.config.hooks.onError) ? this.config.hooks.onError : [this.config.hooks.onError];
        for (const hook of hooks) {
          await hook({ url: endpoint, method, error, durationMs });
        }
      }
      if (error instanceof Error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
        log.warn("Request aborted by client", { durationMs });
        return { ok: false, error: "Request aborted.", status: 499 };
      }
      const message = error instanceof Error ? error.message : "An internal error occurred.";
      log.error(`Proxy error: ${message}`, {
        err: error instanceof Error ? { name: error.name, message: error.message, code: error.code } : void 0,
        durationMs
      });
      return { ok: false, error: message, status: 500 };
    }
  }
  // ── Convenience wrappers ─────────────────────────────────────
  get(endpoint, options) {
    return this.request({ ...options, endpoint, method: "GET" });
  }
  post(endpoint, body, options) {
    return this.request({ ...options, endpoint, method: "POST", body });
  }
  put(endpoint, body, options) {
    return this.request({ ...options, endpoint, method: "PUT", body });
  }
  patch(endpoint, body, options) {
    return this.request({ ...options, endpoint, method: "PATCH", body });
  }
  delete(endpoint, options) {
    return this.request({ ...options, endpoint, method: "DELETE" });
  }
  // ── Fork: create a child engine with overridden config ────────
  extend(overrides) {
    return new _GotApiEngine({
      baseUrl: overrides.baseUrl ?? this.config.baseUrl,
      timeoutMs: overrides.timeoutMs ?? this.config.timeoutMs,
      retryLimit: overrides.retryLimit ?? this.config.retryLimit,
      debug: overrides.debug ?? this.config.debug,
      serviceName: overrides.serviceName ?? this.config.serviceName,
      defaultAuth: overrides.defaultAuth ?? this.config.defaultAuth,
      rejectUnauthorized: overrides.rejectUnauthorized ?? this.config.rejectUnauthorized,
      auth: overrides.auth ?? this.config.auth,
      defaultHeaders: mergeHeaders(this.config.defaultHeaders, overrides.defaultHeaders),
      hooks: overrides.hooks ?? this.config.hooks,
      logger: overrides.logger ?? this.config.logger
    });
  }
};
function createEngine(config) {
  return new GotApiEngine(config);
}

// src/adapters/node.ts
async function batchRequests(engine, requests, options) {
  const { concurrency, failFast = false } = options ?? {};
  const results = {};
  if (!concurrency || concurrency >= requests.length) {
    const settled = await Promise.allSettled(
      requests.map((r) => engine.request(r.options).then((res) => ({ key: r.key, res })))
    );
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results[s.value.key] = s.value.res;
      } else if (failFast) {
        throw s.reason;
      }
    }
  } else {
    for (let i = 0; i < requests.length; i += concurrency) {
      const chunk = requests.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        chunk.map((r) => engine.request(r.options).then((res) => ({ key: r.key, res })))
      );
      for (const s of settled) {
        if (s.status === "fulfilled") {
          results[s.value.key] = s.value.res;
          if (failFast && !s.value.res.ok) {
            throw new Error(s.value.res.error ?? "Request failed");
          }
        } else if (failFast) {
          throw s.reason;
        }
      }
    }
  }
  return results;
}
async function withRetry(fn, options) {
  const { retries = 3, baseDelayMs = 300, shouldRetry } = options ?? {};
  const defaultShouldRetry = (r) => !r.ok && r.status >= 500;
  const check = shouldRetry ?? defaultShouldRetry;
  let lastResult;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fn();
    if (result.ok || !check(result)) return result;
    lastResult = result;
    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return lastResult;
}

export { GotApiEngine, batchRequests, createEngine, withRetry };
//# sourceMappingURL=node.mjs.map
//# sourceMappingURL=node.mjs.map