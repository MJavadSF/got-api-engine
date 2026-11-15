// Regression tests for the audit findings (v3 → v4).
import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../src/cache/memory-store";
import { createApiKeyAuth, createRefreshableAuth, isPrivateAddress, path, toPrometheus } from "../src/index";
import { buildRedactor } from "../src/security/redact";
import { numberV, useHarness } from "./harness";
import { json, sleep } from "./server";

const h = useHarness();

describe("security", () => {
  it("#1 Next: a route with a schema rejects non-JSON bodies instead of bypassing validation", async () => {
    const s = await h.serve((_q, res, ctx) => json(res, 200, { got: ctx.body }));
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const schema = {
      safeParse: (d: any) =>
        d?.role === "user" ? { success: true as const, data: d } : { success: false as const, error: { issues: ["no"] } },
    };
    const mk = (ct: string) =>
      new Request("http://app.test/x", { method: "POST", headers: { "content-type": ct }, body: '{"role":"admin"}' });
    expect((await api.handleRoute(mk("application/json"), { endpoint: "/u", method: "POST", schema })).status).toBe(400);
    expect((await api.handleRoute(mk("text/plain"), { endpoint: "/u", method: "POST", schema })).status).toBe(415);
    expect(s.hits).toBe(0);
  });

  it("#2 a client-side error (bad header / bigint body) never retries nor opens the circuit", async () => {
    const s = await h.serve((_q, res) => json(res, 200, {}));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, circuitBreaker: { enabled: true, failureThreshold: 1 } });
    expect(await api.get("/x", { headers: { "X-A": "a\r\nb" } })).toMatchObject({
      ok: false,
      status: 400,
      code: "REQUEST_INVALID",
    });
    expect(await api.put("/x", { n: 1n } as never)).toMatchObject({ ok: false, status: 400, code: "REQUEST_INVALID" });
    expect(api.getCircuitState()).toBe("closed");
    expect((await api.get("/ok")).ok).toBe(true);
    expect(s.hits).toBe(1);
  });

  it("#3 custom credential headers are stripped on redirects to foreign origins", async () => {
    const evil = await h.serve((req, res) => json(res, 200, { key: req.headers["x-api-key"] ?? null }));
    const s = await h.serve((req, res) => {
      if (req.url === "/same") return json(res, 200, { key: req.headers["x-api-key"] ?? null });
      res.writeHead(302, { location: req.url === "/away" ? `${evil.url}/steal` : "/same" }).end();
    });
    const api = h.engine({ baseUrl: s.url, auth: createApiKeyAuth("SECRET") });
    const away = await api.get<{ key: string | null }>("/away");
    const home = await api.get<{ key: string | null }>("/home");
    expect(away.ok && away.data.key).toBeNull();
    expect(home.ok && home.data.key).toBe("SECRET");
  });

  it("#4 Next: infrastructure errors reach the browser without internal details", async () => {
    const api = h.next({ baseUrl: "http://127.0.0.1:1", defaultAuth: false, retryLimit: 0 });
    const res = await api.handleRoute(new Request("http://app.test/x"), { endpoint: "/u" });
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "Could not reach the server.", code: "NETWORK_ERROR" });
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  it("#5 response size is bounded (content-length and streamed)", async () => {
    const big = Buffer.alloc(2048, 97);
    const s = await h.serve((req, res) => {
      if (req.url === "/chunked") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write(big);
        return void res.end(big);
      }
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(big.length) }).end(big);
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, maxResponseBytes: 1000 });
    expect(await api.get("/len")).toMatchObject({ ok: false, code: "RESPONSE_TOO_LARGE", status: 502 });
    expect(await api.get("/chunked")).toMatchObject({ ok: false, code: "RESPONSE_TOO_LARGE" });
    expect((await api.get("/len", { maxResponseBytes: 10_000 })).ok).toBe(true);
  });

  it("#5 Next: incoming bodies above maxBodyBytes → 413", async () => {
    const s = await h.serve((_q, res) => json(res, 200, {}));
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const req = new Request("http://app.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "x".repeat(500) }),
    });
    expect((await api.handleRoute(req, { endpoint: "/u", method: "POST", maxBodyBytes: 100 })).status).toBe(413);
    expect(s.hits).toBe(0);
  });

  it("#6 path traversal is rejected; the `path` tag encodes segments", async () => {
    const s = await h.serve((req, res) => json(res, 200, { path: req.url }));
    const api = h.engine({ baseUrl: `${s.url}/api/v1`, defaultAuth: false });
    for (const ep of ["/users/../../admin", "/users/%2e%2e/admin", "/a/..", "/users/a%2F..%2F..%2Fadmin"]) {
      expect(await api.get(ep)).toMatchObject({ ok: false, code: "INVALID_URL", status: 400 });
    }
    expect(s.hits).toBe(0);
    expect(() => path`/users/${".."}`).toThrow();
    const r = await api.get<{ path: string }>(path`/users/${"a b/c"}`);
    expect(r.ok && r.data.path).toBe("/api/v1/users/a%20b%2Fc");
  });

  it("#14 cache keys never contain raw query strings or credentials", async () => {
    const s = await h.serve((_q, res) => json(res, 200, { ok: 1 }));
    const store = new MemoryCacheStore();
    const api = h.engine({ baseUrl: s.url, auth: "user:pass-secret", cache: { enabled: true, store } });
    await api.get("/x", { params: { api_key: "QUERY-SECRET" } });
    const keys: string[] = [];
    store.deleteMatching((k) => (keys.push(k), false));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/x\?q=/);
    expect(keys[0]).not.toContain("QUERY-SECRET");
    expect(keys[0]).not.toContain("pass-secret");
  });

  it("#17 Next: X-Forwarded-For is not forwarded unless enabled", async () => {
    const s = await h.serve((req, res) => json(res, 200, { xff: req.headers["x-forwarded-for"] ?? null }));
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const req = () => new Request("http://app.test/x", { headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(await (await api.handleRoute(req(), { endpoint: "/u" })).json()).toEqual({ xff: null });
    expect(await (await api.handleRoute(req(), { endpoint: "/u", forwardClientIp: true })).json()).toEqual({ xff: "6.6.6.6" });
  });

  it("#18 redaction matches key patterns; onError receives a credential-free error", async () => {
    const redact = buildRedactor();
    expect(redact({ "x-auth-token": "a", sessionId: "b", private_key: "c", code: "E1", status: 500 })).toEqual({
      "x-auth-token": "[REDACTED]",
      sessionId: "[REDACTED]",
      private_key: "[REDACTED]",
      code: "E1",
      status: 500,
    });
    const errors: unknown[] = [];
    const api = h.engine({
      baseUrl: "http://127.0.0.1:1",
      auth: "TOP-SECRET",
      retryLimit: 0,
      hooks: { onError: (c) => void errors.push(c.error) },
    });
    await api.get("/x");
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0] as object).sort()).toEqual(["code", "message", "name"]);
    expect(JSON.stringify(errors)).not.toContain("TOP-SECRET");
  });

  it("#30 SSRF blocks IPv4-compatible, Teredo and local NAT64 ranges", () => {
    for (const ip of ["::127.0.0.1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b:1::a00:1"])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("correctness", () => {
  it("#7 a dedupe follower is validated with its OWN responseSchema", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(40);
      json(res, 200, { v: "nope" });
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const [a, b] = await Promise.all([api.get("/x"), api.get("/x", { responseSchema: numberV })]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, code: "RESPONSE_VALIDATION" });
    expect(s.hits).toBe(1);
  });

  it("#8 mutation invalidation works for non-ASCII paths and upper-case hosts", async () => {
    let n = 0;
    const s = await h.serve((req, res) => (req.method === "GET" ? json(res, 200, { n: ++n }) : json(res, 200, {})));
    for (const [base, p] of [
      [s.url, "/کاربران/1"],
      [s.url.replace("127.0.0.1", "LOCALHOST"), "/users/1"],
    ] as const) {
      const api = h.engine({ baseUrl: base, defaultAuth: false, cache: { enabled: true, ttlMs: 60_000 } });
      const before = await api.get<{ n: number }>(p);
      await api.put(p, { a: 1 });
      const after = await api.get<{ n: number }>(p);
      expect(after.ok && before.ok && after.data.n).toBe(before.ok && before.data.n + 1);
    }
  });

  it("#9 credential refresh keeps provider headers and drops a stale override", async () => {
    let valid = "new";
    const s = await h.serve((req, res) =>
      req.headers.authorization === `Bearer ${valid}`
        ? json(res, 200, { tenant: req.headers["x-tenant"] ?? null })
        : json(res, 401, {}),
    );
    let providerToken = "old";
    let hookReturns: string | undefined = "new";
    const api = h.engine({
      baseUrl: s.url,
      dedupe: false,
      auth: { getAuthHeader: () => providerToken, getHeaders: () => ({ "X-Tenant": "t1" }) },
      refreshAuth: () => hookReturns,
    });
    const r1 = await api.get<{ tenant: string }>("/a");
    expect(r1.ok && r1.data.tenant).toBe("t1");

    // Later the provider rotates by itself; the hook returns nothing → override cleared.
    valid = "rotated";
    providerToken = "rotated";
    hookReturns = undefined;
    const r2 = await api.get("/b");
    expect(r2.ok).toBe(true);
  });

  it("#10 Next routes are deduplicated even though every request carries req.signal", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(50);
      json(res, 200, { ok: 1 });
    });
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const ctl = new AbortController();
    const reqs = [1, 2, 3, 4, 5].map((i) => new Request("http://app.test/x", i === 1 ? { signal: ctl.signal } : {}));
    const pending = reqs.map((r) => api.handleRoute(r, { endpoint: "/u" }));
    ctl.abort(); // one caller gives up; the others still get the shared response
    const statuses = await Promise.all(pending.map((p) => p.then((r) => r.status)));
    expect(statuses.slice(1)).toEqual([200, 200, 200, 200]);
    expect(s.hits).toBe(1);
  });

  it("#11 a 304 whose cached body fails the schema emits onResponse once per attempt and refetches", async () => {
    let hooks = 0;
    let n = 0;
    const s = await h.serve((req, res) => {
      n++;
      if (req.headers["if-none-match"]) return void res.writeHead(304, { etag: '"a"' }).end();
      json(res, 200, n === 1 ? { v: "bad" } : { v: 2 }, { etag: '"a"' });
    });
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      cache: { enabled: true, ttlMs: 1 },
      hooks: { onResponse: () => void hooks++ },
    });
    await api.get("/x");
    await sleep(5);
    const r = await api.get("/x", { responseSchema: numberV });
    expect(r).toMatchObject({ ok: true, data: { v: 2 } });
    expect(hooks).toBe(s.hits);
  });

  it("#12 dispose() resolves in-flight requests with ENGINE_DISPOSED", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(300);
      json(res, 200, {});
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const p = api.get("/x");
    await sleep(30);
    await api.dispose();
    expect(await p).toMatchObject({ ok: false, code: "ENGINE_DISPOSED", status: 503 });
  });

  it("#13 QUERY bodies are part of the cache key", async () => {
    const s = await h.serve((_q, res, ctx) => json(res, 200, { echo: ctx.body }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, methods: ["GET", "QUERY"] } });
    const a = await api.query<{ echo: string }>("/q", { a: 1 });
    const b = await api.query<{ echo: string }>("/q", { a: 2 });
    const a2 = await api.query<{ echo: string }>("/q", { a: 1 });
    expect(a.ok && b.ok && a.data.echo !== b.data.echo).toBe(true);
    expect(a2.meta?.cached).toBe(true);
    expect(s.hits).toBe(2);
  });

  it("#16 circuit breakers are per host", async () => {
    const bad = await h.serve((_q, res) => json(res, 503, {}));
    const good = await h.serve((_q, res) => json(res, 200, {}));
    const api = h.engine({
      baseUrl: good.url,
      defaultAuth: false,
      retryLimit: 0,
      circuitBreaker: { enabled: true, failureThreshold: 2 },
    });
    await api.get(`${bad.url}/x`);
    await api.get(`${bad.url}/x`);
    expect(await api.get(`${bad.url}/x`)).toMatchObject({ code: "CIRCUIT_OPEN" });
    expect((await api.get("/ok")).ok).toBe(true);
    expect(api.getCircuitState(new URL(bad.url).host)).toBe("open");
    expect(api.getCircuitState(new URL(good.url).host)).toBe("closed");
  });

  it("#23 Next keeps JSON media types such as application/problem+json", async () => {
    const s = await h.serve((_q, res) => json(res, 200, { a: 1 }, { "content-type": "application/vnd.api+json" }));
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const res = await api.handleRoute(new Request("http://app.test/x"), { endpoint: "/u" });
    expect(res.headers.get("content-type")).toBe("application/vnd.api+json");
  });

  it("#24 Next forwards allow-listed request headers", async () => {
    const s = await h.serve((req, res) =>
      json(res, 200, { lang: req.headers["accept-language"] ?? null, cookie: req.headers.cookie ?? null }),
    );
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const req = new Request("http://app.test/x", { headers: { "accept-language": "fa-IR", cookie: "a=b" } });
    expect(await (await api.handleRoute(req, { endpoint: "/u", forwardRequestHeaders: ["accept-language"] })).json()).toEqual({
      lang: "fa-IR",
      cookie: null,
    });
  });

  it("#25 Vary and must-revalidate are honoured", async () => {
    let n = 0;
    const s = await h.serve((req, res) => {
      if (req.url === "/v") return json(res, 200, { lang: req.headers["accept-language"], n: ++n }, { vary: "Accept-Language" });
      res.writeHead(n++ === 0 ? 200 : 503, { "content-type": "application/json", "cache-control": "max-age=0, must-revalidate" });
      res.end('{"ok":1}');
    });
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      defaultHeaders: { "Accept-Language": "fa" },
      cache: { enabled: true, staleIfError: true, respectCacheControl: true },
    });
    await api.get("/v");
    expect((await api.get("/v")).meta?.cached).toBe(true);

    const api2 = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      retryLimit: 0,
      cache: { enabled: true, staleIfError: true, respectCacheControl: true },
    });
    n = 0;
    expect((await api2.get("/m")).ok).toBe(true);
    expect(await api2.get("/m")).toMatchObject({ ok: false, status: 503 }); // no stale-if-error for must-revalidate
  });

  it("#26 MemoryCacheStore is bounded by bytes", () => {
    const store = new MemoryCacheStore({ maxSizeBytes: 10_000 });
    const entry = (n: number) => ({ status: 200, body: "x".repeat(n), headers: {}, storedAt: 0, expiresAt: Date.now() + 1e6 });
    for (let i = 0; i < 10; i++) store.set(`k${i}`, entry(1000), 1e6);
    expect(store.sizeBytes).toBeLessThanOrEqual(10_000);
    expect(store.get("k0")).toBeUndefined();
    expect(store.get("k9")).toBeDefined();
  });

  it("#27 metrics: request-level and upstream counters are distinct; Prometheus export", async () => {
    const s = await h.serve((req, res) => (req.url === "/bad" ? json(res, 500, {}) : json(res, 200, {})));
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      retryLimit: 1,
      retry: { baseDelayMs: 1, jitter: 0 },
      cache: { enabled: true },
    });
    await api.get("/ok");
    await api.get("/ok"); // cache hit
    await api.get("/bad");
    const m = api.getMetrics()!;
    expect(m).toMatchObject({
      totalRequests: 3,
      successCount: 2,
      errorCount: 1,
      upstreamRequests: 3,
      upstreamErrors: 2,
      cacheHits: 1,
    });
    expect(m.byErrorCode).toEqual({ HTTP_ERROR: 1 });
    const text = toPrometheus(m);
    expect(text).toContain("got_api_engine_requests_total 3");
    expect(api.metricsText()).toContain('service="got-api-engine"');
  });

  it("#29 a provider with refreshNow() is refreshed automatically after a 401", async () => {
    let issued = 0;
    const s = await h.serve((req, res) => (req.headers.authorization === "Bearer t2" ? json(res, 200, {}) : json(res, 401, {})));
    const auth = createRefreshableAuth({ refresh: async () => `t${++issued}` });
    const api = h.engine({ baseUrl: s.url, auth });
    expect((await api.get("/x")).ok).toBe(true);
    expect(issued).toBe(2);
  });

  it("#37 primitive and null bodies are JSON; a schema with a non-JSON body is rejected", async () => {
    const s = await h.serve((req, res, ctx) => json(res, 200, { body: ctx.body, ct: req.headers["content-type"] }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    expect(await api.post("/x", 5)).toMatchObject({ data: { body: "5", ct: "application/json" } });
    expect(await api.post("/x", null)).toMatchObject({ data: { body: "null" } });
    expect(await api.post("/x", "raw", { schema: numberV as never })).toMatchObject({ ok: false, code: "REQUEST_INVALID" });
  });

  it("#22 there is a default overall deadline", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(400);
      json(res, 200, {});
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, totalTimeoutMs: 100 });
    expect(await api.get("/x")).toMatchObject({ ok: false, code: "TIMEOUT", status: 504 });
  });
});
