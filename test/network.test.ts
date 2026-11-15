// Behaviour of the network stage on its less-travelled paths:
// failover, aborts, conditional requests, refresh failures, hedging limits, transport details.
import { readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { useHarness } from "./harness";
import { json, sleep } from "./server";

const h = useHarness();
const CERT = process.env.TEST_CERT_DIR;

describe("retries and failover", () => {
  it("a POST that never reached the server (refused) fails over; one cut mid-flight is not resent", async () => {
    const good = await h.serve((_q, res) => json(res, 201, { ok: true }));
    const api = h.engine({ baseUrl: ["http://127.0.0.1:1", good.url], defaultAuth: false, retry: { limit: 1, baseDelayMs: 1 } });
    expect(await api.post("/orders", { a: 1 })).toMatchObject({ ok: true, status: 201, meta: { attempts: 2 } });

    const cut = await h.serve((req) => {
      req.socket.destroy(); // the request was received, then the connection dropped
    });
    const api2 = h.engine({ baseUrl: cut.url, defaultAuth: false, retry: { limit: 2, baseDelayMs: 1 } });
    expect(await api2.post("/orders", { a: 1 })).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    expect(cut.hits).toBe(1);
  });

  it("an open circuit on one upstream fails over without spending a retry", async () => {
    const bad = await h.serve((_q, res) => json(res, 503, {}));
    const good = await h.serve((_q, res) => json(res, 200, { who: "good" }));
    const api = h.engine({
      baseUrl: [bad.url, good.url],
      defaultAuth: false,
      retryLimit: 0,
      upstreamCooldownMs: 0,
      circuitBreaker: { enabled: true, failureThreshold: 1 },
    });
    await api.get("/x"); // trips the breaker of `bad`
    const r = await api.get<{ who: string }>("/y");
    expect(r).toMatchObject({ ok: true, data: { who: "good" }, meta: { attempts: 1 } });
    expect(bad.hits).toBe(1);
  });

  it("a 5xx marks the upstream unhealthy and the retry goes elsewhere", async () => {
    const bad = await h.serve((_q, res) => json(res, 502, {}));
    const good = await h.serve((_q, res) => json(res, 200, { who: "good" }));
    const api = h.engine({ baseUrl: [bad.url, good.url], defaultAuth: false, retry: { limit: 1, baseDelayMs: 1 } });
    expect(await api.get("/x")).toMatchObject({ ok: true, data: { who: "good" }, meta: { attempts: 2 } });
    expect((await api.health()).upstreams.map((u) => u.healthy)).toEqual([false, true]);
    expect((await api.get("/next")).meta?.attempts).toBe(1); // goes straight to the healthy one
    expect(bad.hits).toBe(1);
  });

  it("caller abort during the backoff wait ends the request promptly", async () => {
    const s = await h.serve((_q, res) => json(res, 503, {}));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, retry: { limit: 3, baseDelayMs: 5000, jitter: 0 } });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const t = Date.now();
    expect(await api.get("/x", { signal: ctl.signal })).toMatchObject({ ok: false, code: "ABORTED" });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("respectRetryAfter: false ignores long Retry-After; a final 429 reports retryAfterMs", async () => {
    let n = 0;
    const s = await h.serve((_q, res) => json(res, ++n === 1 ? 429 : 200, {}, { "retry-after": "30" }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, retry: { limit: 1, baseDelayMs: 1, respectRetryAfter: false } });
    const t = Date.now();
    expect((await api.get("/x")).ok).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);

    const limited = await h.serve((_q, res) => json(res, 429, { message: "slow down" }, { "retry-after": "7" }));
    const api2 = h.engine({ baseUrl: limited.url, defaultAuth: false, retry: false as never, retryLimit: 0 });
    expect(await api2.get("/x")).toMatchObject({ ok: false, status: 429, error: "slow down", meta: { retryAfterMs: 7000 } });
  });

  it("a 503 with Retry-After pauses the adaptive rate limiter", async () => {
    let n = 0;
    const s = await h.serve((_q, res) => json(res, ++n === 1 ? 503 : 200, {}, n === 1 ? { "retry-after": "1" } : {}));
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      retryLimit: 0,
      rateLimit: { enabled: true, requestsPerInterval: 100, adaptive: true },
    });
    await api.get("/a");
    const t = Date.now();
    await api.get("/b");
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });
});

describe("auth refresh failures", () => {
  it("a throwing refreshAuth or an empty refreshed credential returns the 401 (no loop)", async () => {
    const s = await h.serve((_q, res) => json(res, 401, { message: "expired" }));
    const throwing = h.engine({
      baseUrl: s.url,
      auth: "old",
      refreshAuth: () => {
        throw new Error("idp down");
      },
    });
    expect(await throwing.get("/x")).toMatchObject({ ok: false, status: 401, error: "expired" });

    let token: string | null = "old";
    const empty = h.engine({
      baseUrl: s.url,
      auth: () => token,
      refreshAuth: () => {
        token = null;
      },
    });
    expect(await empty.get("/x")).toMatchObject({ ok: false, status: 401 });
    expect(s.hits).toBe(2);
  });
});

describe("conditional requests and stale revalidation", () => {
  it("revalidates with If-Modified-Since when only Last-Modified is known", async () => {
    const lm = "Wed, 21 Oct 2015 07:28:00 GMT";
    const seen: Array<string | null> = [];
    const s = await h.serve((req, res) => {
      seen.push((req.headers["if-modified-since"] as string | undefined) ?? null);
      if (req.headers["if-modified-since"] === lm) return void res.writeHead(304).end();
      json(res, 200, { v: 1 }, { "last-modified": lm });
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 1 } });
    await api.get("/x");
    await sleep(5);
    expect(await api.get("/x")).toMatchObject({ ok: true, data: { v: 1 }, meta: { cached: true } });
    expect(seen).toEqual([null, lm]);
  });

  it("concurrent stale hits trigger one background revalidation, which may end in 304", async () => {
    let gets = 0;
    const s = await h.serve(async (req, res) => {
      gets++;
      await sleep(30);
      if (req.headers["if-none-match"]) return void res.writeHead(304, { etag: '"e"' }).end();
      json(res, 200, { v: 1 }, { etag: '"e"' });
    });
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      cache: { enabled: true, ttlMs: 1, staleWhileRevalidate: true },
    });
    await api.get("/x");
    await sleep(5);
    const rs = await Promise.all([api.get("/x"), api.get("/x"), api.get("/x")]);
    expect(rs.every((r) => r.meta?.stale)).toBe(true);
    await sleep(80);
    expect(gets).toBe(2);
    expect((await api.get("/x", { cache: { ttlMs: 60_000 } })).meta?.cached).toBe(true);
  });

  it("without a cache, a caller-sent If-None-Match yields a 304 success", async () => {
    const s = await h.serve((_q, res) => void res.writeHead(304, { etag: '"e"' }).end());
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    expect(await api.get("/x", { headers: { "If-None-Match": '"e"' } })).toMatchObject({ ok: true, status: 304, data: "" });
  });
});

describe("dedupe aborts", () => {
  it("when every caller aborts the upstream request is cancelled; later callers start afresh", async () => {
    let closed = 0;
    const s = await h.serve(async (req, res) => {
      req.on("close", () => {
        if (!res.writableEnded) closed++;
      });
      await sleep(200);
      if (!res.destroyed) json(res, 200, { ok: 1 });
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const a = new AbortController();
    const b = new AbortController();
    const pa = api.get("/x", { signal: a.signal });
    const pb = api.get("/x", { signal: b.signal });
    await sleep(30);
    a.abort();
    b.abort();
    expect((await Promise.all([pa, pb])).map((r) => r.ok || r.code)).toEqual(["ABORTED", "ABORTED"]);
    await sleep(30);
    expect(closed).toBe(1);
    expect((await api.get("/x")).ok).toBe(true);
    expect(s.hits).toBe(2);
  });
});

describe("hedging limits", () => {
  it("does not hedge without enough latency samples (p95) or when the primary is fast", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(60);
      json(res, 200, {});
    });
    const p95 = h.engine({ baseUrl: s.url, defaultAuth: false, hedge: true });
    expect((await p95.get("/x")).meta?.hedged).toBeUndefined();
    const fast = await h.serve((_q, res) => json(res, 200, {}));
    const api = h.engine({ baseUrl: fast.url, defaultAuth: false, hedge: { afterMs: 200 } });
    expect((await api.get("/x")).meta?.hedged).toBeUndefined();
    expect(api.getMetrics()?.hedgeCount).toBe(0);
  });

  it("skips the hedge when the bulkhead, rate limiter or retry budget has no room", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(80);
      json(res, 200, {});
    });
    const cases = [
      { concurrency: { max: 1 } },
      { rateLimit: { enabled: true, requestsPerInterval: 1, intervalMs: 60_000 } },
      { retry: { budget: { ratio: 0, minPerSec: 0 } } },
    ];
    for (const extra of cases) {
      const api = h.engine({ baseUrl: s.url, defaultAuth: false, hedge: { afterMs: 10 }, ...extra });
      expect((await api.get("/x")).ok).toBe(true);
      expect(api.getMetrics()?.hedgeCount).toBe(0);
    }
  });

  it("keeps the primary when it answers first after the hedge started", async () => {
    let n = 0;
    const s = await h.serve(async (_q, res) => {
      const me = ++n;
      await sleep(me === 1 ? 40 : 300);
      json(res, 200, { me });
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, hedge: { afterMs: 10, minDelayMs: 0 } });
    const r = await api.get<{ me: number }>("/x");
    expect(r).toMatchObject({ ok: true, data: { me: 1 } });
    expect(r.meta?.hedged).toBeUndefined();
    expect(api.getMetrics()?.hedgeCount).toBe(1);
  });

  it("an abort while queued in the bulkhead ends the request", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(200);
      json(res, 200, {});
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, dedupe: false, concurrency: { max: 1 } });
    const first = api.get("/a");
    const ctl = new AbortController();
    const queued = api.get("/b", { signal: ctl.signal });
    await sleep(20);
    ctl.abort();
    expect(await queued).toMatchObject({ ok: false, code: "ABORTED" });
    expect((await first).ok).toBe(true);
  });
});

describe("transport details", () => {
  it("streams: error statuses are decoded; upload streams are sent once; progress is reported", async () => {
    const s = await h.serve((req, res, ctx) => {
      if (req.url === "/err") return json(res, 404, { message: "nope" });
      if (req.url === "/flaky") return json(res, 503, {});
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`got ${ctx.body.length} bytes`);
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    expect(await api.get("/err", { responseType: "stream" })).toMatchObject({
      ok: false,
      status: 404,
      error: "nope",
      details: { message: "nope" },
    });

    const up: number[] = [];
    const down: number[] = [];
    const r = await api.put<ReadableStream<Uint8Array>>("/up", Readable.from([Buffer.alloc(3000, 1)]), {
      responseType: "stream",
      onUploadProgress: (p) => up.push(p.transferred),
      onDownloadProgress: (p) => down.push(p.transferred),
    });
    if (!r.ok) throw new Error("expected ok");
    expect(await new Response(r.data).text()).toBe("got 3000 bytes");
    expect(up.at(-1)).toBe(3000);
    expect(down.length).toBeGreaterThan(0);

    const before = s.hits;
    expect(await api.put("/flaky", Readable.from(["x"]), { retry: { limit: 3, baseDelayMs: 1 } })).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(s.hits - before).toBe(1); // streamed bodies are never replayed
  });

  it("stream requests that fail before a response surface NETWORK_ERROR", async () => {
    const api = h.engine({ baseUrl: "http://127.0.0.1:1", defaultAuth: false, retryLimit: 0 });
    expect(await api.get("/x", { responseType: "stream" })).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
  });

  it("uses custom agents (e.g. a proxy agent) and does not destroy them on dispose", async () => {
    const s = await h.serve((_q, res) => json(res, 200, {}));
    let created = 0;
    class CountingAgent extends http.Agent {
      override createConnection(...args: Parameters<http.Agent["createConnection"]>) {
        created++;
        return super.createConnection(...args);
      }
    }
    const agent = new CountingAgent({ keepAlive: true });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, agent: { http: agent } });
    expect((await api.get("/x")).ok).toBe(true);
    expect(created).toBe(1);
    await api.dispose();
    // Still usable: the engine must not destroy agents it does not own.
    const status = await new Promise<number | undefined>((resolve) =>
      http.get(`${s.url}/raw`, { agent }, (res) => resolve(res.statusCode)).end(),
    );
    expect(status).toBe(200);
    agent.destroy();
  });
});

describe.skipIf(!CERT)("TLS details", () => {
  const files = () => ({ key: readFileSync(`${CERT}/k.pem`), cert: readFileSync(`${CERT}/c.pem`) });

  it("mTLS: client certificates are presented over HTTP/1.1 and HTTP/2", async () => {
    const opts = { ...files(), ca: readFileSync(`${CERT}/c.pem`), requestCert: true, rejectUnauthorized: true };
    const h1 = https.createServer(opts, (req, res) => {
      res.end(JSON.stringify({ authorized: (req.socket as import("node:tls").TLSSocket).authorized }));
    });
    const h2 = http2.createSecureServer({ ...opts, allowHTTP1: false }, (req, res) => {
      res.end(JSON.stringify({ authorized: (req.socket as unknown as import("node:tls").TLSSocket).authorized }));
    });
    await Promise.all([h1, h2].map((srv) => new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))));
    try {
      const tls = { ca: readFileSync(`${CERT}/c.pem`), cert: readFileSync(`${CERT}/c.pem`), key: readFileSync(`${CERT}/k.pem`) };
      for (const [srv, http2Flag] of [
        [h1, false],
        [h2, true],
      ] as const) {
        const base = `https://localhost:${(srv.address() as AddressInfo).port}`;
        const withCert = h.engine({ baseUrl: base, defaultAuth: false, http2: http2Flag, tls, responseType: "json" });
        expect(await withCert.get("/x")).toMatchObject({ ok: true, data: { authorized: true } });
        const without = h.engine({ baseUrl: base, defaultAuth: false, http2: http2Flag, tls: { ca: tls.ca }, retryLimit: 0 });
        expect((await without.get("/x")).ok).toBe(false);
      }
    } finally {
      await Promise.all([h1, h2].map((srv) => new Promise<void>((r) => srv.close(() => r()))));
    }
  });

  it("HTTP/2 pool: IP-literal hosts, plain http, abort while the session is being set up", async () => {
    const srv = http2.createSecureServer(files(), (_q, res) => res.end("{}"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const ca = readFileSync(`${CERT}/c.pem`);
      const byIp = h.engine({ baseUrl: `https://127.0.0.1:${port}`, defaultAuth: false, http2: true, tls: { ca } });
      expect((await byIp.get("/x")).ok).toBe(true);

      const plain = await h.serve((req, res) => json(res, 200, { v: req.httpVersion }));
      const plainApi = h.engine({ baseUrl: plain.url, defaultAuth: false, http2: true });
      expect(await plainApi.get("/x")).toMatchObject({ ok: true, data: { v: "1.1" } });

      const fresh = h.engine({ baseUrl: `https://localhost:${port}`, defaultAuth: false, http2: true, tls: { ca } });
      const ctl = new AbortController();
      ctl.abort();
      expect(await fresh.get("/x", { signal: ctl.signal })).toMatchObject({ ok: false, code: "ABORTED" });
      expect((await fresh.get("/y")).ok).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
