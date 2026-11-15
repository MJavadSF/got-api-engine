// ── Runtime: every subsystem an engine instance owns ─────────────
//
// Built once from the config. The engine class stays a thin facade and the
// pipeline stages receive only what they need.

import { CredentialManager } from "../auth/credentials";
import { MemoryCacheStore } from "../cache/memory-store";
import { ResponseCache } from "../cache/response-cache";
import { createMessageResolver, type MessageResolver } from "../errors/messages";
import { HookRunner } from "../observability/hooks";
import { createConsoleLogger } from "../observability/logger";
import { MetricsCollector } from "../observability/metrics";
import { Executor } from "../pipeline/executor";
import { NetworkStage } from "../pipeline/network";
import { Transport } from "../pipeline/transport";
import { type ResolvedRetry, resolveRetry } from "../resilience/backoff";
import { Bulkhead } from "../resilience/bulkhead";
import { CircuitRegistry } from "../resilience/circuit-registry";
import { TokenBucket } from "../resilience/rate-limiter";
import { RetryBudget } from "../resilience/retry-budget";
import { Fingerprinter } from "../security/fingerprint";
import { createCredentialMatcher } from "../security/hosts";
import { buildKeyMatcher, buildRedactor, type Redactor, redactUrlWith, withRedaction } from "../security/redact";
import { resolveSsrfConfig } from "../security/ssrf";
import type { EngineConfig } from "../types/config";
import type { Middleware } from "../types/middleware";
import type { LoggerInterface } from "../types/observability";
import type { HedgeConfig, RateLimiterLike } from "../types/resilience";
import type { SsrfConfig } from "../types/security";
import { BackgroundTasks } from "./background";
import { CancellationRegistry } from "./cancellation";
import { type ResolvedCacheConfig, resolveBases, resolveCacheConfig } from "./config";
import { DEFAULTS } from "./constants";
import { UpstreamPool } from "./upstreams";

export interface Runtime {
  readonly config: EngineConfig;
  readonly serviceName: string;
  readonly log: LoggerInterface;
  readonly redact: Redactor;
  readonly logUrl: (url: string) => string;
  readonly messages: MessageResolver;
  readonly fingerprint: Fingerprinter;
  readonly pool: UpstreamPool;
  readonly credentials: CredentialManager;
  readonly circuits: CircuitRegistry | null;
  readonly limiter: RateLimiterLike | null;
  readonly bulkhead: Bulkhead | null;
  readonly metrics: MetricsCollector | null;
  readonly cache: ResponseCache | null;
  readonly cacheCfg: ResolvedCacheConfig | null;
  readonly ssrf: SsrfConfig | null;
  readonly retry: ResolvedRetry;
  readonly hedge: Required<HedgeConfig> | null;
  readonly transport: Transport;
  readonly hooks: HookRunner;
  readonly network: NetworkStage;
  readonly executor: Executor;
  readonly background: BackgroundTasks;
  /** Aborted by `dispose()`. */
  readonly lifecycle: AbortController;
  /** Live per-request cancellations, aborted by `dispose()`. */
  readonly cancellations: CancellationRegistry;
  readonly middleware: Middleware[];
  readonly allowCredentials: (url: URL) => boolean;
  readonly invalidateTags: (tags: string[]) => Promise<void>;
}

function resolveHedge(input: EngineConfig["hedge"]): Required<HedgeConfig> | null {
  if (!input) return null;
  const cfg = input === true ? {} : input;
  return { afterMs: cfg.afterMs ?? "p95", minDelayMs: cfg.minDelayMs ?? 50, max: Math.max(1, cfg.max ?? 1) };
}

export function createRuntime(config: EngineConfig): Runtime {
  const bases = resolveBases(config.baseUrl);
  const serviceName = config.serviceName ?? process.env["LOG_NAME"] ?? "got-api-engine";
  const debug = config.debug ?? false;

  const isSensitive = buildKeyMatcher(config.redactKeys);
  const redact = buildRedactor(config.redactKeys);
  const log = withRedaction(config.logger ?? createConsoleLogger(serviceName, debug, config.logLevel), redact);
  const logUrl = (url: string): string => redactUrlWith(url, isSensitive);
  const messages = createMessageResolver(config.messages);
  const rejectUnauthorized = config.rejectUnauthorized ?? true;
  if (!rejectUnauthorized) log.warn("TLS certificate verification is DISABLED (rejectUnauthorized: false).");

  const hooks = new HookRunner(config.hooks, log);
  const metrics = (config.metrics ?? true) ? new MetricsCollector() : null;
  const pool = new UpstreamPool(
    bases,
    config.upstreamStrategy ?? "failover",
    config.upstreamCooldownMs ?? DEFAULTS.upstreamCooldownMs,
  );
  const credentials = new CredentialManager(config.auth, config.refreshAuth, () => metrics?.inc("authRefreshes"));
  const ssrf = resolveSsrfConfig(config.ssrfProtection);

  const circuits = config.circuitBreaker?.enabled
    ? new CircuitRegistry(config.circuitBreaker, (key, t) => {
        void hooks.emit("onCircuitStateChange", { ...t, key, serviceName });
        log.warn(`Circuit ${key}: ${t.from} → ${t.to}`);
      })
    : null;

  const limiter = config.rateLimit?.enabled ? (config.rateLimit.limiter ?? new TokenBucket(config.rateLimit)) : null;
  const bulkhead = config.concurrency ? new Bulkhead(config.concurrency) : null;
  const budgetCfg = config.retry?.budget;
  const budget = budgetCfg ? new RetryBudget(budgetCfg === true ? {} : budgetCfg) : null;
  const retry = resolveRetry({ ...(config.retry ?? {}), limit: config.retry?.limit ?? config.retryLimit ?? DEFAULTS.retryLimit });
  const hedge = resolveHedge(config.hedge);

  const fingerprint = new Fingerprinter(config.cache?.keySecret);
  const cacheCfg = resolveCacheConfig(config.cache);
  const cache = cacheCfg
    ? new ResponseCache(
        cacheCfg,
        config.cache?.store ?? new MemoryCacheStore({ maxEntries: cacheCfg.maxEntries, maxSizeBytes: cacheCfg.maxSizeBytes }),
        fingerprint,
        log,
      )
    : null;

  const allowCredentials = createCredentialMatcher(pool.origins, config.credentialHosts);

  const agent = { ...DEFAULTS.agent, ...config.agentOptions };
  const transport = new Transport({ config, ssrf, rejectUnauthorized, timeouts: config.timeouts, agentOptions: agent });
  const background = new BackgroundTasks(config.waitUntil);
  const lifecycle = new AbortController();
  const cancellations = new CancellationRegistry();

  const invalidateTags = async (tags: string[]): Promise<void> => {
    await cache?.invalidateTags(tags);
    if (config.onInvalidateTags) {
      try {
        await config.onInvalidateTags(tags);
      } catch (err) {
        log.warn("onInvalidateTags threw", { err: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const network = new NetworkStage({
    transport,
    pool,
    credentials,
    circuits,
    limiter,
    adaptiveRateLimit: config.rateLimit?.adaptive ?? false,
    bulkhead,
    budget,
    hedge,
    metrics,
    hooks,
    messages,
    allowCredentials,
    logUrl,
  });
  const executor = new Executor({ network, cache, metrics, background, log, invalidateTags, cancellations });

  return {
    config,
    serviceName,
    log,
    redact,
    logUrl,
    messages,
    fingerprint,
    pool,
    credentials,
    circuits,
    limiter,
    bulkhead,
    metrics,
    cache,
    cacheCfg,
    ssrf,
    retry,
    hedge,
    transport,
    hooks,
    network,
    executor,
    background,
    lifecycle,
    cancellations,
    middleware: [...(config.middleware ?? [])],
    allowCredentials,
    invalidateTags,
  };
}
