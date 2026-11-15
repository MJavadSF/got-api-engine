// ── Error codes (single source of truth) ─────────────────────────

/** Every error code the engine can produce. */
export const ERROR_CODES = [
  "HTTP_ERROR",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ABORTED",
  "PARSE_ERROR",
  "REQUEST_VALIDATION",
  "RESPONSE_VALIDATION",
  "REQUEST_INVALID",
  "INVALID_URL",
  "AUTH_REQUIRED",
  "AUTH_PROVIDER_ERROR",
  "CREDENTIALS_BLOCKED",
  "SSRF_BLOCKED",
  "CIRCUIT_OPEN",
  "RATE_LIMITED",
  "CONCURRENCY_LIMITED",
  "RESPONSE_TOO_LARGE",
  "ENGINE_DISPOSED",
  "INTERNAL_ERROR",
  "MOCK_NOT_FOUND",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}
