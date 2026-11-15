// ── Classification of errors thrown by the transport ────────────
//
// The key distinction: a *client-side* error (invalid header, bad option) is
// the caller's bug. It must never be retried nor counted against the circuit
// breaker, otherwise one malformed request could open the breaker for all.

import { findSsrfError } from "../security/ssrf";
import type { SafeError } from "../types/observability";
import type { ErrorCode } from "./codes";

export class ResponseTooLargeError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";
  constructor(readonly limit: number) {
    super(`Response body exceeds ${limit} bytes.`);
    this.name = "ResponseTooLargeError";
  }
}

/** A middleware attempt hook (e.g. a signer) threw: our fault, not upstream's. */
export class AttemptHookError extends Error {
  readonly code = "ATTEMPT_HOOK_FAILED";
  constructor(cause: unknown) {
    super(`Attempt hook failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "AttemptHookError";
  }
}

export type CircuitEffect = "failure" | "neutral";

export interface ErrorClassification {
  code: ErrorCode;
  status: number;
  /** Safe to retry (for an otherwise retryable method)? */
  retryable: boolean;
  /**
   * The request provably never reached the server (refused / DNS / connect
   * timeout), so it may be re-sent even for non-idempotent methods.
   */
  notSent: boolean;
  circuit: CircuitEffect;
  /** Signals upstream overload (shrinks adaptive concurrency). */
  overload: boolean;
  message: string;
}

const CLIENT_ERROR_CODES = new Set([
  "ERR_INVALID_CHAR",
  "ERR_INVALID_HTTP_TOKEN",
  "ERR_HTTP_INVALID_HEADER_VALUE",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_URL",
  "ERR_UNESCAPED_CHARACTERS",
  "ERR_INVALID_PROTOCOL",
  "ERR_HTTP_HEADERS_SENT",
  "ERR_UNSUPPORTED_PROTOCOL",
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/** Failures that happen before any request byte is written. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);
/** got timeout phases that end before the request is sent. */
const PRE_SEND_TIMEOUT_EVENTS = new Set(["lookup", "connect", "secureConnect"]);

function chain(error: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 6 && cur; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

export function isAbortError(error: unknown): boolean {
  return chain(error).some((e) => {
    if (!(e instanceof Error)) return false;
    const code = codeOf(e);
    return e.name === "AbortError" || code === "ABORT_ERR" || code === "ERR_ABORTED";
  });
}

export function findInChain<T>(error: unknown, guard: (e: unknown) => e is T): T | undefined {
  return chain(error).find(guard);
}

export function classifyTransportError(error: unknown): ErrorClassification {
  const errors = chain(error);
  const message = error instanceof Error ? error.message : "Request failed.";

  const ssrf = findSsrfError(error);
  if (ssrf) {
    return {
      code: "SSRF_BLOCKED",
      status: 403,
      retryable: false,
      notSent: false,
      circuit: "neutral",
      overload: false,
      message: ssrf.message,
    };
  }

  const hook = errors.find((e): e is AttemptHookError => e instanceof AttemptHookError);
  if (hook) {
    return {
      code: "INTERNAL_ERROR",
      status: 500,
      retryable: false,
      notSent: false,
      circuit: "neutral",
      overload: false,
      message: hook.message,
    };
  }

  const tooLarge = errors.find((e): e is ResponseTooLargeError => e instanceof ResponseTooLargeError);
  if (tooLarge) {
    return {
      code: "RESPONSE_TOO_LARGE",
      status: 502,
      retryable: false,
      notSent: false,
      circuit: "neutral",
      overload: false,
      message: tooLarge.message,
    };
  }

  if (errors.some((e) => CLIENT_ERROR_CODES.has(codeOf(e) ?? ""))) {
    return {
      code: "REQUEST_INVALID",
      status: 400,
      retryable: false,
      notSent: false,
      circuit: "neutral",
      overload: false,
      message,
    };
  }

  const timeout = errors.find((e) => TIMEOUT_CODES.has(codeOf(e) ?? "") || (e instanceof Error && e.name === "TimeoutError"));
  if (timeout) {
    const event = (timeout as { event?: unknown }).event;
    const notSent = typeof event === "string" && PRE_SEND_TIMEOUT_EVENTS.has(event);
    return { code: "TIMEOUT", status: 504, retryable: true, notSent, circuit: "failure", overload: true, message };
  }

  const notSent = errors.some((e) => NOT_SENT_CODES.has(codeOf(e) ?? ""));
  return { code: "NETWORK_ERROR", status: 502, retryable: true, notSent, circuit: "failure", overload: false, message };
}

/**
 * A view of an error that is safe to log or hand to hooks: got's errors carry
 * the full request options (including Authorization) and must not leak.
 */
export function toSafeError(error: unknown): SafeError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: codeOf(error) };
  }
  return { name: "Error", message: String(error) };
}
