import type http from "node:http";
import type https from "node:https";
import type { AuthSource, RefreshAuthHook } from "./auth";
import type { CacheConfig } from "./cache";
import type { AuthMode, LogLevel, ResponseType } from "./http";
import type { Middleware } from "./middleware";
import type { EngineHooks, LoggerInterface } from "./observability";
import type { KeyCase } from "./request";
import type { CircuitBreakerConfig, ConcurrencyConfig, HedgeConfig, RateLimitConfig, RetryConfig } from "./resilience";
import type { ErrorCode } from "./result";
import type { SsrfConfig, TlsConfig } from "./security";

export type MessageCatalog = Partial<Record<ErrorCode, string>>;

export interface TimeoutConfig {
  lookup?: number;
  connect?: number;
  secureConnect?: number;
  socket?: number;
  send?: number;
  /** Time to first response byte. */
  response?: number;
}

export interface AgentOptions {
  /** @default 128 */
  maxSockets?: number;
  /** @default 32 */
  maxFreeSockets?: number;
  /** @default 1000 */
  keepAliveMsecs?: number;
  /**
   * Close idle sockets after this many ms — keep it below the upstream's
   * keep-alive timeout to avoid ECONNRESET on reuse. @default 4000
   */
  idleTimeoutMs?: number;
}

export interface EngineConfig {
  /**
   * Base URL of your backend. An array enables multi-upstream routing
   * (`upstreamStrategy`): relative endpoints go to a healthy upstream.
   */
  baseUrl: string | string[];
  /** @default "failover" */
  upstreamStrategy?: "failover" | "round-robin";
  /** How long an upstream stays marked unhealthy after a failure (ms). @default 10000 */
  upstreamCooldownMs?: number;

  /** @default true (credentials required) */
  defaultAuth?: AuthMode;
  auth?: AuthSource;
  refreshAuth?: RefreshAuthHook;
  /** Extra hosts (exact or `*.suffix`) allowed to receive engine credentials. */
  credentialHosts?: string[];

  /** Per-attempt timeout (ms). @default 10000 */
  timeoutMs?: number;
  /** Phase timeouts (ms). */
  timeouts?: TimeoutConfig;
  /** Deadline including retries + backoff (ms). `0` disables. @default 30000 */
  totalTimeoutMs?: number;
  /** @default 2 */
  retryLimit?: number;
  retry?: RetryConfig;
  /** @default "auto" */
  responseType?: ResponseType;
  /** Upper bound for buffered response bodies (bytes). @default 50 MiB */
  maxResponseBytes?: number;

  /** got 16 native HTTP/2. @default false */
  http2?: boolean;
  /** got's DNS cache. @default false */
  dnsCache?: boolean;
  /** Keep-alive agent tuning. */
  agentOptions?: AgentOptions;
  /** Custom agents (e.g. an `hpagent` proxy agent). Overrides `agentOptions`. */
  agent?: { http?: http.Agent; https?: https.Agent };
  /** CA / mTLS settings. */
  tls?: TlsConfig;
  /** Verify TLS certificates. @default true */
  rejectUnauthorized?: boolean;
  /** Gzip/deflate/brotli request bodies above `threshold` bytes. */
  compressRequest?: { threshold?: number; encoding?: "gzip" | "deflate" | "br" } | boolean;

  logger?: LoggerInterface;
  debug?: boolean;
  logLevel?: LogLevel;
  /** @default process.env.LOG_NAME ?? "got-api-engine" */
  serviceName?: string;
  defaultHeaders?: Record<string, string>;
  /** Send the correlation id upstream under this header. */
  requestIdHeader?: string;
  hooks?: EngineHooks;
  /** Koa-style middleware (see `engine.use()`). */
  middleware?: Middleware[];

  cache?: CacheConfig;
  circuitBreaker?: CircuitBreakerConfig;
  rateLimit?: RateLimitConfig;
  /** Bulkhead: cap concurrent upstream attempts. */
  concurrency?: ConcurrencyConfig;
  /** Hedge slow safe requests with a parallel attempt. */
  hedge?: HedgeConfig | boolean;
  /** Collapse identical in-flight GET/HEAD requests. @default true */
  dedupe?: boolean;
  /** Auto `Idempotency-Key` on POST/PUT/PATCH. @default false */
  idempotency?: boolean;

  ssrfProtection?: boolean | SsrfConfig;
  /**
   * Reject relative endpoints with `.`/`..` segments and any URL escaping the
   * base path. @default true
   */
  strictPath?: boolean;
  /** Extra keys (or patterns) redacted from logs. */
  redactKeys?: Array<string | RegExp>;
  /** @default true */
  metrics?: boolean;

  /** Language / overrides for engine-generated error messages. @default "en" */
  messages?: "en" | "fa" | MessageCatalog;
  /** Default key casing transforms. */
  transformKeys?: { request?: KeyCase; response?: KeyCase };
  /** Throw `ApiError` instead of returning error results. @default false */
  throwOnError?: boolean;

  /**
   * Keep background work (stale-while-revalidate) alive in serverless
   * runtimes, e.g. Next.js `after` or Vercel `waitUntil`.
   */
  waitUntil?: (task: Promise<unknown>) => void;
  /** Called with tags after `invalidateTags()` (e.g. Next.js `revalidateTag`). */
  onInvalidateTags?: (tags: string[]) => void | Promise<void>;
}
