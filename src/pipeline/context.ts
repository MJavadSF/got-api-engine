// ── Per-request state shared by the pipeline stages ──────────────

import type { Cancellation } from "../core/cancellation";
import type { ResolvedRetry } from "../resilience/backoff";
import type { HeaderMap, HttpMethod, ResponseType } from "../types/http";
import type { AttemptHook, EncodedBody } from "../types/middleware";
import type { LoggerInterface } from "../types/observability";
import type { RequestOptions } from "../types/request";

export interface RequestContext {
  readonly options: RequestOptions<unknown, unknown>;
  readonly method: HttpMethod;
  readonly requestId: string;
  readonly log: LoggerInterface;
  readonly elapsed: () => number;
  /** Canonical, normalised absolute URL (primary upstream for relative endpoints). */
  readonly url: string;
  /** `url`, parsed (shared — never mutate). */
  readonly parsedUrl: URL;
  /** Relative endpoint → may be routed to any upstream. */
  readonly relative: boolean;
  /** Request headers, credentials included (mutable by middleware / refresh). */
  headers: HeaderMap;
  credHeaders: HeaderMap;
  /** Credentials came from the engine's `auth` (so a 401 may refresh). */
  usedConfigAuth: boolean;
  authRefreshed: boolean;
  readonly body: EncodedBody;
  /** False for streamed bodies: they cannot be re-sent. */
  readonly replayable: boolean;
  readonly responseType: ResponseType;
  readonly retry: ResolvedRetry;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** Aborted by the caller's signal, the overall deadline or engine shutdown (records which). */
  readonly cancel: Cancellation;
  /** `cancel.signal`. */
  readonly signal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
  /** Overall deadline in ms (0 = none); reused for shared dedupe flights. */
  readonly totalTimeoutMs: number;
  readonly authFp: string;
  readonly variantFp: string;
  readonly hedge: boolean;
  readonly metricsLabel: string;
  readonly state: Record<string, unknown>;
  /** Per-attempt hooks registered by middleware (`ctx.onAttempt`). */
  readonly attemptHooks: AttemptHook[];
}
