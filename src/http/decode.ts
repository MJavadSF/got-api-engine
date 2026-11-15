// ── Response body decoding ───────────────────────────────────────

import type { ResponseType } from "../types/http";

export type ContentClass = "json" | "text" | "binary" | "unknown";
export type DecodedBody = { ok: true; value: unknown } | { ok: false; error: string };

const MAX_ERROR_TEXT = 500;
const BINARY_APP = /^application\/(octet-stream|pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|vnd\.rar|msword|wasm)$/;
const TEXT_APP = new Set([
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/x-ndjson",
  "application/graphql",
]);

export function classifyContentType(contentType: string | undefined): ContentClass {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!mime) return "unknown";
  if (mime === "application/json" || mime === "text/json" || mime.endsWith("+json")) return "json";
  if (mime.startsWith("text/") || TEXT_APP.has(mime) || mime.endsWith("+xml")) return "text";
  if (
    /^(image|audio|video|font)\//.test(mime) ||
    BINARY_APP.test(mime) ||
    mime.startsWith("application/vnd.openxmlformats") ||
    mime.startsWith("application/vnd.ms-")
  ) {
    return "binary";
  }
  return "unknown";
}

function decodeText(buf: Buffer, contentType: string | undefined): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "")?.[1];
  if (!charset || /^utf-?8$/i.test(charset)) return buf.toString("utf8");
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/**
 * Decode according to `mode` and Content-Type. `lenient` (error responses)
 * falls back to text so a malformed error body never masks the status.
 */
export function decodeBody(
  raw: Buffer,
  contentType: string | undefined,
  mode: Exclude<ResponseType, "stream">,
  lenient = false,
): DecodedBody {
  if (mode === "buffer") return { ok: true, value: raw };
  if (raw.length === 0) return { ok: true, value: "" };

  const text = decodeText(raw, contentType);
  const parseJson = (): DecodedBody => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (err) {
      return lenient ? { ok: true, value: text } : { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
    }
  };

  if (mode === "text") return { ok: true, value: text };
  if (mode === "json") return parseJson();

  switch (classifyContentType(contentType)) {
    case "json":
      return parseJson();
    case "text":
      return { ok: true, value: text };
    case "binary":
      return lenient ? { ok: true, value: text.slice(0, MAX_ERROR_TEXT) } : { ok: true, value: raw };
    default: {
      const head = text.trimStart()[0];
      if (head === "{" || head === "[") {
        const parsed = parseJson();
        return parsed.ok ? parsed : { ok: true, value: text };
      }
      return { ok: true, value: text };
    }
  }
}

/** got 16 returns Uint8Array bodies; normalise to Buffer without copying. */
export function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.alloc(0);
}

// ── Human-readable error message from common API error shapes ────
const DEFAULT_ERROR_MESSAGE = "An unexpected error occurred.";
const MESSAGE_KEYS = ["message", "error", "errors", "detail", "title", "msg", "error_description", "reason"];

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => extractText(v, depth + 1)).filter((v): v is string => v !== null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    for (const key of MESSAGE_KEYS) {
      const found = extractText((value as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function parseApiError(rawBody: unknown): string {
  if (rawBody === undefined || rawBody === null || rawBody === "" || Buffer.isBuffer(rawBody)) {
    return DEFAULT_ERROR_MESSAGE;
  }
  let body: unknown = rawBody;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        return trimmed.slice(0, MAX_ERROR_TEXT);
      }
    } else {
      return !trimmed || trimmed.startsWith("<") ? DEFAULT_ERROR_MESSAGE : trimmed.slice(0, MAX_ERROR_TEXT);
    }
  }
  if (typeof body !== "object" || body === null) return DEFAULT_ERROR_MESSAGE;
  return extractText(body)?.slice(0, MAX_ERROR_TEXT) ?? DEFAULT_ERROR_MESSAGE;
}
