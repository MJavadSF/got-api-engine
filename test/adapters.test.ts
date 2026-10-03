import { afterEach, describe, expect, it } from "vitest";
import {
  ApiKeyAuthProvider,
  BasicAuthProvider,
  BatchRequestError,
  batchRequests,
  createEngine,
  createRefreshableAuth,
  withRetry,
  type ApiResult,
  type GotApiEngine,
} from "../src/index";
import { createNextEngine, type NextApiEngine } from "../src/adapters/next";
import { json, sleep, startServer, type TestServer } from "./server";

const servers: TestServer[] = [];
const engines: GotApiEngine[] = [];
async function serve(h: Parameters<typeof startServer>[0]) {
  const s = await startServer(h);
  servers.push(s);
  return s;
}
function next(cfg: Parameters<typeof createNextEngine>[0]): NextApiEngine {
  const e = createNextEngine({ logLevel: "silent", ...cfg });
  engines.push(e);
  return e;
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("auth providers", () => {
  it("ApiKeyAuthProvider sends the key in its own header (used to become 'Bearer ApiKey …')", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = createEngine({ baseUrl: s.url, logLevel: "silent", auth: new ApiKeyAuthProvider("k-123") });
    engines.push(api);
    expect((await api.get("/x")).ok).toBe(true);
    expect(s.requests[0]!.headers["x-api-key"]).toBe("k-123");
    expect(s.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("BasicAuthProvider builds a Basic header that is not re-prefixed with Bearer", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = createEngine({ baseUrl: s.url, logLevel: "silent", auth: new BasicAuthProvider("user", "pass") });
    engines.push(api);
    await api.get("/x");
    expect(s.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("RefreshableAuthProvider caches until expiry and refreshes single-flight", async () => {
    let n = 0;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = (i: number) => `h.${Buffer.from(JSON.stringify({ exp, i })).toString("base64url")}.s`;
    const auth = createRefreshableAuth({
      refresh: async () => {
        n++;
        await sleep(10);
        return jwt(n);
      },
    });
    const [a, b, c] = await Promise.all([auth.getAuthHeader(), auth.getAuthHeader(), auth.getAuthHeader()]);
    expect(n).toBe(1);
    expect(new Set([a, b, c]).size).toBe(1);
    await auth.getAuthHeader();
    expect(n).toBe(1); // cached (JWT exp read from the token)
    auth.invalidate();
    await auth.getAuthHeader();
    expect(n).toBe(2);
  });
});

describe("next adapter: handleRoute", () => {
  const req = (url: string, init?: RequestInit) => new Request(`http://app.test${url}`, init);

  it("proxies JSON, forwards the query string for every method and the caller's Authorization", async () => {
    const s = await serve((r, res, ctx) => json(res, 200, { url: r.url, auth: r.headers.authorization, body: ctx.body }));
    const api = next({ baseUrl: s.url });
    const res = await api.handleRoute(
      req("/api/items?x=1&y=2", { method: "POST", headers: { authorization: "Bearer u", "content-type": "application/json" }, body: '{"a":1}' }),
      { endpoint: "/items", method: "POST" },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url: string; auth: string; body: string };
    expect(data.url).toBe("/items?x=1&y=2");
    expect(data.auth).toBe("Bearer u");
    expect(JSON.parse(data.body)).toEqual({ a: 1 });
    expect(res.headers.get("x-request-id")).toBeTruthy();

    const del = await api.handleRoute(req("/api/items?force=1", { method: "DELETE", headers: { authorization: "Bearer u" } }), {
      endpoint: "/items/1",
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(s.requests[1]!.url).toBe("/items/1?force=1");
  });

  it("401 without Authorization, and never falls back to engine credentials by default", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = next({ baseUrl: s.url, auth: "SERVICE-TOKEN" });
    const res = await api.handleRoute(req("/api/x"), { endpoint: "/x" });
    expect(res.status).toBe(401);
    expect(s.hits).toBe(0);

    const opt = await api.handleRoute(req("/api/x"), { endpoint: "/x", useEngineAuth: true });
    expect(opt.status).toBe(200);
    expect(s.requests[0]!.headers.authorization).toBe("Bearer SERVICE-TOKEN");
  });

  it("proxies non-JSON bodies verbatim (they were silently dropped before)", async () => {
    const s = await serve((r, res, ctx) => json(res, 200, { ct: r.headers["content-type"], body: ctx.body }));
    const api = next({ baseUrl: s.url, defaultAuth: false });
    const res = await api.handleRoute(
      req("/api/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "just text" }),
      { endpoint: "/x", method: "POST" },
    );
    const data = (await res.json()) as { ct: string; body: string };
    expect(data).toEqual({ ct: "text/plain", body: "just text" });
  });

  it("empty body with JSON content-type is not an error", async () => {
    const s = await serve((_req, res) => json(res, 200, { ok: true }));
    const api = next({ baseUrl: s.url, defaultAuth: false });
    const res = await api.handleRoute(
      req("/api/x", { method: "DELETE", headers: { "content-type": "application/json" } }),
      { endpoint: "/x", method: "DELETE" },
    );
    expect(res.status).toBe(200);
  });

  it("400 on malformed JSON and on schema failure (with details)", async () => {
    const s = await serve((_req, res) => json(res, 200, {}));
    const api = next({ baseUrl: s.url, defaultAuth: false });
    const bad = await api.handleRoute(
      req("/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" }),
      { endpoint: "/x", method: "POST" },
    );
    expect(bad.status).toBe(400);

    const schema = { safeParse: () => ({ success: false as const, error: { issues: [{ message: "required" }] } }) };
    const inv = await api.handleRoute(
      req("/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      { endpoint: "/x", method: "POST", schema },
    );
    expect(inv.status).toBe(400);
    expect(((await inv.json()) as { details: unknown }).details).toEqual([{ message: "required" }]);
  });

  it("passes binary and text responses through with their content-type, plus allow-listed headers", async () => {
    const s = await serve((r, res) => {
      if (r.url === "/bin") {
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="a.pdf"', "set-cookie": "sid=1" });
        return void res.end(Buffer.from([37, 80, 68, 70, 0, 255]));
      }
      res.writeHead(200, { "content-type": "text/csv" });
      res.end("a,b\n1,2");
    });
    const api = next({ baseUrl: s.url, defaultAuth: false });
    const bin = await api.handleRoute(req("/api/bin"), { endpoint: "/bin" });
    expect(bin.headers.get("content-type")).toBe("application/pdf");
    expect(bin.headers.get("content-disposition")).toContain("a.pdf");
    expect(bin.headers.get("set-cookie")).toBeNull();
    expect([...new Uint8Array(await bin.arrayBuffer())]).toEqual([37, 80, 68, 70, 0, 255]);

    const csv = await api.handleRoute(req("/api/csv"), { endpoint: "/csv" });
    expect(csv.headers.get("content-type")).toBe("text/csv");
    expect(await csv.text()).toBe("a,b\n1,2");
  });

  it("204 is a null-body Response (Response.json(…, 204) would throw)", async () => {
    const s = await serve((_req, res) => void res.writeHead(204).end());
    const api = next({ baseUrl: s.url, defaultAuth: false });
    const res = await api.handleRoute(req("/api/x", { method: "DELETE" }), { endpoint: "/x", method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("forwards upstream 4xx details but hides 5xx internals by default", async () => {
    const s = await serve((r, res) =>
      r.url === "/four" ? json(res, 422, { message: "bad", fields: { a: "x" } }) : json(res, 500, { message: "boom", stack: "secret at /srv/app.js" }),
    );
    const api = next({ baseUrl: s.url, defaultAuth: false, retry: { limit: 0 } });
    const four = await api.handleRoute(req("/api/x"), { endpoint: "/four" });
    expect(four.status).toBe(422);
    expect(((await four.json()) as any).details.fields).toEqual({ a: "x" });

    const five = await api.handleRoute(req("/api/x"), { endpoint: "/five" });
    expect(five.status).toBe(500);
    const body = (await five.json()) as Record<string, unknown>;
    expect(body.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("propagates an incoming X-Request-Id and exposes Retry-After on 429", async () => {
    const s = await serve((_req, res) => json(res, 429, { message: "slow down" }, { "retry-after": "120" }));
    const api = next({ baseUrl: s.url, defaultAuth: false, requestIdHeader: "X-Request-Id" });
    const res = await api.handleRoute(req("/api/x", { headers: { "x-request-id": "abc-1" } }), { endpoint: "/x" });
    expect(res.status).toBe(429);
    expect(res.headers.get("x-request-id")).toBe("abc-1");
    expect(res.headers.get("retry-after")).toBe("120");
    expect(s.requests[0]!.headers["x-request-id"]).toBe("abc-1");
  });

  it("serverAction injects a session token (access_token and accessToken)", async () => {
    const s = await serve((r, res) => json(res, 200, { auth: r.headers.authorization }));
    const api = next({ baseUrl: s.url });
    const a = await api.serverGet<{ auth: string }>("/me", { session: { access_token: "snake" } });
    const b = await api.serverGet<{ auth: string }>("/me", { session: { accessToken: "camel" } });
    expect(a.ok && a.data.auth).toBe("Bearer snake");
    expect(b.ok && b.data.auth).toBe("Bearer camel");
  });

  it("extend() on a NextApiEngine returns a NextApiEngine", () => {
    const api = next({ baseUrl: "https://api.example.test" });
    const child = api.extend({ timeoutMs: 1 });
    engines.push(child);
    expect(typeof child.handleRoute).toBe("function");
  });
});

describe("batchRequests", () => {
  it("returns results by key and respects concurrency", async () => {
    let active = 0;
    let peak = 0;
    const s = await serve(async (_req, res) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      json(res, 200, { ok: true });
    });
    const api = createEngine({ baseUrl: s.url, defaultAuth: false, logLevel: "silent" });
    engines.push(api);
    const out = await batchRequests(
      api,
      Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, options: { endpoint: `/${i}` } })),
      { concurrency: 2 },
    );
    expect(Object.keys(out)).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("failFast stops unstarted requests, aborts in-flight ones and throws BatchRequestError", async () => {
    const s = await serve(async (r, res) => {
      if (r.url === "/bad") return json(res, 500, { message: "kaput" });
      await sleep(200);
      json(res, 200, {});
    });
    const api = createEngine({ baseUrl: s.url, defaultAuth: false, logLevel: "silent", retry: { limit: 0 } });
    engines.push(api);
    const t0 = Date.now();
    const err = await batchRequests(
      api,
      [
        { key: "bad", options: { endpoint: "/bad" } },
        { key: "slow", options: { endpoint: "/slow" } },
        { key: "later1", options: { endpoint: "/later1" } },
        { key: "later2", options: { endpoint: "/later2" } },
      ],
      { concurrency: 2, failFast: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchRequestError);
    expect((err as BatchRequestError).key).toBe("bad");
    expect(Date.now() - t0).toBeLessThan(150); // the slow in-flight request was aborted, not awaited
    expect(s.requests.some((q) => q.url === "/later1" || q.url === "/later2")).toBe(false);
  });

  it("non-failFast completes everything; '__proto__' keys are safe; duplicate keys are rejected", async () => {
    const s = await serve((r, res) => (r.url === "/bad" ? json(res, 500, {}) : json(res, 200, {})));
    const api = createEngine({ baseUrl: s.url, defaultAuth: false, logLevel: "silent", retry: { limit: 0 } });
    engines.push(api);
    const out = await batchRequests(api, [
      { key: "__proto__", options: { endpoint: "/ok" } },
      { key: "b", options: { endpoint: "/bad" } },
    ]);
    expect(Object.keys(out)).toEqual(["__proto__", "b"]);
    expect(out["__proto__"]!.ok).toBe(true);
    expect(out["b"]!.ok).toBe(false);
    await expect(
      batchRequests(api, [
        { key: "a", options: { endpoint: "/1" } },
        { key: "a", options: { endpoint: "/2" } },
      ]),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("withRetry", () => {
  const fail = (status: number, code?: string): ApiResult<number> => ({ ok: false, error: "x", status, ...(code ? { code } : {}) });

  it("retries transient failures with backoff and stops on success", async () => {
    let calls = 0;
    const seen: number[] = [];
    const r = await withRetry<number>(async (attempt) => {
      seen.push(attempt);
      return ++calls < 3 ? fail(503) : { ok: true as const, data: 1, status: 200 };
    }, { baseDelayMs: 1, jitter: 0 });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("does not retry 501, 4xx, aborts or validation errors", async () => {
    for (const f of [fail(501), fail(404), fail(499, "ABORTED"), fail(400, "REQUEST_VALIDATION")]) {
      let calls = 0;
      await withRetry(async () => (calls++, f), { baseDelayMs: 1 });
      expect(calls).toBe(1);
    }
  });

  it("is abortable during backoff", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await withRetry(async () => fail(503), { baseDelayMs: 5_000, maxDelayMs: 5_000, signal: ac.signal });
    expect(r).toMatchObject({ ok: false, code: "ABORTED" });
  });
});
