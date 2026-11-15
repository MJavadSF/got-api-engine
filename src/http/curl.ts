// ── Reproduce a request as a cURL command (credentials redacted) ──

import type { EncodedBody } from "../types/middleware";

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface CurlInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: EncodedBody;
  /** Redact credential headers. @default true */
  redact?: boolean;
  isSensitiveHeader?: (name: string) => boolean;
}

const DEFAULT_SENSITIVE = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i;

export function toCurl(input: CurlInput): string {
  const sensitive = input.isSensitiveHeader ?? ((n: string) => DEFAULT_SENSITIVE.test(n));
  const parts = ["curl", "-X", input.method.toUpperCase(), quote(input.url)];
  for (const [k, v] of Object.entries(input.headers)) {
    const value = input.redact !== false && sensitive(k) ? "[REDACTED]" : v;
    parts.push("-H", quote(`${k}: ${value}`));
  }
  const body = input.body;
  if (body?.kind === "bytes") {
    const text = typeof body.data === "string" ? body.data : body.data.toString("utf8");
    parts.push("--data-raw", quote(text));
  } else if (body?.kind === "form") {
    parts.push("# multipart body omitted");
  } else if (body?.kind === "stream") {
    parts.push("# streamed body omitted");
  }
  return parts.join(" ");
}
