// ── Request-signing middleware: HMAC and AWS Signature V4 ────────
//
// Signatures are computed per upstream attempt (`ctx.onAttempt`), so every
// retry, failover to another upstream and hedged attempt is signed for its
// own URL and timestamp.

import { createHash, createHmac } from "node:crypto";
import { setHeader } from "../http/headers";
import type { EncodedBody, Middleware } from "../types/middleware";

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** Bytes to hash, or undefined for bodies that cannot be hashed (form, stream). */
function bodyBytes(body: EncodedBody): string | Buffer | undefined {
  return body.kind === "bytes" ? body.data : body.kind === "none" ? "" : undefined;
}

// ── Generic HMAC ─────────────────────────────────────────────────
export interface HmacSignOptions {
  secret: string | Buffer;
  /** @default "X-Signature" */
  header?: string;
  /** @default "X-Timestamp" (unix seconds) */
  timestampHeader?: string;
  /** Optional key id sent as `X-Key-Id`. */
  keyId?: string;
  /** @default `${ts}.${METHOD}.${path?query}.${sha256(body)}` */
  canonical?: (input: { timestamp: string; method: string; url: URL; bodyHash: string }) => string;
  /** @default "hex" */
  encoding?: "hex" | "base64";
  /** Clock override (tests). */
  now?: () => Date;
}

export function hmacSign(options: HmacSignOptions): Middleware {
  const header = options.header ?? "X-Signature";
  const tsHeader = options.timestampHeader ?? "X-Timestamp";
  return async (ctx, next) => {
    const body = bodyBytes(ctx.body);
    const bodyHash = body === undefined ? "UNSIGNED-PAYLOAD" : sha256Hex(body); // once per request
    ctx.onAttempt((attempt) => {
      const timestamp = String(Math.floor((options.now?.() ?? new Date()).getTime() / 1000));
      const url = new URL(attempt.url);
      const canonical =
        options.canonical?.({ timestamp, method: attempt.method, url, bodyHash }) ??
        `${timestamp}.${attempt.method}.${url.pathname}${url.search}.${bodyHash}`;
      setHeader(attempt.headers, tsHeader, timestamp);
      if (options.keyId) setHeader(attempt.headers, "X-Key-Id", options.keyId);
      setHeader(
        attempt.headers,
        header,
        createHmac("sha256", options.secret)
          .update(canonical)
          .digest(options.encoding ?? "hex"),
      );
    });
    return next();
  };
}

// ── AWS Signature Version 4 ─────────────────────────────────────
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface AwsSigV4Options {
  region: string;
  service: string;
  credentials: AwsCredentials | (() => AwsCredentials | Promise<AwsCredentials>);
  /** Add `x-amz-content-sha256` (required by S3). @default service === "s3" */
  signContentSha256?: boolean;
  /** Clock override (tests). */
  now?: () => Date;
}

/** RFC 3986 encoding as required by SigV4. */
const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalPath(pathname: string, service: string): string {
  const segments = pathname.split("/").map((seg) => rfc3986(decodeURIComponent(seg)));
  const once = segments.join("/") || "/";
  // Every service except S3 expects the path to be encoded twice.
  return service === "s3"
    ? once
    : once
        .split("/")
        .map((seg) => rfc3986(seg))
        .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export interface SigV4Input {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date: Date;
  signContentSha256?: boolean;
}

/** Returns the headers to add (Authorization, X-Amz-Date, …). Pure, for testability. */
export function signSigV4(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = input.body === undefined ? "UNSIGNED-PAYLOAD" : sha256Hex(input.body);
  const signSha = input.signContentSha256 ?? input.service === "s3";

  const added: Record<string, string> = { "X-Amz-Date": amzDate };
  if (signSha) added["X-Amz-Content-Sha256"] = payloadHash;
  if (input.credentials.sessionToken) added["X-Amz-Security-Token"] = input.credentials.sessionToken;

  const toSign: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries({ ...input.headers, ...added })) {
    const name = k.toLowerCase();
    if (name === "host" || name === "content-type" || name.startsWith("x-amz-")) {
      toSign[name] = v.trim().replace(/\s+/g, " ");
    }
  }
  const names = Object.keys(toSign).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]}\n`).join("");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname, input.service),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  added["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return added;
}

export function awsSigV4(options: AwsSigV4Options): Middleware {
  return async (ctx, next) => {
    ctx.onAttempt(async (attempt) => {
      // Resolved per attempt: rotating credentials (STS, IMDS) stay fresh across retries.
      const credentials = typeof options.credentials === "function" ? await options.credentials() : options.credentials;
      const added = signSigV4({
        method: attempt.method,
        url: attempt.url,
        headers: attempt.headers,
        body: bodyBytes(attempt.body),
        region: options.region,
        service: options.service,
        credentials,
        date: options.now?.() ?? new Date(),
        ...(options.signContentSha256 !== undefined ? { signContentSha256: options.signContentSha256 } : {}),
      });
      for (const [k, v] of Object.entries(added)) setHeader(attempt.headers, k, v);
    });
    return next();
  };
}
