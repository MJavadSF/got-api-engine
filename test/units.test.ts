// Unit tests for small building blocks.
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resourceOf, resourceOfKey } from "../src/cache/cache-key";
import { BackgroundTasks } from "../src/core/background";
import { classifyTransportError, findInChain, isAbortError, ResponseTooLargeError } from "../src/errors/classify";
import { createMessageResolver } from "../src/errors/messages";
import { parseLinkHeader, parseRateLimitHeaders } from "../src/http/directives";
import {
  ApiError,
  Bulkhead,
  createBasicAuth,
  createBrowserStorageAuth,
  createConsoleLogger,
  createDynamicAuth,
  createLogger,
  createNextAuthProvider,
  createStaticAuth,
  RetryBudget,
  toCurl,
} from "../src/index";
import { HookRunner } from "../src/observability/hooks";
import { sendHedged } from "../src/pipeline/hedge";
import type { AttemptRequest, AttemptResponse } from "../src/pipeline/transport";
import { SsrfError } from "../src/security/ssrf";
import { useHarness } from "./harness";
import { json, sleep } from "./server";

const h = useHarness();

describe("auth providers", () => {
  it("static / dynamic / next-auth / basic / storage", async () => {
    expect(createStaticAuth("abc").getAuthHeader()).toBe("Bearer abc");
    expect(await createDynamicAuth(async () => "Token x").getAuthHeader()).toBe("Token x");
    expect(await createDynamicAuth(() => null).getAuthHeader()).toBeNull();
    expect(await createNextAuthProvider(() => ({ accessToken: "s" })).getAuthHeader()).toBe("Bearer s");
    expect(createBasicAuth("u", "p").getAuthHeader()).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    expect(() => createBasicAuth("a:b", "p")).toThrow(/RFC 7617/);
    (globalThis as Record<string, unknown>)["sessionStorage"] = { getItem: () => "st" };
    expect(createBrowserStorageAuth("k", "sessionStorage").getAuthHeader()).toBe("Bearer st");
    delete (globalThis as Record<string, unknown>)["sessionStorage"];
    expect(createBrowserStorageAuth("k", "sessionStorage").getAuthHeader()).toBeNull();
  });
});

describe("logger", () => {
  it("console logger respects level and child meta", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const log = createConsoleLogger("svc", false, "warn");
    log.debug("hidden");
    log.child?.({ requestId: "r1" }).warn("shown", { a: 1 });
    expect(debug).not.toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatch(/WARN {2}\[svc] shown {"requestId":"r1","a":1}/);
    spy.mockRestore();
    debug.mockRestore();
  });

  it("createLogger uses winston when installed", async () => {
    const log = await createLogger("svc", false, false, "silent");
    expect(typeof log.child).toBe("function");
    log.info("quiet");
  });
});

describe("errors", () => {
  it("classifies transport errors", () => {
    const wrap = (e: Error) => Object.assign(new Error("wrapped"), { cause: e });
    expect(classifyTransportError(wrap(new SsrfError("x"))).code).toBe("SSRF_BLOCKED");
    expect(classifyTransportError(new ResponseTooLargeError(1)).code).toBe("RESPONSE_TOO_LARGE");
    expect(classifyTransportError(Object.assign(new Error("t"), { code: "ETIMEDOUT" }))).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    expect(classifyTransportError(Object.assign(new Error("c"), { code: "ERR_INVALID_CHAR" }))).toMatchObject({
      code: "REQUEST_INVALID",
      circuit: "neutral",
    });
    expect(classifyTransportError("boom")).toMatchObject({ code: "NETWORK_ERROR" });
    expect(isAbortError(wrap(new DOMException("a", "AbortError")))).toBe(true);
    expect(findInChain(wrap(new SsrfError("y")), (e): e is SsrfError => e instanceof SsrfError)?.message).toBe("y");
  });

  it("message catalogs and ApiError helpers", () => {
    const m = createMessageResolver({ TIMEOUT: "slow" });
    expect(m("TIMEOUT")).toBe("slow");
    expect(m("ABORTED")).toBe("Request aborted.");
    const e = new ApiError({ ok: false, error: "x", status: 504, code: "TIMEOUT" });
    expect(e.is("TIMEOUT")).toBe(true);
  });
});

describe("helpers", () => {
  it("cache keys, links and rate-limit headers", () => {
    expect(resourceOf("http://a.test/x/y?z=1")).toBe("http://a.test/x/y");
    expect(resourceOfKey("GET http://a.test/x?q=abc|f|v")).toBe("http://a.test/x");
    expect(resourceOfKey("garbage")).toBeUndefined();
    expect(parseLinkHeader('<a?p=2>; rel="next", <a?p=9>; rel="last prev"')).toEqual({
      next: "a?p=2",
      last: "a?p=9",
      prev: "a?p=9",
    });
    const now = 1_000_000_000_000;
    const get = (m: Record<string, string>) => (n: string) => m[n];
    expect(parseRateLimitHeaders(get({ ratelimit: '"d";r=0;t=7' }), now)).toEqual({ remaining: 0, resetMs: 7000 });
    expect(
      parseRateLimitHeaders(get({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 5) }), now),
    ).toEqual({
      remaining: 0,
      resetMs: 5000,
    });
    expect(parseRateLimitHeaders(get({}), now)).toBeNull();
  });

  it("toCurl handles form and stream bodies", () => {
    expect(toCurl({ method: "post", url: "http://x", headers: {}, body: { kind: "form", data: new FormData() } })).toContain(
      "multipart",
    );
    expect(
      toCurl({ method: "put", url: "http://x", headers: { a: "b'c" }, body: { kind: "stream", data: Readable.from([]) } }),
    ).toContain("'a: b'\\''c'");
  });

  it("hook runner swallows hook errors", async () => {
    const warn = vi.fn();
    const runner = new HookRunner(
      { onRetry: [() => Promise.reject(new Error("x"))] },
      { debug() {}, info() {}, warn, error() {} },
    );
    expect(runner.has("onRetry")).toBe(true);
    expect(runner.has("onError")).toBe(false);
    await runner.emit("onRetry", { url: "u", method: "GET", attempt: 1, delayMs: 0, reason: "r" });
    expect(warn).toHaveBeenCalled();
  });

  it("background tasks are tracked, drained and handed to waitUntil", async () => {
    const seen: Array<Promise<unknown>> = [];
    const bg = new BackgroundTasks((p) => void seen.push(p));
    bg.run(sleep(20));
    bg.run(Promise.reject(new Error("ignored")));
    expect(bg.size).toBe(2);
    await bg.drain(1000);
    expect(bg.size).toBe(0);
    expect(seen).toHaveLength(2);
    await new BackgroundTasks(() => {
      throw new Error("outside request scope");
    }).drain();
  });
});

describe("resilience units", () => {
  it("retry budget floors and ratios", () => {
    const b = new RetryBudget({ ratio: 0.5, minPerSec: 0, windowMs: 1000 });
    expect(b.tryRetry(0)).toBe(false);
    for (let i = 0; i < 4; i++) b.recordRequest(0);
    expect([b.tryRetry(0), b.tryRetry(0), b.tryRetry(0)]).toEqual([true, true, false]);
    expect(b.tryRetry(5000)).toBe(false); // window rolled: no traffic, no floor
  });

  it("adaptive bulkhead shrinks on overload and recovers", async () => {
    const b = new Bulkhead({ max: 10, adaptive: { min: 2 } });
    for (let i = 0; i < 30; i++) (await b.acquire())("overload");
    expect(b.currentLimit).toBe(2);
    for (let i = 0; i < 200; i++) (await b.acquire())("success");
    expect(b.currentLimit).toBe(10);
    const ctl = new AbortController();
    const holders = await Promise.all(Array.from({ length: 10 }, () => b.acquire()));
    const waiting = b.acquire(ctl.signal);
    expect(b.pending).toBe(1);
    ctl.abort();
    await expect(waiting).rejects.toThrow();
    for (const r of holders) r();
    expect(b.active).toBe(0);
    b.dispose();
  });

  it("hedging falls back to the primary when no capacity / when the primary fails fast", async () => {
    const req = { url: "u", signal: new AbortController().signal } as AttemptRequest;
    const ok = (status: number): AttemptResponse => ({ status, headers: {}, body: Buffer.alloc(0), timings: undefined });
    const slowSend = async (r: AttemptRequest) => {
      await sleep(r.url === "u" ? 50 : 5);
      return ok(200);
    };
    expect((await sendHedged(slowSend, req, { delayMs: () => 5, prepare: () => null })).hedged).toBe(false);
    expect((await sendHedged(slowSend, req, { delayMs: () => undefined, prepare: () => null })).hedged).toBe(false);
    await expect(
      sendHedged(() => Promise.reject(new Error("fast fail")), req, { delayMs: () => 50, prepare: () => null }),
    ).rejects.toThrow("fast fail");
    const bothFail = (r: AttemptRequest) => sleep(r.url === "u" ? 30 : 5).then(() => Promise.reject(new Error(r.url)));
    await expect(
      sendHedged(bothFail, req, {
        delayMs: () => 5,
        prepare: () => ({ request: { ...req, url: "h" }, release: () => undefined }),
      }),
    ).rejects.toThrow("u");
  });
});

describe("Next adapter helpers", () => {
  it("server action shorthands and buildRouteHandlers", async () => {
    const s = await h.serve((req, res, ctx) =>
      json(res, 200, { m: req.method, auth: req.headers.authorization ?? null, body: ctx.body }),
    );
    const api = h.next({ baseUrl: s.url, defaultAuth: "optional" });
    expect(await api.serverGet("/x", { session: { access_token: "a" } })).toMatchObject({ data: { m: "GET", auth: "Bearer a" } });
    expect(await api.serverPut("/x", { a: 1 })).toMatchObject({ data: { m: "PUT" } });
    expect(await api.serverPatch("/x", { a: 1 })).toMatchObject({ data: { m: "PATCH" } });
    expect(await api.serverDelete("/x")).toMatchObject({ data: { m: "DELETE" } });
    expect(await api.serverPost("/x", { a: 1 })).toMatchObject({ data: { m: "POST", body: '{"a":1}' } });
    const routes = api.buildRouteHandlers();
    expect((await routes.GET(new Request("http://app.test/x"), "/x")).status).toBe(200);
    const put = await routes.PUT(
      new Request("http://app.test/x", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"b":2}' }),
      {
        endpoint: "/x",
      },
    );
    expect(await put.json()).toMatchObject({ m: "PUT", body: '{"b":2}' });
  });

  it("mapError, multipart bodies and malformed JSON", async () => {
    const s = await h.serve((req, res, ctx) =>
      req.url === "/fail" ? json(res, 500, {}) : json(res, 200, { ct: req.headers["content-type"], len: ctx.body.length }),
    );
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const mapped = await api.handleRoute(new Request("http://app.test/x"), {
      endpoint: "/fail",
      mapError: (e) => ({ status: 418, body: { teapot: e.status } }),
    });
    expect([mapped.status, await mapped.json()]).toEqual([418, { teapot: 500 }]);
    const form = new FormData();
    form.append("f", new Blob(["hello"]), "a.txt");
    const multipart = await api.handleRoute(new Request("http://app.test/x", { method: "POST", body: form }), {
      endpoint: "/up",
      method: "POST",
    });
    expect(((await multipart.json()) as { ct: string }).ct).toMatch(/^multipart\/form-data; boundary=/);
    const bad = await api.handleRoute(
      new Request("http://app.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
      {
        endpoint: "/x",
        method: "POST",
      },
    );
    expect(bad.status).toBe(400);
  });
});

describe("MemoryCacheStore resource index", () => {
  it("invalidates all variants of a resource and stays consistent under eviction", async () => {
    const { MemoryCacheStore } = await import("../src/cache/memory-store");
    const store = new MemoryCacheStore({ maxEntries: 3 });
    const e = { status: 200, body: 1, headers: {}, storedAt: 0, expiresAt: Date.now() + 1e6 };
    store.set("GET http://a/x||", e, 1e6);
    store.set("GET http://a/x?q=1||", e, 1e6);
    store.set("GET http://a/y||", e, 1e6);
    store.set("GET http://a/z||", e, 1e6); // evicts the oldest x variant
    store.deleteByResources(["http://a/x"]);
    expect(store.get("GET http://a/x?q=1||")).toBeUndefined();
    expect(store.get("GET http://a/y||")).toBeDefined();
    expect(store.size).toBe(2);
    store.deleteByResources(["http://a/missing"]);
    expect(store.size).toBe(2);
  });
});
