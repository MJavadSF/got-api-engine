// ── Reading the incoming Request: body (bounded), cookies, CSRF ──

import { MiB } from "../../core/constants";
import { validateSchema } from "../../http/schema";
import type { Schema } from "../../types/schema";
import type { CookieAuthOptions, CsrfOptions } from "./types";

export type IncomingBody =
  | { ok: true; body: unknown; contentType?: string | undefined }
  | { ok: false; status: number; error: string; details?: unknown };

export const DEFAULT_MAX_BODY = 10 * MiB;

/** Read the request body without ever buffering more than `max` bytes. */
export async function readLimited(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Parse the incoming body. With a `schema`, only JSON is accepted — any other
 * content type would bypass validation, so it is rejected with 415.
 */
export async function readIncomingBody(
  req: Request,
  schema: Schema<unknown> | undefined,
  maxBytes: number,
): Promise<IncomingBody> {
  const contentType = req.headers.get("content-type") ?? "";
  const isJson = /[/+]json/i.test(contentType);
  if (schema && !isJson) {
    return { ok: false, status: 415, error: "Unsupported Media Type: application/json is required." };
  }

  const buf = await readLimited(req, maxBytes);
  if (buf === null) return { ok: false, status: 413, error: "Request body too large." };
  if (buf.length === 0) return { ok: true, body: undefined };

  if (/multipart\/form-data/i.test(contentType)) {
    try {
      const form = await new Response(new Uint8Array(buf), { headers: { "content-type": contentType } }).formData();
      return { ok: true, body: form };
    } catch {
      return { ok: false, status: 400, error: "Malformed multipart body." };
    }
  }

  if (isJson) {
    const text = buf.toString("utf8");
    if (text.trim() === "") return { ok: true, body: undefined };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: 400, error: "Invalid JSON body." };
    }
    if (!schema) return { ok: true, body: parsed };
    const v = await validateSchema(schema, parsed);
    return v.ok ? { ok: true, body: v.data } : { ok: false, status: 400, error: "Validation error.", details: v.details };
  }

  // Anything else (text, form-urlencoded, octet-stream…) is proxied verbatim.
  return { ok: true, body: buf, contentType: contentType || undefined };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

export function authorizationFromCookie(req: Request, opts: CookieAuthOptions): string | undefined {
  const token = readCookie(req, opts.name);
  return token ? `${opts.scheme ?? "Bearer"} ${token}` : undefined;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence for cookie-authenticated routes: unsafe methods must come
 * from the app's own origin (or an allow-listed one). Uses `Origin`, then
 * `Sec-Fetch-Site`, then `Referer`.
 */
export function passesCsrf(req: Request, method: string, opts: CsrfOptions | true): boolean {
  if (!UNSAFE.has(method)) return true;
  const allowedOrigins = new Set((opts === true ? undefined : opts.allowedOrigins) ?? []);
  // The host the browser actually talked to. `req.url` is unreliable for this:
  // behind `next start` or a proxy it carries an internal host (localhost:3000).
  // A cross-site page cannot set these headers on a form / fetch request.
  const appHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host)
    .split(",")[0]
    ?.trim()
    .toLowerCase();

  const isAllowed = (value: string): boolean => {
    try {
      const u = new URL(value);
      return u.host.toLowerCase() === appHost || allowedOrigins.has(u.origin);
    } catch {
      return false;
    }
  };

  const origin = req.headers.get("origin");
  if (origin) return origin !== "null" && isAllowed(origin);
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const referer = req.headers.get("referer");
  return referer ? isAllowed(referer) : false;
}
