// ── Request body encoding ────────────────────────────────────────
//
// The engine serialises JSON itself (instead of handing objects to got) so
// that serialisation failures (bigint, cycles) surface as REQUEST_INVALID
// before any network work — never as a retried "network error".

import { Readable } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { BODY_METHODS } from "../core/constants";
import { deleteHeader, getHeader, setHeader, setHeaderIfAbsent } from "../http/headers";
import { validateSchema } from "../http/schema";
import { isPlainObject, transformKeys } from "../http/transform";
import type { HeaderMap, HttpMethod } from "../types/http";
import type { EncodedBody } from "../types/middleware";
import type { KeyCase } from "../types/request";
import type { Schema } from "../types/schema";

export type BodyOutcome =
  | { ok: true; body: EncodedBody; replayable: boolean }
  | { ok: false; code: "REQUEST_VALIDATION" | "REQUEST_INVALID"; message: string; details?: unknown };

export interface BodyInput {
  raw: unknown;
  method: HttpMethod;
  headers: HeaderMap;
  schema: Schema<unknown> | undefined;
  keyCase: KeyCase | undefined;
  compress: { threshold: number; encoding: "gzip" | "deflate" | "br" } | null;
}

const compressors = {
  gzip: promisify(zlib.gzip),
  deflate: promisify(zlib.deflate),
  br: promisify(zlib.brotliCompress),
} as const;

function isStream(raw: unknown): raw is AsyncIterable<unknown> | NodeJS.ReadableStream {
  return raw instanceof Readable || (typeof raw === "object" && raw !== null && Symbol.asyncIterator in raw);
}

function isJsonLike(raw: unknown): boolean {
  return Array.isArray(raw) || isPlainObject(raw) || typeof raw === "number" || typeof raw === "boolean" || raw === null;
}

export async function encodeBody(input: BodyInput): Promise<BodyOutcome> {
  const { raw, method, headers } = input;
  if (raw === undefined || !BODY_METHODS.has(method)) return { ok: true, body: { kind: "none" }, replayable: true };

  if (input.schema && !isJsonLike(raw)) {
    return {
      ok: false,
      code: "REQUEST_INVALID",
      message: "A request `schema` requires a JSON body (object, array or primitive).",
    };
  }

  if (typeof FormData !== "undefined" && raw instanceof FormData) {
    deleteHeader(headers, "content-type"); // got sets the multipart boundary
    return { ok: true, body: { kind: "form", data: raw }, replayable: true };
  }
  if (isStream(raw) && !(raw instanceof Uint8Array)) {
    return { ok: true, body: { kind: "stream", data: raw }, replayable: false };
  }

  let bytes: Buffer | string;
  if (typeof raw === "string") bytes = raw;
  else if (raw instanceof Uint8Array) bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else if (raw instanceof ArrayBuffer) bytes = Buffer.from(raw);
  else if (raw instanceof URLSearchParams) {
    setHeaderIfAbsent(headers, "Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    bytes = raw.toString();
  } else if (typeof Blob !== "undefined" && raw instanceof Blob) {
    if (raw.type) setHeaderIfAbsent(headers, "Content-Type", raw.type);
    bytes = Buffer.from(await raw.arrayBuffer());
  } else if (isJsonLike(raw)) {
    let payload: unknown = raw;
    if (input.schema) {
      const v = await validateSchema(input.schema, raw);
      if (!v.ok) return { ok: false, code: "REQUEST_VALIDATION", message: "Validation error.", details: v.details };
      payload = v.data;
    }
    if (input.keyCase) payload = transformKeys(payload, input.keyCase);
    try {
      bytes = JSON.stringify(payload);
    } catch (err) {
      return {
        ok: false,
        code: "REQUEST_INVALID",
        message: `Request body is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    setHeaderIfAbsent(headers, "Content-Type", "application/json");
  } else {
    return { ok: false, code: "REQUEST_INVALID", message: `Unsupported request body type: ${typeof raw}` };
  }

  return { ok: true, body: { kind: "bytes", data: await maybeCompress(bytes, headers, input.compress) }, replayable: true };
}

async function maybeCompress(bytes: Buffer | string, headers: HeaderMap, cfg: BodyInput["compress"]): Promise<Buffer | string> {
  if (!cfg || getHeader(headers, "content-encoding")) return bytes;
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
  if (size < cfg.threshold) return bytes;
  const compressed = await compressors[cfg.encoding](bytes);
  setHeader(headers, "Content-Encoding", cfg.encoding);
  return compressed;
}

/** SHA input for keying body-carrying safe requests (QUERY). */
export function bodyKeyMaterial(body: EncodedBody): string | Buffer | undefined {
  return body.kind === "bytes" ? body.data : undefined;
}
