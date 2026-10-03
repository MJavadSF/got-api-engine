import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type GotApiEngine } from "../src/index";
import { json, sleep, startServer, type TestServer } from "./server";

const servers: TestServer[] = [];
const engines: GotApiEngine[] = [];

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const s = await startServer(handler);
  servers.push(s);
  return s;
}
function engine(cfg: Parameters<typeof createEngine>[0]): GotApiEngine {
  const e = createEngine({ logLevel: "silent", ...cfg });
  engines.push(e);
  return e;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const fastRetry = { limit: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 };

describe("basics & response decoding", () => {
  it("GET json / text / buffer / 204", async () => {
    const s = await serve((req, res) => {
      if (req.url === "/json") return json(res, 200, { a: 1 });
      if (req.url === "/text") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end("hello");
      }
      if (req.url === "/bin") {
        res.writeHead(200, { "content-type": "image/png" });
        return void res.end(Buffer.from([0, 1, 2, 255]));
      }
      res.writeHead(204).end();
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false });

    const j = await api.get<{ a: number }>("/json");
    expect(j.ok && j.data.a).toBe(1);
    expect(j.meta?.attempts).toBe(1);

    const t = await api.get("/text");
    expect(t.ok && t.data).toBe("hello");

    const b = await api.get("/bin");
    expect(b.ok && Buffer.isBuffer(b.data) && [...(b.data as Buffer)]).toEqual([0, 1, 2, 255]);

    const forcedBuf = await api.get("/json", { responseType: "buffer" });
    expect(forcedBuf.ok && Buffer.isBuffer(forcedBuf.data)).toBe(true);

    const n = await api.get("/nothing");
    expect(n.ok && n.status).toBe(204);
  });

  it("a non-JSON gateway error body keeps the real status (no NETWORK_ERROR)", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad Gateway</html>");
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false, retry: { ...fastRetry, limit: 0 } });
    const r = await api.get("/x");
    expect(r).toMatchObject({ ok: false, status: 502, code: "HTTP_ERROR" });
    expect(!r.ok && r.error).toBe("An unexpected error occurred.");
  });

  it("invalid JSON on a 200 is PARSE_ERROR (502)", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{oops");
    });
    const r = await engine({ baseUrl: s.url, defaultAuth: false }).get("/x");
    expect(r).toMatchObject({ ok: false, status: 502, code: "PARSE_ERROR" });
  });

  it("keeps upstream error body as `details`", async () => {
    const s = await serve((_req, res) => json(res, 422, { message: "bad", fields: { email: "required" } }));
    const r = await engine({ baseUrl: s.url, defaultAuth: false }).get("/x");
    expect(r).toMatchObject({ ok: false, status: 422, error: "bad", details: { fields: { email: "required" } } });
  });

  it("sends arrays as repeated query keys and Accept by default", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    await engine({ baseUrl: s.url, defaultAuth: false }).get("/q", { params: { tag: ["a", "b"], n: 1 } });
    expect(s.requests[0]!.url).toBe("/q?tag=a&tag=b&n=1");
    expect(s.requests[0]!.headers.accept).toContain("application/json");
  });

  it("supports HEAD / OPTIONS / QUERY (got 16)", async () => {
    const s = await serve((req, res, ctx) => {
      if (req.method === "QUERY") return json(res, 200, { echoed: JSON.parse(ctx.body) });
      res.writeHead(200, { "x-method": req.method ?? "" }).end();
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false });
    const h = await api.head("/x");
    expect(h.ok && h.headers?.["x-method"]).toBe("HEAD");
    const o = await api.options("/x");
    expect(o.ok && o.headers?.["x-method"]).toBe("OPTIONS");
    const q = await api.query<{ echoed: unknown }>("/search", { filter: "a" });
    expect(q.ok && q.data.echoed).toEqual({ filter: "a" });
  });
});

describe("request bodies", () => {
  it("Buffer / string / URLSearchParams / FormData are sent as-is (Buffer was JSON-mangled before)", async () => {
    const s = await serve((req, res, ctx) => json(res, 200, { ct: req.headers["content-type"], body: ctx.body }));
    const api = engine({ baseUrl: s.url, defaultAuth: false });

    const buf = await api.post<{ body: string }>("/b", Buffer.from("raw-bytes"));
    expect(buf.ok && buf.data.body).toBe("raw-bytes");

    const str = await api.post<{ body: string }>("/s", "plain");
    expect(str.ok && str.data.body).toBe("plain");

    const form = await api.post<{ ct: string; body: string }>("/f", new URLSearchParams({ a: "1", b: "x y" }));
    expect(form.ok && form.data.ct).toContain("application/x-www-form-urlencoded");
    expect(form.ok && form.data.body).toBe("a=1&b=x+y");

    const fd = new FormData();
    fd.set("field", "value");
    const multi = await api.post<{ ct: string; body: string }>("/m", fd);
    expect(multi.ok && multi.data.ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(multi.ok && multi.data.body).toContain("value");
  });

  it("DELETE can carry a body", async () => {
    const s = await serve((_req, res, ctx) => json(res, 200, { body: ctx.body }));
    const r = await engine({ baseUrl: s.url, defaultAuth: false }).delete<{ body: string }>("/x", { body: { ids: [1, 2] } });
    expect(r.ok && JSON.parse(r.data.body)).toEqual({ ids: [1, 2] });
  });

  it("validates with a schema and returns REQUEST_VALIDATION before any network call", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const schema = {
      safeParse: (d: unknown) =>
        (d as { name?: string }).name
          ? { success: true as const, data: d as { name: string } }
          : { success: false as const, error: { issues: [{ path: ["name"], message: "required" }] } },
    };
    const r = await engine({ baseUrl: s.url, defaultAuth: false }).post("/x", {} as { name: string }, { schema });
    expect(r).toMatchObject({ ok: false, status: 400, code: "REQUEST_VALIDATION" });
    expect(s.hits).toBe(0);
  });

  it("a schema that throws does not crash or trigger retries", async () => {
    const s = await serve((_req, res) => json(res, 200, { a: 1 }));
    const responseSchema = {
      safeParse: () => {
        throw new Error("refine exploded");
      },
    };
    const r = await engine({ baseUrl: s.url, defaultAuth: false, retry: fastRetry }).get("/x", { responseSchema });
    expect(r).toMatchObject({ ok: false, status: 502, code: "RESPONSE_VALIDATION" });
    expect(s.hits).toBe(1);
  });
});

describe("retries", () => {
  it("does NOT retry POST by default, and never double-executes", async () => {
    const s = await serve((_req, res) => json(res, 503, { message: "down" }));
    const r = await engine({ baseUrl: s.url, defaultAuth: false, retry: fastRetry }).post("/pay", { amount: 1 });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(s.hits).toBe(1);
  });

  it("retries POST when an Idempotency-Key is present, reusing the same key", async () => {
    const s = await serve((_req, res, ctx) => (ctx.hit < 3 ? json(res, 503, {}) : json(res, 200, { ok: 1 })));
    const r = await engine({ baseUrl: s.url, defaultAuth: false, retry: fastRetry }).post("/pay", { a: 1 }, { idempotencyKey: "k-1" });
    expect(r.ok).toBe(true);
    expect(s.hits).toBe(3);
    expect(new Set(s.requests.map((q) => q.headers["idempotency-key"]))).toEqual(new Set(["k-1"]));
    expect(r.meta?.attempts).toBe(3);
  });

  it("retries GET on 503 then succeeds; fires onRetry", async () => {
    const s = await serve((_req, res, ctx) => (ctx.hit < 2 ? json(res, 503, {}) : json(res, 200, { ok: true })));
    const retries: number[] = [];
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      retry: fastRetry,
      hooks: { onRetry: (c) => void retries.push(c.attempt) },
    });
    const r = await api.get("/x");
    expect(r.ok).toBe(true);
    expect(retries).toEqual([1]);
    expect(api.getMetrics()?.retryCount).toBe(1);
  });

  it("per-request `retry` merges over engine config instead of resetting it", async () => {
    // Engine says: retry only on 418. A per-request {limit: 2} must keep that.
    const s = await serve((_req, res) => json(res, 503, {}));
    const api = engine({ baseUrl: s.url, defaultAuth: false, retry: { ...fastRetry, retryStatusCodes: [418] } });
    await api.get("/x", { retry: { limit: 2 } });
    expect(s.hits).toBe(1); // 503 is not in the engine's retryStatusCodes
  });

  it("honours the per-request `retryLimit` (it was silently ignored before)", async () => {
    const s = await serve((_req, res) => json(res, 503, {}));
    const api = engine({ baseUrl: s.url, defaultAuth: false, retry: { ...fastRetry, limit: 5 } });
    await api.get("/x", { retryLimit: 1 });
    expect(s.hits).toBe(2);
  });

  it("does not sleep for an absurd Retry-After: gives up immediately", async () => {
    const s = await serve((_req, res) => json(res, 429, {}, { "retry-after": "3600" }));
    const api = engine({ baseUrl: s.url, defaultAuth: false, retry: { ...fastRetry, maxRetryAfterMs: 50 } });
    const t0 = Date.now();
    const r = await api.get("/x");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.hits).toBe(1);
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(!r.ok && r.meta?.retryAfterMs).toBe(3_600_000);
  });

  it("Retry-After: 0 retries immediately", async () => {
    const s = await serve((_req, res, ctx) => (ctx.hit < 2 ? json(res, 429, {}, { "retry-after": "0" }) : json(res, 200, {})));
    const r = await engine({ baseUrl: s.url, defaultAuth: false, retry: { ...fastRetry, baseDelayMs: 5_000, maxDelayMs: 5_000 } }).get("/x");
    expect(r.ok).toBe(true);
  });

  it("retries network errors on idempotent methods, counting the circuit failure once", async () => {
    const s = await serve((_req, res) => void res.destroy());
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      retry: { ...fastRetry, limit: 1 },
      circuitBreaker: { enabled: true, failureThreshold: 100 },
    });
    const r = await api.get("/x");
    expect(r).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    expect(s.hits).toBe(2);
    expect(api.getMetrics()?.errorCount).toBe(1);
  });
});

describe("cache", () => {
  it("cache hits do NOT consume rate-limit tokens or get blocked by an open circuit", async () => {
    const s = await serve((_req, res) => json(res, 200, { v: 1 }));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      cache: { enabled: true, ttlMs: 60_000 },
      rateLimit: { enabled: true, requestsPerInterval: 1, intervalMs: 60_000, burst: 1, onLimit: "reject" },
    });
    expect((await api.get("/x")).ok).toBe(true); // consumes the single token
    for (let i = 0; i < 5; i++) {
      const r = await api.get("/x");
      expect(r.ok && r.meta?.cached).toBe(true); // served from cache — not RATE_LIMITED
    }
    expect(s.hits).toBe(1);
    expect(api.getMetrics()?.rateLimitedCount).toBe(0);
  });

  it("cached data is isolated from caller mutation", async () => {
    const s = await serve((_req, res) => json(res, 200, { list: [1, 2] }));
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true } });
    const a = await api.get<{ list: number[] }>("/x");
    a.ok && a.data.list.push(99);
    const b = await api.get<{ list: number[] }>("/x");
    expect(b.ok && b.data.list).toEqual([1, 2]);
  });

  it("does not serve one principal's cached response to another (full-width key hash)", async () => {
    const s = await serve((req, res) => json(res, 200, { who: req.headers.authorization }));
    const api = engine({ baseUrl: s.url, cache: { enabled: true } });
    const a = await api.get<{ who: string }>("/me", { authToken: "alice" });
    const b = await api.get<{ who: string }>("/me", { authToken: "bob" });
    expect(a.ok && a.data.who).toBe("Bearer alice");
    expect(b.ok && b.data.who).toBe("Bearer bob");
  });

  it("varies by custom request headers (Accept-Language no longer collides)", async () => {
    const s = await serve((req, res) => json(res, 200, { lang: req.headers["accept-language"] }));
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true } });
    const en = await api.get<{ lang: string }>("/x", { headers: { "Accept-Language": "en" } });
    const fa = await api.get<{ lang: string }>("/x", { headers: { "Accept-Language": "fa" } });
    expect(en.ok && en.data.lang).toBe("en");
    expect(fa.ok && fa.data.lang).toBe("fa");
  });

  it("caches the raw body: a different responseSchema per call works", async () => {
    const s = await serve((_req, res) => json(res, 200, { n: "5" }));
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true } });
    const toNumber = { safeParse: (d: unknown) => ({ success: true as const, data: Number((d as { n: string }).n) }) };
    const a = await api.get("/x", { responseSchema: toNumber });
    const b = await api.get("/x"); // no schema → must see the raw shape, not the transformed number
    expect(a.ok && a.data).toBe(5);
    expect(b.ok && b.data).toEqual({ n: "5" });
    expect(s.hits).toBe(1);
  });

  it("ETag revalidation: 304 refreshes the entry and serves cached data", async () => {
    const s = await serve((req, res) => {
      if (req.headers["if-none-match"] === '"v1"') return void res.writeHead(304).end();
      json(res, 200, { v: 1 }, { etag: '"v1"' });
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 20 } });
    await api.get("/x");
    await sleep(40);
    const r = await api.get<{ v: number }>("/x");
    expect(r.ok && r.data.v).toBe(1);
    expect(r.ok && r.meta?.cached).toBe(true);
    expect(s.requests[1]!.headers["if-none-match"]).toBe('"v1"');
  });

  it("stale-while-revalidate serves stale instantly and revalidates once in the background", async () => {
    let version = 1;
    const s = await serve(async (_req, res) => {
      await sleep(30);
      json(res, 200, { v: version });
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 20, staleWhileRevalidate: true } });
    await api.get("/x");
    await sleep(40);
    version = 2;
    const [a, b] = await Promise.all([api.get<{ v: number }>("/x"), api.get<{ v: number }>("/x")]);
    expect(a.ok && a.data.v).toBe(1);
    expect(a.ok && a.meta).toMatchObject({ cached: true, stale: true, staleReason: "revalidating" });
    expect(b.ok && b.data.v).toBe(1);
    await sleep(120);
    const fresh = await api.get<{ v: number }>("/x");
    expect(fresh.ok && fresh.data.v).toBe(2);
    expect(s.hits).toBe(2); // 1 initial + exactly ONE background revalidation
  });

  it("stale-if-error serves the stale copy when upstream is down", async () => {
    let healthy = true;
    const s = await serve((_req, res) => (healthy ? json(res, 200, { v: 1 }) : json(res, 503, {})));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      retry: { ...fastRetry, limit: 0 },
      cache: { enabled: true, ttlMs: 10, staleIfError: true },
    });
    await api.get("/x");
    await sleep(30);
    healthy = false;
    const r = await api.get<{ v: number }>("/x");
    expect(r.ok && r.data.v).toBe(1);
    expect(r.ok && r.meta).toMatchObject({ stale: true, staleReason: "error" });
    expect(api.getMetrics()?.staleServed).toBe(1);
  });

  it("without staleIfError the error is returned", async () => {
    let healthy = true;
    const s = await serve((_req, res) => (healthy ? json(res, 200, {}) : json(res, 503, {})));
    const api = engine({ baseUrl: s.url, defaultAuth: false, retry: { ...fastRetry, limit: 0 }, cache: { enabled: true, ttlMs: 10 } });
    await api.get("/x");
    await sleep(30);
    healthy = false;
    expect((await api.get("/x")).ok).toBe(false);
  });

  it("a successful mutation invalidates cached reads (item, Location, parent collection)", async () => {
    let name = "old";
    const s = await serve((req, res) => {
      if (req.method === "PUT") {
        name = "new";
        return json(res, 200, { ok: true });
      }
      json(res, 200, { name });
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 60_000 } });
    expect((await api.get<{ name: string }>("/users/1")).ok).toBe(true);
    await api.put("/users/1", { name: "new" });
    const after = await api.get<{ name: string }>("/users/1");
    expect(after.ok && after.data.name).toBe("new");
    expect(after.ok && after.meta?.cached).toBeFalsy();
  });

  it("respectCacheControl: max-age drives TTL, no-store is never cached", async () => {
    const s = await serve((req, res) => {
      if (req.url === "/nostore") return json(res, 200, {}, { "cache-control": "no-store" });
      json(res, 200, {}, { "cache-control": "max-age=60" });
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 1, respectCacheControl: true } });
    await api.get("/ttl");
    await sleep(20); // default ttl (1ms) would have expired
    expect((await api.get("/ttl")).meta?.cached).toBe(true);
    await api.get("/nostore");
    expect((await api.get("/nostore")).meta?.cached).toBeFalsy();
  });

  it("invalidateResource drops all variants of a resource", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 60_000 } });
    await api.get("/r", { params: { page: 1 } });
    await api.get("/r", { params: { page: 2 } });
    await api.invalidateResource("/r");
    await api.get("/r", { params: { page: 1 } });
    expect(s.hits).toBe(3);
  });

  it("invalidateCache(method, endpoint) drops the exact entry", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, ttlMs: 60_000 } });
    await api.get("/e");
    await api.invalidateCache("GET", "/e");
    await api.get("/e");
    expect(s.hits).toBe(2);
  });
});

describe("dedupe", () => {
  it("collapses concurrent identical GETs; followers get their own copy", async () => {
    const s = await serve(async (_req, res) => {
      await sleep(30);
      json(res, 200, { list: [1] });
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false });
    const [a, b, c] = await Promise.all([api.get<{ list: number[] }>("/x"), api.get<{ list: number[] }>("/x"), api.get<{ list: number[] }>("/x")]);
    expect(s.hits).toBe(1);
    expect([a.meta?.deduped, b.meta?.deduped, c.meta?.deduped].filter(Boolean)).toHaveLength(2);
    a.ok && a.data.list.push(2);
    expect(b.ok && b.data.list).toEqual([1]);
    expect(api.getMetrics()?.dedupeHits).toBe(2);
  });

  it("does not merge requests that differ in headers or credentials", async () => {
    const s = await serve(async (req, res) => {
      await sleep(20);
      json(res, 200, { lang: req.headers["accept-language"], auth: req.headers.authorization });
    });
    const api = engine({ baseUrl: s.url });
    const [en, fa, bob] = await Promise.all([
      api.get<{ lang: string }>("/x", { authToken: "a", headers: { "Accept-Language": "en" } }),
      api.get<{ lang: string }>("/x", { authToken: "a", headers: { "Accept-Language": "fa" } }),
      api.get<{ auth: string }>("/x", { authToken: "b" }),
    ]);
    expect(s.hits).toBe(3);
    expect(en.ok && en.data.lang).toBe("en");
    expect(fa.ok && fa.data.lang).toBe("fa");
    expect(bob.ok && bob.data.auth).toBe("Bearer b");
  });

  it("aborting one caller does not fail the others (leader with a signal never leads)", async () => {
    const s = await serve(async (_req, res) => {
      await sleep(80);
      json(res, 200, { ok: true });
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false });
    const ac = new AbortController();
    const first = api.get("/x", { signal: ac.signal });
    const second = api.get("/x");
    setTimeout(() => ac.abort(), 15);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: false, code: "ABORTED" });
    expect(b.ok).toBe(true);
  });

  it("a follower can abort its own wait", async () => {
    const s = await serve(async (_req, res) => {
      await sleep(100);
      json(res, 200, {});
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false });
    const lead = api.get("/x");
    const ac = new AbortController();
    const follow = api.get("/x", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await follow).toMatchObject({ ok: false, code: "ABORTED" });
    expect((await lead).ok).toBe(true);
  });

  it("dedupe:false opts out", async () => {
    const s = await serve(async (_req, res) => {
      await sleep(20);
      json(res, 200, {});
    });
    const api = engine({ baseUrl: s.url, defaultAuth: false });
    await Promise.all([api.get("/x", { dedupe: false }), api.get("/x", { dedupe: false })]);
    expect(s.hits).toBe(2);
  });
});

describe("circuit breaker + rate limiter", () => {
  it("opens after consecutive failures and short-circuits with CIRCUIT_OPEN", async () => {
    const s = await serve((_req, res) => json(res, 500, {}));
    const events: string[] = [];
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      retry: { ...fastRetry, limit: 0 },
      circuitBreaker: { enabled: true, failureThreshold: 2, resetTimeoutMs: 50 },
      hooks: { onCircuitStateChange: (c) => void events.push(`${c.from}>${c.to}`) },
    });
    await api.get("/x");
    await api.get("/x");
    const blocked = await api.get("/x");
    expect(blocked).toMatchObject({ ok: false, status: 503, code: "CIRCUIT_OPEN" });
    expect(s.hits).toBe(2);
    expect(api.getCircuitState()).toBe("open");
    await sleep(70);
    expect(api.getCircuitState()).toBe("half-open");
    expect(events).toContain("closed>open");
  });

  it("half-open lets only ONE probe through, closes after successThreshold successes", async () => {
    let healthy = false;
    const s = await serve(async (_req, res) => {
      await sleep(40);
      healthy ? json(res, 200, {}) : json(res, 500, {});
    });
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      retry: { ...fastRetry, limit: 0 },
      circuitBreaker: { enabled: true, failureThreshold: 1, resetTimeoutMs: 30, successThreshold: 1 },
    });
    await api.get("/x");
    healthy = true;
    await sleep(50);
    const before = s.hits;
    const results = await Promise.all([api.get("/x"), api.get("/x"), api.get("/x")]);
    expect(s.hits - before).toBe(1); // a single probe
    expect(results.filter((r) => !r.ok && r.code === "CIRCUIT_OPEN")).toHaveLength(2);
    expect(api.getCircuitState()).toBe("closed");
  });

  it("client-side rate limiter rejects in reject mode and counts it", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      rateLimit: { enabled: true, requestsPerInterval: 1, intervalMs: 60_000, burst: 1, onLimit: "reject" },
    });
    expect((await api.get("/x")).ok).toBe(true);
    expect(await api.get("/x")).toMatchObject({ ok: false, status: 429, code: "RATE_LIMITED" });
  });

  it("wait mode queues in FIFO order and every request completes", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      // 10 tokens / 100ms => one token every 10ms; burst of 2 => 4 requests must wait ~40ms
      rateLimit: { enabled: true, requestsPerInterval: 10, intervalMs: 100, burst: 2, onLimit: "wait" },
    });
    const t0 = Date.now();
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => api.get("/x", { headers: { "X-N": String(i) } })),
    );
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(s.requests.map((q) => q.headers["x-n"])).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("waiting requests can be aborted and leave the queue", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      rateLimit: { enabled: true, requestsPerInterval: 1, intervalMs: 60_000, burst: 1, onLimit: "wait", maxWaitMs: 120_000 },
    });
    await api.get("/x"); // drains the bucket
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const r = await api.get("/x", { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, code: "ABORTED" });
    expect(s.hits).toBe(1);
  });

  it("retries pass through the rate limiter too", async () => {
    const s = await serve((_req, res) => json(res, 503, {}));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      retry: { ...fastRetry, limit: 3 },
      rateLimit: { enabled: true, requestsPerInterval: 1, intervalMs: 60_000, burst: 2, onLimit: "reject" },
    });
    const r = await api.get("/x");
    expect(s.hits).toBe(2); // burst=2 → third attempt is rate limited
    expect(r).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });
});

describe("credentials & auth", () => {
  it("never sends engine credentials to a foreign origin (CREDENTIALS_BLOCKED)", async () => {
    const trusted = await serve((_req, res) => json(res, 200, {}));
    const attacker = await serve((_req, res) => json(res, 200, {}));
    const api = engine({ baseUrl: trusted.url, auth: "SECRET" });

    const blocked = await api.get(`${attacker.url}/steal`);
    expect(blocked).toMatchObject({ ok: false, status: 403, code: "CREDENTIALS_BLOCKED" });
    expect(attacker.hits).toBe(0);

    // explicit opt-outs still work
    expect((await api.get(`${attacker.url}/public`, { auth: false })).ok).toBe(true);
    expect(attacker.requests[0]!.headers.authorization).toBeUndefined();
    // "optional" silently omits credentials for foreign hosts
    expect((await api.get(`${attacker.url}/opt`, { auth: "optional" })).ok).toBe(true);
    expect(attacker.requests[1]!.headers.authorization).toBeUndefined();
    // same-origin still authenticated
    await api.get("/mine");
    expect(trusted.requests[0]!.headers.authorization).toBe("Bearer SECRET");
  });

  it("credentialHosts whitelists extra hosts", async () => {
    const other = await serve((_req, res) => json(res, 200, {}));
    const api = engine({ baseUrl: "https://api.example.test", auth: "T", credentialHosts: ["127.0.0.1"] });
    expect((await api.get(`${other.url}/x`)).ok).toBe(true);
    expect(other.requests[0]!.headers.authorization).toBe("Bearer T");
  });

  it("AUTH_REQUIRED when no token; provider errors become AUTH_PROVIDER_ERROR (not NETWORK_ERROR)", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const none = await engine({ baseUrl: s.url }).get("/x");
    expect(none).toMatchObject({ ok: false, status: 401, code: "AUTH_REQUIRED" });

    const api = engine({
      baseUrl: s.url,
      auth: () => {
        throw new Error("vault offline");
      },
      circuitBreaker: { enabled: true, failureThreshold: 1 },
    });
    expect(await api.get("/x")).toMatchObject({ ok: false, status: 500, code: "AUTH_PROVIDER_ERROR" });
    expect(api.getCircuitState()).toBe("closed"); // auth bugs must not trip the upstream breaker
    expect(s.hits).toBe(0);
  });

  it("calls a token function exactly once per request", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    let calls = 0;
    const api = engine({
      baseUrl: s.url,
      auth: () => {
        calls++;
        return "t";
      },
      cache: { enabled: true },
    });
    await api.get("/x");
    expect(calls).toBe(1); // was: once for the dedupe key, once for the cache key, once to send
  });

  it("401 → refreshAuth (single-flight) → request replayed once with the new token", async () => {
    let valid = "new";
    const s = await serve((req, res) =>
      req.headers.authorization === `Bearer ${valid}` ? json(res, 200, { ok: true }) : json(res, 401, { message: "expired" }),
    );
    let refreshes = 0;
    const api = engine({
      baseUrl: s.url,
      auth: "old",
      dedupe: false,
      refreshAuth: async () => {
        refreshes++;
        await sleep(20);
        return "new";
      },
    });
    const rs = await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(refreshes).toBe(1);
    expect(api.getMetrics()?.authRefreshes).toBe(1);

    // subsequent requests use the refreshed token straight away (no new 401)
    const before = s.hits;
    await api.get("/d");
    expect(s.hits - before).toBe(1);
    valid = "x";
  });

  it("does not loop when the refreshed token is still rejected", async () => {
    const s = await serve((_req, res) => json(res, 401, { message: "nope" }));
    let refreshes = 0;
    const api = engine({ baseUrl: s.url, auth: "old", refreshAuth: () => (refreshes++, "still-bad") });
    const r = await api.get("/x");
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(refreshes).toBe(1);
    expect(s.hits).toBe(2);
  });

  it("sends request-id upstream when requestIdHeader is set", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({ baseUrl: s.url, defaultAuth: false, requestIdHeader: "X-Request-Id" });
    const r = await api.get("/x", { requestId: "trace-123" });
    expect(s.requests[0]!.headers["x-request-id"]).toBe("trace-123");
    expect(r.meta?.requestId).toBe("trace-123");
  });
});

describe("SSRF protection (end-to-end)", () => {
  it("blocks private targets before connecting", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = engine({ baseUrl: "https://api.example.test", defaultAuth: false, ssrfProtection: true });
    expect(await api.get(s.url + "/x")).toMatchObject({ ok: false, status: 403, code: "SSRF_BLOCKED" });
    expect(await api.get("http://[::ffff:127.0.0.1]:" + s.port + "/x")).toMatchObject({ code: "SSRF_BLOCKED" });
    expect(s.hits).toBe(0);
  });

  it("allowPrivateNetworks lets a local server through; cross-origin redirects are blocked and reported as SSRF_BLOCKED (not retried NETWORK_ERROR)", async () => {
    const target = await serve((_req, res) => json(res, 200, { reached: true }));
    const origin = await serve((req, res) => {
      if (req.url === "/same") return void res.writeHead(302, { location: "/dest" }).end();
      if (req.url === "/dest") return json(res, 200, { same: true });
      res.writeHead(302, { location: `${target.url}/x` }).end();
    });
    const api = engine({
      baseUrl: origin.url,
      defaultAuth: false,
      retry: fastRetry,
      ssrfProtection: { allowPrivateNetworks: true, sameOriginRedirectsOnly: true },
    });

    const ok = await api.get<{ same: boolean }>("/same");
    expect(ok.ok && ok.data.same).toBe(true);

    const bad = await api.get("/cross");
    expect(bad).toMatchObject({ ok: false, status: 403, code: "SSRF_BLOCKED" });
    expect(target.hits).toBe(0);
    expect(origin.requests.filter((r) => r.url === "/cross")).toHaveLength(1); // no retry storm
  });

  it("same-origin redirect check is relative to the redirecting origin, not baseUrl", async () => {
    const other = await serve((req, res) => {
      if (req.url === "/a") return void res.writeHead(302, { location: "/b" }).end();
      json(res, 200, { b: true });
    });
    const api = engine({
      baseUrl: "https://api.example.test",
      defaultAuth: false,
      ssrfProtection: { allowPrivateNetworks: true },
    });
    const r = await api.get<{ b: boolean }>(other.url + "/a");
    expect(r.ok && r.data.b).toBe(true);
  });
});

describe("timeouts, aborts, lifecycle", () => {
  it("per-attempt timeout → TIMEOUT 504", async () => {
    const s = await serve(async (_req, res) => {
      await sleep(300);
      json(res, 200, {});
    });
    const r = await engine({ baseUrl: s.url, defaultAuth: false, timeoutMs: 50, retry: { ...fastRetry, limit: 0 } }).get("/x");
    expect(r).toMatchObject({ ok: false, status: 504, code: "TIMEOUT" });
  });

  it("totalTimeoutMs bounds retries + backoff", async () => {
    const s = await serve((_req, res) => json(res, 503, {}));
    const api = engine({
      baseUrl: s.url,
      defaultAuth: false,
      totalTimeoutMs: 80,
      retry: { limit: 50, baseDelayMs: 40, maxDelayMs: 40, jitter: 0 },
    });
    const t0 = Date.now();
    const r = await api.get("/x");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" });
  });

  it("caller AbortSignal → ABORTED 499", async () => {
    const s = await serve(async (_req, res) => {
      await sleep(300);
      json(res, 200, {});
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    expect(await engine({ baseUrl: s.url, defaultAuth: false }).get("/x", { signal: ac.signal })).toMatchObject({
      ok: false,
      status: 499,
      code: "ABORTED",
    });
  });

  it("invalid URL / disposed engine return structured errors", async () => {
    const api = engine({ baseUrl: "https://api.example.test", defaultAuth: false });
    expect(await api.get("http://")).toMatchObject({ ok: false, code: "INVALID_URL" });
    await api.dispose();
    expect(await api.get("/x")).toMatchObject({ ok: false, status: 503, code: "ENGINE_DISPOSED" });
  });

  it("constructor validates baseUrl", () => {
    expect(() => createEngine({ baseUrl: "" })).toThrow(TypeError);
    expect(() => createEngine({ baseUrl: "not a url" })).toThrow(TypeError);
    expect(() => createEngine({ baseUrl: "ftp://x.test" })).toThrow(TypeError);
  });

  it("supports `await using` via Symbol.asyncDispose", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    let ref: GotApiEngine;
    {
      await using api = createEngine({ baseUrl: s.url, defaultAuth: false, logLevel: "silent" });
      ref = api;
      expect((await api.get("/x")).ok).toBe(true);
    }
    expect(await ref.get("/x")).toMatchObject({ code: "ENGINE_DISPOSED" });
  });
});

describe("extend()", () => {
  it("keeps the parent's FULL config (ssrf, cache, retry, circuit…) — it used to drop them silently", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const parent = engine({
      baseUrl: "https://api.example.test",
      defaultAuth: false,
      ssrfProtection: true,
      cache: { enabled: true, ttlMs: 60_000 },
      circuitBreaker: { enabled: true, failureThreshold: 1 },
      retry: { ...fastRetry, retryStatusCodes: [418] },
      metrics: true,
      requestIdHeader: "X-Request-Id",
    });
    const child = engine({ ...({} as object), baseUrl: "https://api.example.test", defaultAuth: false }); // sanity: engines are independent
    void child;

    const forked = parent.extend({ defaultHeaders: { "X-Admin": "1" }, timeoutMs: 1234 });
    engines.push(forked);

    // SSRF protection survived the fork
    expect(await forked.get(s.url + "/x")).toMatchObject({ code: "SSRF_BLOCKED" });
    // metrics + circuit config survived
    expect(forked.getMetrics()).not.toBeNull();
    expect(forked.getCircuitState()).toBe("closed");
  });

  it("merges headers, appends hooks, and merges config objects", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const calls: string[] = [];
    const parent = engine({
      baseUrl: s.url,
      defaultAuth: false,
      defaultHeaders: { "X-A": "1" },
      hooks: { onRequest: () => void calls.push("parent") },
      cache: { enabled: true, ttlMs: 60_000 },
    });
    const child = parent.extend({
      defaultHeaders: { "x-a": "2", "X-B": "3" },
      hooks: { onRequest: () => void calls.push("child") },
      cache: { ttlMs: 1 } as never, // partial override keeps `enabled: true`
    });
    engines.push(child);
    await child.get("/x");
    expect(calls).toEqual(["parent", "child"]);
    expect(s.requests[0]!.headers["x-a"]).toBe("2");
    expect(s.requests[0]!.headers["x-b"]).toBe("3");
    await sleep(10);
    await child.get("/x");
    expect(s.hits).toBe(2); // cache still enabled, ttl 1ms → expired
  });
});

describe("TLS default", () => {
  it("verifies certificates by default in every NODE_ENV (was: disabled unless NODE_ENV=production)", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const api = engine({ baseUrl: "https://api.example.test" });
      // @ts-expect-error reading a protected field for verification
      expect(api.config.rejectUnauthorized).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("metrics", () => {
  it("tracks requests, statuses, latency", async () => {
    const s = await serve((req, res) => (req.url === "/bad" ? json(res, 404, {}) : json(res, 200, {})));
    const api = engine({ baseUrl: s.url, defaultAuth: false });
    await api.get("/ok");
    await api.get("/bad");
    const m = api.getMetrics()!;
    expect(m.totalRequests).toBe(2);
    expect(m.successCount).toBe(1);
    expect(m.errorCount).toBe(1);
    expect(m.byStatus).toEqual({ "200": 1, "404": 1 });
    expect(m.latency.count).toBe(2);
    api.resetMetrics();
    expect(api.getMetrics()!.totalRequests).toBe(0);
  });
});
