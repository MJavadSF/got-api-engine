// HTTP/2 session ownership: per-engine pool, ALPN fallback, TLS / SSRF settings, clean shutdown.
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type GotApiEngine } from "../src/index";
import { sleep } from "./server";

const CERT = process.env.TEST_CERT_DIR;
const tlsFiles = () => ({ key: readFileSync(`${CERT}/k.pem`), cert: readFileSync(`${CERT}/c.pem`) });
const ca = () => readFileSync(`${CERT}/c.pem`);

interface H2Server {
  base: string;
  port: number;
  sessions: Set<http2.ServerHttp2Session>;
  sessionsSeen: number;
  close(): Promise<void>;
}

async function h2Server(settings: http2.Settings = {}, delayMs = 0): Promise<H2Server> {
  const sessions = new Set<http2.ServerHttp2Session>();
  const state = { seen: 0 };
  const server = http2.createSecureServer({ ...tlsFiles(), settings });
  server.on("session", (s) => {
    state.seen++;
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  server.on("request", async (req, res) => {
    if (delayMs) await sleep(delayMs);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ httpVersion: req.httpVersion }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `https://localhost:${port}`,
    port,
    sessions,
    get sessionsSeen() {
      return state.seen;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sessions) s.destroy();
        server.close(() => r());
      }),
  };
}

const waitFor = async (cond: () => boolean, ms = 1000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
};

describe.skipIf(!CERT)("HTTP/2 session pool", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });
  const engine = (cfg: Parameters<typeof createEngine>[0]): GotApiEngine => {
    const e = createEngine({ defaultAuth: false, logLevel: "silent", ...cfg });
    cleanup.push(() => e.dispose());
    return e;
  };
  const server = async (settings?: http2.Settings, delayMs?: number): Promise<H2Server> => {
    const s = await h2Server(settings, delayMs);
    cleanup.unshift(() => s.close());
    return s;
  };

  it("dispose() closes the engine's HTTP/2 sessions", async () => {
    const s = await server();
    const api = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() } });
    expect(await api.get("/x")).toMatchObject({ ok: true, data: { httpVersion: "2.0" } });
    expect(s.sessions.size).toBe(1);
    await api.dispose();
    expect(await waitFor(() => s.sessions.size === 0)).toBe(true);
  });

  it("multiplexes one session per origin and isolates engines", async () => {
    const s = await server();
    const a = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() }, dedupe: false });
    const b = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() } });
    await Promise.all(Array.from({ length: 10 }, (_, i) => a.get(`/a${i}`)));
    await b.get("/b");
    expect(s.sessionsSeen).toBe(2);
    await a.dispose();
    expect(await waitFor(() => s.sessions.size === 1)).toBe(true);
    expect((await b.get("/still-works")).ok).toBe(true);
  });

  it("one caller aborting does not kill other requests multiplexed on the same session", async () => {
    const s = await server({}, 200);
    const api = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() }, dedupe: false, retryLimit: 0 });
    const ctl = new AbortController();
    const first = api.get("/first", { signal: ctl.signal }); // opens the session
    await sleep(50);
    const others = Array.from({ length: 3 }, (_, i) => api.get(`/other${i}`));
    await sleep(30);
    ctl.abort();
    const results = await Promise.all([first, ...others]);
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ABORTED", "ok", "ok", "ok"]);
    expect(s.sessionsSeen).toBe(1);
  });

  it("respects the server's maxConcurrentStreams", async () => {
    const s = await server({ maxConcurrentStreams: 2 }, 30);
    const api = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() }, dedupe: false });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => api.get(`/c${i}`)));
    expect(rs.every((r) => r.ok)).toBe(true);
  });

  it("falls back to HTTP/1.1 when the server does not offer h2 (ALPN)", async () => {
    const h1 = https.createServer(tlsFiles(), (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ httpVersion: req.httpVersion }));
    });
    await new Promise<void>((r) => h1.listen(0, "127.0.0.1", r));
    cleanup.unshift(() => new Promise<void>((r) => h1.close(() => r())));
    h1.keepAliveTimeout = 100;
    const api = engine({ baseUrl: `https://localhost:${(h1.address() as AddressInfo).port}`, http2: true, tls: { ca: ca() } });
    expect(await api.get("/x")).toMatchObject({ ok: true, data: { httpVersion: "1.1" } });
    expect(await api.get("/y")).toMatchObject({ ok: true, data: { httpVersion: "1.1" } });
  });

  it("reconnects after the server closes the session (GOAWAY)", async () => {
    const s = await server();
    const api = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() } });
    await api.get("/1");
    for (const session of s.sessions) session.close();
    await waitFor(() => s.sessions.size === 0);
    expect((await api.get("/2")).ok).toBe(true);
    expect(s.sessionsSeen).toBe(2);
  });

  it("closes idle sessions after agentOptions.idleTimeoutMs", async () => {
    const s = await server();
    const api = engine({ baseUrl: s.base, http2: true, tls: { ca: ca() }, agentOptions: { idleTimeoutMs: 80 } });
    await api.get("/x");
    expect(s.sessions.size).toBe(1);
    expect(await waitFor(() => s.sessions.size === 0, 1500)).toBe(true);
    expect((await api.get("/again")).ok).toBe(true);
  });

  it("verifies certificates (no ca → NETWORK_ERROR, nothing pooled)", async () => {
    const s = await server();
    const api = engine({ baseUrl: s.base, http2: true, retry: false as never, retryLimit: 0 });
    expect(await api.get("/x")).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
  });

  it("applies the SSRF-guarded DNS lookup to HTTP/2 connections", async () => {
    const s = await server();
    const original = dns.lookup;
    (dns as { lookup: unknown }).lookup = ((host: string, opts: unknown, cb: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as (e: null, a: unknown, f?: number) => void;
      if (host === "rebind.example") {
        const all = typeof opts === "object" && (opts as { all?: boolean }).all;
        return callback(null, all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
      }
      return (original as (...a: unknown[]) => void)(host, opts, cb);
    }) as typeof dns.lookup;
    try {
      const api = engine({ baseUrl: `https://rebind.example:${s.port}`, http2: true, ssrfProtection: true, retryLimit: 0 });
      expect(await api.get("/x")).toMatchObject({ ok: false, code: "SSRF_BLOCKED" });
      expect(s.sessionsSeen).toBe(0);
    } finally {
      (dns as { lookup: unknown }).lookup = original;
    }
  });
});
