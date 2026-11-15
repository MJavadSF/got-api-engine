// Value-add features (v4).

import { gunzipSync } from "node:zlib";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApiError,
  type ApiResult,
  createBatcher,
  defineEndpoint,
  isApiError,
  type Middleware,
  mapResult,
  unwrap,
} from "../src/index";
import { numberV, standardName, useHarness } from "./harness";
import { json, sleep } from "./server";

const h = useHarness();

describe("middleware", () => {
  it("runs in order, can edit headers, observe results and short-circuit", async () => {
    const s = await h.serve((req, res) => json(res, 200, { tag: req.headers["x-tag"] }));
    const order: string[] = [];
    const tag: Middleware = async (ctx, next) => {
      order.push("a-in");
      ctx.headers["X-Tag"] = "mw";
      const r = await next();
      order.push("a-out");
      return r;
    };
    const short: Middleware = async (ctx, next) =>
      ctx.url.endsWith("/cached") ? { ok: true, data: "from-mw", status: 200 } : next();
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, middleware: [tag] }).use(short);
    expect(await api.get("/x")).toMatchObject({ data: { tag: "mw" } });
    expect(await api.get("/cached")).toMatchObject({ data: "from-mw" });
    expect(order).toEqual(["a-in", "a-out", "a-in", "a-out"]);
    expect(s.hits).toBe(1);
  });

  it("extend() keeps middleware added with use()", async () => {
    const s = await h.serve((req, res) => json(res, 200, { tag: req.headers["x-tag"] ?? null }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false }).use(async (ctx, next) => {
      ctx.headers["X-Tag"] = "1";
      return next();
    });
    const child = h.track(api.extend({ timeoutMs: 5000 }));
    expect(await child.get("/x")).toMatchObject({ data: { tag: "1" } });
  });
});

describe("typed endpoints + schemas", () => {
  it("fills / encodes path params, sends query + body, validates with Standard Schema", async () => {
    const s = await h.serve((req, res, ctx) => json(res, 200, { url: req.url, body: JSON.parse(ctx.body || "null") }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const update = api.endpoint(
      defineEndpoint({ method: "PUT", path: "/users/:id/posts/:postId", body: standardName as never, response: undefined }),
    );
    const r = await update({ path: { id: "a/b", postId: 7 }, query: { draft: true }, body: { name: "  Ali  " } as never });
    expect(r).toMatchObject({ ok: true, data: { url: "/users/a%2Fb/posts/7?draft=true", body: { name: "Ali" } } });
    expect(update.url({ path: { id: 1, postId: 2 } })).toBe("/users/1/posts/2");
    expect(await update({ path: { id: "..", postId: 1 }, body: {} as never })).toMatchObject({ ok: false, code: "INVALID_URL" });
    expect(await update({ path: { id: 1, postId: 1 }, body: { nope: 1 } as never })).toMatchObject({
      ok: false,
      code: "REQUEST_VALIDATION",
      details: [{ message: "name is required", path: ["name"] }],
    });
  });

  it("infers types and gives TanStack Query options", async () => {
    const s = await h.serve((_q, res) => json(res, 200, { v: 3 }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const getThing = api.endpoint(defineEndpoint({ path: "/things/:id", response: numberV }));
    const r = await getThing({ path: { id: 1 } });
    expectTypeOf(r).toEqualTypeOf<ApiResult<{ v: number }>>();
    const q = getThing.queryOptions({ path: { id: 1 } });
    expect(q.queryKey).toEqual(["GET", "/things/:id", { id: 1 }, {}]);
    expect(await q.queryFn({})).toEqual({ v: 3 });
    expect(api.getMetrics()?.byRoute["GET /things/:id"]?.requests).toBe(2);
  });

  it("bindEndpoints binds a whole record (codegen output)", async () => {
    const s = await h.serve((req, res) => json(res, 200, { url: req.url }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const client = api.endpoints({ ping: { method: "GET", path: "/ping/:n" } as const });
    expect(await client.ping({ path: { n: 1 } })).toMatchObject({ data: { url: "/ping/1" } });
  });
});

describe("result ergonomics", () => {
  it("throwOnError, requestData, unwrap, isApiError, mapResult", async () => {
    const s = await h.serve((req, res) =>
      req.url === "/bad" ? json(res, 404, { message: "missing" }) : json(res, 200, { v: 1 }),
    );
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    await expect(api.get("/bad", { throwOnError: true })).rejects.toBeInstanceOf(ApiError);
    await expect(api.requestData({ endpoint: "/bad" })).rejects.toMatchObject({
      status: 404,
      code: "HTTP_ERROR",
      message: "missing",
    });
    expect(await api.requestData<{ v: number }>({ endpoint: "/ok" })).toEqual({ v: 1 });
    const bad = await api.get("/bad");
    expect(isApiError(bad, "HTTP_ERROR")).toBe(true);
    expect(isApiError(bad, "TIMEOUT")).toBe(false);
    expect(() => unwrap(bad)).toThrow(ApiError);
    expect(mapResult(await api.get<{ v: number }>("/ok"), (d) => d.v + 1)).toMatchObject({ data: 2 });
  });

  it("transformKeys converts snake_case ⇄ camelCase", async () => {
    const s = await h.serve((_q, res, ctx) =>
      json(res, 200, { raw_body: ctx.body, user_name: "x", nested_list: [{ created_at: 1 }] }),
    );
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, transformKeys: { request: "snake", response: "camel" } });
    const r = await api.post<Record<string, unknown>>("/x", { firstName: "a", homeAddress: { zipCode: 1 } });
    expect(r).toMatchObject({
      data: { rawBody: '{"first_name":"a","home_address":{"zip_code":1}}', userName: "x", nestedList: [{ createdAt: 1 }] },
    });
  });

  it("Persian messages for engine errors", async () => {
    const api = h.engine({ baseUrl: "http://127.0.0.1:1", messages: "fa" });
    expect(await api.get("/x")).toMatchObject({ code: "AUTH_REQUIRED", error: "برای این کار باید وارد حساب کاربری شوید." });
    expect(await api.get("/x", { auth: false, retry: false })).toMatchObject({
      code: "NETWORK_ERROR",
      error: "ارتباط با سرور برقرار نشد.",
      details: { cause: expect.stringContaining("ECONNREFUSED") },
    });
  });

  it("fallback turns failures into successes (flagged in meta)", async () => {
    const api = h.engine({ baseUrl: "http://127.0.0.1:1", defaultAuth: false, retryLimit: 0 });
    const r = await api.get<string[]>("/x", { fallback: () => ["default"] });
    expect(r).toMatchObject({ ok: true, data: ["default"], meta: { fallback: true, fallbackFrom: "NETWORK_ERROR" } });
    expect(api.getMetrics()?.fallbackServed).toBe(1);
  });
});

describe("resilience", () => {
  it("retry budget caps retries during an outage", async () => {
    const s = await h.serve((_q, res) => json(res, 503, {}));
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      retry: { limit: 3, baseDelayMs: 1, jitter: 0, budget: { ratio: 0, minPerSec: 0.2, windowMs: 10_000 } },
    });
    await Promise.all(Array.from({ length: 5 }, () => api.get("/x")));
    // 5 first tries + at most 2 budgeted retries (0.2/s × 10 s)
    expect(s.hits).toBeLessThanOrEqual(7);
    expect(api.getMetrics()?.retryCount).toBeLessThanOrEqual(2);
  });

  it("bulkhead caps concurrent upstream attempts", async () => {
    let active = 0;
    let peak = 0;
    const s = await h.serve(async (_q, res) => {
      peak = Math.max(peak, ++active);
      await sleep(30);
      active--;
      json(res, 200, {});
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, dedupe: false, concurrency: { max: 2 } });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => api.get(`/x${i}`)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });

  it("bulkhead rejects when the queue is full", async () => {
    const s = await h.serve(async (_q, res) => {
      await sleep(50);
      json(res, 200, {});
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, dedupe: false, concurrency: { max: 1, maxQueue: 1 } });
    const rs = await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(rs.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ok", "ok", "CONCURRENCY_LIMITED"]);
  });

  it("hedging answers from the faster attempt", async () => {
    let n = 0;
    const s = await h.serve(async (_q, res) => {
      const slow = ++n === 1;
      await sleep(slow ? 400 : 10);
      json(res, 200, { slow });
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, hedge: { afterMs: 30 } });
    const started = Date.now();
    const r = await api.get<{ slow: boolean }>("/x");
    expect(r).toMatchObject({ ok: true, data: { slow: false }, meta: { hedged: true } });
    expect(Date.now() - started).toBeLessThan(300);
    expect(api.getMetrics()?.hedgeCount).toBe(1);
  });

  it("adaptive rate limiting pauses when upstream quota is exhausted", async () => {
    let n = 0;
    const s = await h.serve((_q, res) =>
      json(res, 200, { n: ++n }, n === 1 ? { "ratelimit-remaining": "0", "ratelimit-reset": "1" } : {}),
    );
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      dedupe: false,
      rateLimit: { enabled: true, requestsPerInterval: 100, adaptive: true },
    });
    await api.get("/a");
    const t = Date.now();
    await api.get("/b");
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });

  it("fails over to the next upstream and remembers unhealthy ones", async () => {
    const good = await h.serve((_q, res) => json(res, 200, { who: "b" }));
    const api = h.engine({ baseUrl: ["http://127.0.0.1:1", good.url], defaultAuth: false, retry: { limit: 1, baseDelayMs: 1 } });
    const r = await api.get<{ who: string }>("/x");
    expect(r).toMatchObject({ ok: true, data: { who: "b" }, meta: { attempts: 2, upstream: new URL(good.url).origin } });
    const r2 = await api.get("/y");
    expect(r2.meta?.attempts).toBe(1); // primary is in cooldown
    expect((await api.health()).upstreams.map((u) => u.healthy)).toEqual([false, true]);
  });

  it("round-robin spreads requests", async () => {
    const a = await h.serve((_q, res) => json(res, 200, { who: "a" }));
    const b = await h.serve((_q, res) => json(res, 200, { who: "b" }));
    const api = h.engine({ baseUrl: [a.url, b.url], upstreamStrategy: "round-robin", defaultAuth: false, dedupe: false });
    for (let i = 0; i < 4; i++) await api.get(`/x${i}`);
    expect([a.hits, b.hits]).toEqual([2, 2]);
  });
});

describe("cache features", () => {
  it("tags + invalidateTags (with onInvalidateTags bridge)", async () => {
    let n = 0;
    const s = await h.serve((_q, res) => json(res, 200, { n: ++n }));
    const seen: string[][] = [];
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      cache: { enabled: true },
      onInvalidateTags: (t) => void seen.push(t),
    });
    await api.get("/a", { cache: { tags: ["users"] } });
    await api.get("/b", { cache: { tags: ["orders"] } });
    await api.invalidateTags("users");
    expect((await api.get("/a")).meta?.cached).toBeUndefined();
    expect((await api.get("/b")).meta?.cached).toBe(true);
    await api.post("/users", {}, { invalidateTags: ["orders"] });
    expect((await api.get("/b")).meta?.cached).toBeUndefined();
    expect(seen).toEqual([["users"], ["orders"]]);
  });

  it("prefetch / warm fill the cache; custom key + shared cache", async () => {
    const s = await h.serve((req, res) => json(res, 200, { url: req.url }));
    const api = h.engine({ baseUrl: s.url, cache: { enabled: true }, auth: "t" });
    await api.warm(["/a", "/b"]);
    expect((await api.get("/a")).meta?.cached).toBe(true);

    const shared = h.engine({
      baseUrl: s.url,
      cache: { enabled: true, shared: true, key: ({ url }) => new URL(url).pathname },
      auth: { getAuthHeader: () => `Bearer ${Math.random()}` },
    });
    await shared.get("/p", { params: { utm_source: "x" } });
    expect((await shared.get("/p", { params: { utm_source: "y" } })).meta?.cached).toBe(true);
  });

  it("copy: freeze returns read-only data without cloning", async () => {
    const s = await h.serve((_q, res) => json(res, 200, { list: [1] }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, copy: "freeze" } });
    await api.get("/x");
    const r = await api.get<{ list: number[] }>("/x");
    expect(r.ok && Object.isFrozen(r.data.list)).toBe(true);
  });
});

describe("transport features", () => {
  it("compresses large request bodies", async () => {
    const s = await h.serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      json(res, 200, { encoding: req.headers["content-encoding"] ?? null });
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, compressRequest: { threshold: 100 } });
    expect(await api.post("/x", { a: "x".repeat(1000) })).toMatchObject({ data: { encoding: "gzip" } });
    expect(await api.post("/x", { a: 1 })).toMatchObject({ data: { encoding: null } });
    expect(gunzipSync).toBeTypeOf("function");
  });

  it("exposes per-phase timings and progress events", async () => {
    const s = await h.serve((_q, res) => json(res, 200, { a: "x".repeat(5000) }));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const progress: number[] = [];
    const r = await api.get("/x", { onDownloadProgress: (p) => progress.push(p.transferred) });
    expect(r.meta?.timings?.total).toBeTypeOf("number");
    expect(progress.at(-1)).toBeGreaterThan(5000);
  });

  it("streams responses as Web streams", async () => {
    const s = await h.serve((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      res.end("data: 2\n\n");
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false });
    const r = await api.get<ReadableStream<Uint8Array>>("/sse", { responseType: "stream" });
    if (!r.ok) throw new Error("expected ok");
    expect(await new Response(r.data).text()).toBe("data: 1\n\ndata: 2\n\n");
  });

  it("toCurl reproduces a request with credentials redacted", async () => {
    const api = h.engine({ baseUrl: "https://api.example.test", auth: "secret" });
    const curl = await api.toCurl({ endpoint: "/users", method: "POST", body: { a: 1 }, params: { q: "x" } });
    expect(curl).toContain("curl -X POST 'https://api.example.test/users?q=x'");
    expect(curl).toContain("'Authorization: [REDACTED]'");
    expect(curl).toContain(`--data-raw '{"a":1}'`);
    expect(curl).not.toContain("secret");
  });

  it("health() reports status and pings", async () => {
    const s = await h.serve((_q, res) => json(res, 200, {}));
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, circuitBreaker: { enabled: true } });
    expect(await api.health({ ping: "/health" })).toMatchObject({ status: "ok", ping: { ok: true, status: 200 } });
    await api.dispose();
    expect((await api.health()).status).toBe("down");
  });
});

describe("pagination and batching", () => {
  it("paginates via Link, cursor and page strategies", async () => {
    const s = await h.serve((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const page = Number(u.searchParams.get("page") ?? u.searchParams.get("cursor") ?? 1);
      if (u.pathname === "/link") {
        const headers: Record<string, string> = page < 3 ? { link: `</api/link?page=${page + 1}>; rel="next"` } : {};
        return json(res, 200, [page], headers);
      }
      if (u.pathname === "/api/link")
        return json(res, 200, [page], page < 3 ? { link: `<link?page=${page + 1}>; rel="next"` } : {});
      if (u.pathname === "/cursor") return json(res, 200, { items: [page], nextCursor: page < 3 ? page + 1 : null });
      json(res, 200, { data: page <= 3 ? [page] : [] });
    });
    const api = h.engine({ baseUrl: `${s.url}/api`, defaultAuth: false });
    const collect = async (it: AsyncIterable<number>) => {
      const out: number[] = [];
      for await (const x of it) out.push(x);
      return out;
    };
    expect(await collect(api.paginate<number>("/link"))).toEqual([1, 2, 3]);

    const root = h.engine({ baseUrl: s.url, defaultAuth: false });
    expect(await collect(root.paginate<number>("/cursor", { strategy: "cursor" }))).toEqual([1, 2, 3]);
    expect(await collect(root.paginate<number>("/page", { strategy: "page" }))).toEqual([1, 2, 3]);
  });

  it("batcher collapses loads into one call per tick", async () => {
    const calls: number[][] = [];
    const users = createBatcher<number, { id: number }>(async (ids) => {
      calls.push([...ids]);
      return ids.map((id) => (id === 3 ? new Error("gone") : { id }));
    });
    const [a, b, a2] = await Promise.all([users.load(1), users.load(2), users.load(1)]);
    expect([a, b, a2]).toEqual([{ id: 1 }, { id: 2 }, { id: 1 }]);
    expect(calls).toEqual([[1, 2]]);
    await expect(users.load(3)).rejects.toThrow("gone");
  });
});
