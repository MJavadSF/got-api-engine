// ── Primitive HTTP-level types ───────────────────────────────────

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  /** HTTP QUERY — safe, idempotent request with a body (supported by got 16). */
  | "QUERY";

/**
 * - `true` / `"bearer"`: credentials required
 * - `"optional"`: send credentials when available
 * - `false` / `"none"`: never send credentials
 */
export type AuthMode = boolean | "optional" | "bearer" | "none";

/**
 * How the response body is decoded.
 * - `auto`   JSON → object, text → string, binary → Buffer (by Content-Type)
 * - `json`   strict JSON (parse failure → `PARSE_ERROR`)
 * - `text`   always a string
 * - `buffer` always a Node.js Buffer
 * - `stream` a Web `ReadableStream<Uint8Array>` (no caching / dedupe / schema)
 */
export type ResponseType = "auto" | "json" | "text" | "buffer" | "stream";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type ParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean | null | undefined>;

export type HeaderMap = Record<string, string>;

/** Per-phase timings of the final upstream attempt, in ms. */
export interface Timings {
  wait?: number | undefined;
  dns?: number | undefined;
  tcp?: number | undefined;
  tls?: number | undefined;
  request?: number | undefined;
  firstByte?: number | undefined;
  download?: number | undefined;
  total?: number | undefined;
}

export interface Progress {
  percent: number;
  transferred: number;
  total?: number | undefined;
}
