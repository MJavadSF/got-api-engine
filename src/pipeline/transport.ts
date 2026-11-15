// ── Transport: one upstream attempt over got ─────────────────────
//
// Adds what got does not do for us: a response-size ceiling, credential
// stripping on redirects to foreign origins, phase timings, progress
// callbacks and Web-stream responses.

import http from "node:http";
import type { ClientHttp2Session } from "node:http2";
import https from "node:https";
import { Readable } from "node:stream";
import got, { type Got, type OptionsInit } from "got";
import { Cancellation } from "../core/cancellation";
import { ResponseTooLargeError } from "../errors/classify";
import { toBuffer } from "../http/decode";
import { deleteHeader, flattenHeaders } from "../http/headers";
import { toTimings } from "../http/misc";
import { assertRedirectAllowed, buildGuardedLookup } from "../security/ssrf";
import type { AgentOptions, EngineConfig, TimeoutConfig } from "../types/config";
import type { HeaderMap, HttpMethod, Progress, Timings } from "../types/http";
import type { EncodedBody } from "../types/middleware";
import type { SsrfConfig } from "../types/security";
import { Http2Pool, type Http2PoolOptions } from "./http2-pool";

export interface AttemptRequest {
  url: string;
  method: HttpMethod;
  headers: HeaderMap;
  body: EncodedBody;
  timeoutMs: number;
  signal: AbortSignal;
  maxResponseBytes: number;
  stream: boolean;
  /** Header names that must not follow a redirect to `!allowCredentials(url)`. */
  credentialHeaders: readonly string[];
  allowCredentials: (url: URL) => boolean;
  onUploadProgress?: ((p: Progress) => void) | undefined;
  onDownloadProgress?: ((p: Progress) => void) | undefined;
}

export interface AttemptResponse {
  status: number;
  headers: HeaderMap;
  /** Buffer, or a Web stream when `stream: true`. */
  body: Buffer | ReadableStream<Uint8Array>;
  timings: Timings | undefined;
}

interface RedirectContext {
  credentialHeaders: readonly string[];
  allowCredentials: (url: URL) => boolean;
}

export interface TransportOptions {
  config: EngineConfig;
  ssrf: SsrfConfig | null;
  rejectUnauthorized: boolean;
  timeouts: TimeoutConfig | undefined;
  agentOptions: Required<AgentOptions>;
}

export class Transport {
  private readonly client: Got;
  private readonly agents: { http: http.Agent; https: https.Agent | null; owned: boolean };
  /** Engine-owned HTTP/2 sessions (see http2-pool.ts); null when http2 is off. */
  private readonly h2: Http2Pool | null;

  constructor(private readonly opts: TransportOptions) {
    const { config, ssrf, rejectUnauthorized } = opts;
    this.agents = this.createAgents();
    const guardedLookup = ssrf?.checkResolvedAddresses ? buildGuardedLookup(ssrf) : undefined;
    this.h2 =
      config.http2 && !config.agent?.https
        ? new Http2Pool({
            tls: config.tls,
            rejectUnauthorized,
            ...(guardedLookup ? { lookup: guardedLookup as unknown as NonNullable<Http2PoolOptions["lookup"]> } : {}),
            connectTimeoutMs: opts.timeouts?.connect ?? config.timeoutMs ?? 10_000,
            idleTimeoutMs: opts.agentOptions.idleTimeoutMs,
          })
        : null;

    const tls = config.tls;
    const gotOptions: OptionsInit = {
      agent: this.agents.https ? { http: this.agents.http, https: this.agents.https } : { http: this.agents.http },
      https: {
        rejectUnauthorized,
        ...(tls?.ca ? { certificateAuthority: tls.ca } : {}),
        ...(tls?.cert ? { certificate: tls.cert } : {}),
        ...(tls?.key ? { key: tls.key } : {}),
        ...(tls?.passphrase ? { passphrase: tls.passphrase } : {}),
        minVersion: tls?.minVersion ?? "TLSv1.2",
      },
      responseType: "buffer",
      retry: { limit: 0 }, // the engine owns retries
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 5,
      hooks: { beforeRedirect: [(options, response) => this.guardRedirect(options, response)] },
      // HTTP/2 goes through our own pool via `h2session`; got's global pool is never used.
      ...(config.dnsCache ? { dnsCache: true } : {}),
    };
    if (guardedLookup) {
      gotOptions.dnsLookup = guardedLookup as unknown as NonNullable<OptionsInit["dnsLookup"]>;
    }
    this.client = got.extend(gotOptions);
  }

  private createAgents(): { http: http.Agent; https: https.Agent | null; owned: boolean } {
    const { config, agentOptions, rejectUnauthorized } = this.opts;
    if (config.agent?.http || config.agent?.https) {
      return { http: config.agent.http ?? new http.Agent(), https: config.agent.https ?? null, owned: false };
    }
    const base = {
      keepAlive: true,
      keepAliveMsecs: agentOptions.keepAliveMsecs,
      maxSockets: agentOptions.maxSockets,
      maxFreeSockets: agentOptions.maxFreeSockets,
      timeout: agentOptions.idleTimeoutMs,
    };
    const tls = config.tls;
    return {
      http: new http.Agent(base),
      // Also used with `http2: true` for origins that negotiate HTTP/1.1.
      https: new https.Agent({
        ...base,
        rejectUnauthorized,
        minVersion: tls?.minVersion ?? "TLSv1.2",
        ...(tls?.ca ? { ca: tls.ca } : {}),
        ...(tls?.cert ? { cert: tls.cert } : {}),
        ...(tls?.key ? { key: tls.key } : {}),
        ...(tls?.passphrase ? { passphrase: tls.passphrase } : {}),
      }),
      owned: true,
    };
  }

  private guardRedirect(
    options: { url?: URL | string | undefined; headers: Record<string, unknown>; context: Record<string, unknown> },
    response: { requestUrl?: URL | undefined },
  ): void {
    const target = options.url ? new URL(options.url) : undefined;
    if (!target) return;
    if (this.opts.ssrf) assertRedirectAllowed(target, response.requestUrl, this.opts.ssrf);
    const ctx = options.context["gae"] as RedirectContext | undefined;
    if (ctx && !ctx.allowCredentials(target)) {
      for (const name of ctx.credentialHeaders) deleteHeader(options.headers as HeaderMap, name);
    }
  }

  /** Synchronous unless an HTTP/2 session has to be resolved (saves an await per request). */
  private gotOptions(req: AttemptRequest, signal: AbortSignal): OptionsInit | Promise<OptionsInit> {
    if (this.h2) return this.h2.get(new URL(req.url), signal).then((h2session) => this.buildOptions(req, signal, h2session));
    return this.buildOptions(req, signal, null);
  }

  private buildOptions(req: AttemptRequest, signal: AbortSignal, h2session: ClientHttp2Session | null): OptionsInit {
    const t = this.opts.timeouts;
    const body = req.body;
    return {
      ...(h2session ? { h2session } : {}),
      method: req.method,
      headers: req.headers,
      signal,
      timeout: { request: req.timeoutMs, ...t },
      context: { gae: { credentialHeaders: req.credentialHeaders, allowCredentials: req.allowCredentials } },
      ...(body.kind === "bytes" || body.kind === "form" ? { body: body.data } : {}),
      ...(body.kind === "stream" ? { body: body.data as Readable } : {}),
    };
  }

  /** Send one attempt. Throws transport errors (classified by the caller). */
  async send(req: AttemptRequest): Promise<AttemptResponse> {
    return req.stream ? this.sendStream(req) : this.sendBuffered(req);
  }

  private async sendBuffered(req: AttemptRequest): Promise<AttemptResponse> {
    // Per-attempt cancellation: the request signal, plus our own abort when the body is too large.
    const attempt = new Cancellation().follow(req.signal, "caller");
    const signal = attempt.signal;
    let tooLarge = false;
    const max = req.maxResponseBytes;

    const base = this.gotOptions(req, signal);
    const options = base instanceof Promise ? await base : base;
    const promise = this.client(req.url, { ...options, responseType: "buffer" });
    promise.on("response", (res: { headers: Record<string, unknown> }) => {
      const len = Number(res.headers["content-length"]);
      if (Number.isFinite(len) && len > max) {
        tooLarge = true;
        attempt.abort("local");
      }
    });
    promise.on("downloadProgress", (p: Progress) => {
      if (p.transferred > max && !tooLarge) {
        tooLarge = true;
        attempt.abort("local");
      }
      req.onDownloadProgress?.(p);
    });
    if (req.onUploadProgress) promise.on("uploadProgress", req.onUploadProgress);

    try {
      const res = await promise;
      if (tooLarge) throw new ResponseTooLargeError(max);
      return {
        status: res.statusCode,
        headers: flattenHeaders(res.headers as Record<string, string | string[] | undefined>),
        body: toBuffer(res.body),
        timings: toTimings(res.timings?.phases),
      };
    } catch (err) {
      if (tooLarge) throw new ResponseTooLargeError(max);
      throw err;
    } finally {
      attempt.release();
    }
  }

  private async sendStream(req: AttemptRequest): Promise<AttemptResponse> {
    const options = await this.gotOptions(req, req.signal);
    return new Promise((resolve, reject) => {
      const stream = this.client.stream(req.url, {
        ...options,
        isStream: true,
      } as never) as unknown as Readable & {
        on(
          event: "response",
          fn: (res: {
            statusCode: number;
            headers: Record<string, string | string[] | undefined>;
            timings?: { phases?: Record<string, number> };
          }) => void,
        ): unknown;
      };
      let settled = false;
      stream.once("error", (err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      if (req.onDownloadProgress) stream.on("downloadProgress", req.onDownloadProgress);
      if (req.onUploadProgress) stream.on("uploadProgress", req.onUploadProgress);
      stream.on("response", (res) => {
        settled = true;
        resolve({
          status: res.statusCode,
          headers: flattenHeaders(res.headers),
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          timings: toTimings(res.timings?.phases),
        });
      });
    });
  }

  destroy(): void {
    this.h2?.destroy();
    if (!this.agents.owned) return;
    this.agents.http.destroy();
    this.agents.https?.destroy();
  }
}

/** Read a Web stream into a Buffer, up to `max` bytes (for error bodies). */
export async function readStreamLimited(stream: ReadableStream<Uint8Array>, max = 64 * 1024): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
      if (size >= max) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, max);
}
