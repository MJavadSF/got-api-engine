// ── Engine-owned HTTP/2 session pool ─────────────────────────────
//
// Why not got's built-in pool: it is process-global (shared with every other
// got user), cannot be replaced per engine, and ties a session to the
// AbortSignal of the request that opened it — so one caller aborting tears
// down every request multiplexed on that session.
//
// This pool opens sessions without any request signal, negotiates the
// protocol per origin with ALPN (falling back to HTTP/1.1), applies the
// engine's TLS settings and SSRF-guarded DNS lookup, closes idle sessions and
// is fully released by `dispose()`. Requests use it through got's
// `h2session` option.

import http2, { type ClientHttp2Session } from "node:http2";
import net from "node:net";
import tls from "node:tls";
import type { TlsConfig } from "../types/security";

export interface Http2PoolOptions {
  tls: TlsConfig | undefined;
  rejectUnauthorized: boolean;
  /** dns.lookup-compatible function (e.g. the SSRF guard). */
  lookup?: tls.ConnectionOptions["lookup"];
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /** How long an origin that only speaks HTTP/1.1 is remembered. @default 300000 */
  alpnCacheMs?: number;
}

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new DOMException("Aborted", "AbortError");
}

export class Http2Pool {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private readonly pending = new Map<string, Promise<ClientHttp2Session | null>>();
  /** origin → epoch ms until which it is known to be HTTP/1.1 only. */
  private readonly http1Until = new Map<string, number>();
  private destroyed = false;

  constructor(private readonly opts: Http2PoolOptions) {}

  /** Number of live sessions (for tests / health). */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * A session for `url`'s origin, or null when HTTP/2 does not apply
   * (plain http, or the server negotiated HTTP/1.1). The caller's `signal`
   * only abandons the wait — it never cancels the shared connection setup.
   */
  async get(url: URL, signal?: AbortSignal): Promise<ClientHttp2Session | null> {
    if (url.protocol !== "https:" || this.destroyed) return null;
    const origin = url.origin;
    if ((this.http1Until.get(origin) ?? 0) > Date.now()) return null;

    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    let setup = this.pending.get(origin);
    if (!setup) {
      setup = this.connect(url).finally(() => this.pending.delete(origin));
      this.pending.set(origin, setup);
    }
    if (!signal) return setup;
    if (signal.aborted) throw abortError(signal);
    return new Promise<ClientHttp2Session | null>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      setup.then(
        (s) => {
          signal.removeEventListener("abort", onAbort);
          resolve(s);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  private connect(url: URL): Promise<ClientHttp2Session | null> {
    const { tls: t, rejectUnauthorized, lookup, connectTimeoutMs } = this.opts;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 443);

    return new Promise<ClientHttp2Session | null>((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        ...(net.isIP(host) ? {} : { servername: host }),
        ALPNProtocols: ["h2", "http/1.1"],
        rejectUnauthorized,
        minVersion: t?.minVersion ?? "TLSv1.2",
        ...(t?.ca ? { ca: t.ca } : {}),
        ...(t?.cert ? { cert: t.cert } : {}),
        ...(t?.key ? { key: t.key } : {}),
        ...(t?.passphrase ? { passphrase: t.passphrase } : {}),
        ...(lookup ? { lookup } : {}),
      });

      const timer = setTimeout(() => {
        socket.destroy(Object.assign(new Error(`Connect timeout after ${connectTimeoutMs}ms`), { code: "ETIMEDOUT" }));
      }, connectTimeoutMs);
      timer.unref?.();

      const fail = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      socket.once("error", fail);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        socket.off("error", fail);

        if (this.destroyed) {
          socket.destroy();
          return resolve(null);
        }
        if (socket.alpnProtocol !== "h2") {
          // Remember; the request goes over the regular HTTP/1.1 agent.
          this.http1Until.set(url.origin, Date.now() + (this.opts.alpnCacheMs ?? 300_000));
          socket.destroy();
          return resolve(null);
        }
        resolve(this.adopt(url.origin, socket));
      });
    });
  }

  private adopt(origin: string, socket: tls.TLSSocket): ClientHttp2Session {
    const session = http2.connect(origin, { createConnection: () => socket });
    const forget = (): void => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("error", forget); // streams report their own errors
    session.on("goaway", forget);
    session.on("close", forget);
    // Graceful: in-flight streams finish, then the session closes.
    session.setTimeout(this.opts.idleTimeoutMs, () => {
      forget();
      session.close();
    });
    this.sessions.set(origin, session);
    return session;
  }

  /** Close everything; pending setups are discarded as they complete. */
  destroy(): void {
    this.destroyed = true;
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    this.http1Until.clear();
  }
}
