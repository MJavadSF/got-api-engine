// Next.js BFF features, plugins, stores, testing utilities and codegen.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createProxy, passesCsrf, toFormState } from "../src/adapters/next/index";
import { generateFromOpenApi } from "../src/cli/openapi";
import { awsSigV4, createOAuth2ClientCredentials, hmacSign, otel } from "../src/index";
import { signSigV4 } from "../src/plugins/signing";
import { RedisCacheStore, RedisRateLimiter } from "../src/stores/redis";
import { createMockEngine, recorder } from "../src/testing/index";
import { fakeRedis } from "./fake-redis";
import { useHarness } from "./harness";
import { json } from "./server";

const h = useHarness();

describe("Next.js BFF", () => {
  it("createProxy forwards allow-listed paths only", async () => {
    const s = await h.serve((req, res) => json(res, 200, { url: req.url, method: req.method }));
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const { GET, DELETE } = createProxy(api, {
      prefix: "/api/proxy",
      upstreamPrefix: "/v1",
      allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
    });
    const ok = await GET(new Request("http://app.test/api/proxy/users/1/posts?x=1"));
    expect(await ok.json()).toEqual({ url: "/v1/users/1/posts?x=1", method: "GET" });
    expect((await DELETE(new Request("http://app.test/api/proxy/orders/1", { method: "DELETE" }))).status).toBe(404);
    expect((await GET(new Request("http://app.test/api/proxy/admin"))).status).toBe(404);
    // The URL parser resolves %2e%2e itself, so traversal lands outside the allowlist.
    expect((await GET(new Request("http://app.test/api/proxy/users/%2e%2e/admin"))).status).toBe(404);
    expect(s.hits).toBe(1);
  });

  it("cookieAuth + CSRF origin check", async () => {
    const s = await h.serve((req, res) => json(res, 200, { auth: req.headers.authorization ?? null }));
    const api = h.next({ baseUrl: s.url });
    const opts = { endpoint: "/me", method: "POST" as const, cookieAuth: { name: "at" }, csrf: true };
    const mk = (origin?: string) =>
      new Request("http://app.test/api/me", {
        method: "POST",
        headers: { cookie: "theme=dark; at=tok%20123", ...(origin ? { origin } : {}) },
      });
    expect(await (await api.handleRoute(mk("http://app.test"), opts)).json()).toEqual({ auth: "Bearer tok 123" });
    expect((await api.handleRoute(mk("https://evil.test"), opts)).status).toBe(403);
    expect((await api.handleRoute(mk(), opts)).status).toBe(403);
  });

  it("CSRF uses the host the browser talked to, not the internal req.url host", () => {
    // `next start` / proxies hand route handlers an internal URL such as http://localhost:3000.
    const mk = (headers: Record<string, string>, method = "POST") =>
      new Request("http://localhost:3000/api/x", { method, headers });
    const ok = (headers: Record<string, string>, opts: Parameters<typeof passesCsrf>[2] = true, method?: string) =>
      passesCsrf(mk(headers, method), method ?? "POST", opts);
    expect(ok({ host: "app.example.com", origin: "https://app.example.com" })).toBe(true);
    expect(ok({ host: "internal:3000", "x-forwarded-host": "app.example.com", origin: "https://app.example.com" })).toBe(true);
    expect(ok({ host: "app.example.com", origin: "https://evil.example" })).toBe(false);
    expect(ok({ host: "app.example.com", origin: "null" })).toBe(false);
    expect(
      ok({ host: "app.example.com", origin: "https://admin.example.com" }, { allowedOrigins: ["https://admin.example.com"] }),
    ).toBe(true);
    expect(ok({ host: "app.example.com", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(ok({ host: "app.example.com", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(ok({ host: "app.example.com", referer: "https://app.example.com/form" })).toBe(true);
    expect(ok({ host: "app.example.com", referer: "not a url" })).toBe(false);
    expect(ok({ host: "app.example.com" })).toBe(false); // no evidence at all
    expect(ok({ origin: "https://evil.example" }, true, "GET")).toBe(true); // safe methods are not checked
  });

  it("streams SSE through a route handler and marks cache hits", async () => {
    const s = await h.serve((req, res) => {
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end("data: hi\n\n");
      }
      json(res, 200, { a: 1 });
    });
    const api = h.next({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true } });
    const sse = await api.handleRoute(new Request("http://app.test/x"), { endpoint: "/sse", responseType: "stream" });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    expect(await sse.text()).toBe("data: hi\n\n");
    await api.handleRoute(new Request("http://app.test/x"), { endpoint: "/j" });
    expect((await api.handleRoute(new Request("http://app.test/x"), { endpoint: "/j" })).headers.get("x-cache")).toBe("HIT");
  });

  it("serverForm / toFormState expose field errors", async () => {
    const s = await h.serve((_q, res, ctx) => json(res, 200, JSON.parse(ctx.body)));
    const api = h.next({ baseUrl: s.url, defaultAuth: false });
    const form = new FormData();
    form.append("name", "Sara");
    form.append("tag", "a");
    form.append("tag", "b");
    form.append("$ACTION_ID_1", "x");
    expect(await api.serverForm("POST", "/f", form)).toEqual({ ok: true, data: { name: "Sara", tag: ["a", "b"] } });
    expect(
      toFormState({
        ok: false,
        status: 400,
        error: "Validation error.",
        code: "REQUEST_VALIDATION",
        details: { fieldErrors: { name: ["Required"] } },
      }),
    ).toEqual({ ok: false, message: "Validation error.", code: "REQUEST_VALIDATION", fieldErrors: { name: ["Required"] } });
  });
});

describe("plugins", () => {
  it("hmacSign signs timestamp + method + path + body hash", async () => {
    const s = await h.serve((req, res, ctx) =>
      json(res, 200, { sig: req.headers["x-signature"], ts: req.headers["x-timestamp"], body: ctx.body }),
    );
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, middleware: [hmacSign({ secret: "k" })] });
    const r = await api.post<{ sig: string; ts: string; body: string }>("/pay?x=1", { amount: 5 });
    if (!r.ok) throw new Error("expected ok");
    const bodyHash = require("node:crypto").createHash("sha256").update(r.data.body).digest("hex");
    expect(r.data.sig).toBe(createHmac("sha256", "k").update(`${r.data.ts}.POST./pay?x=1.${bodyHash}`).digest("hex"));
  });

  it("AWS SigV4 matches the official get-vanilla test vector", () => {
    const added = signSigV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(added["Authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("awsSigV4 middleware adds the headers", async () => {
    const s = await h.serve((req, res) => json(res, 200, { auth: req.headers.authorization, date: req.headers["x-amz-date"] }));
    const mw = awsSigV4({
      region: "eu-west-1",
      service: "execute-api",
      credentials: async () => ({ accessKeyId: "A", secretAccessKey: "S" }),
    });
    const api = h.engine({ baseUrl: s.url, defaultAuth: false, middleware: [mw] });
    const r = await api.get<{ auth: string; date: string }>("/x");
    expect(r.ok && r.data.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/\d{8}\/eu-west-1\/execute-api\/aws4_request/);
  });

  it("otel middleware records a span and injects trace context", async () => {
    const s = await h.serve((req, res) => json(res, 200, { tp: req.headers.traceparent }));
    const spans: Array<{ name: string; attrs: Record<string, unknown>; status?: number; ended: boolean }> = [];
    const tracer = {
      startSpan(name: string, o?: { attributes?: Record<string, unknown> }) {
        const span = { name, attrs: { ...o?.attributes }, ended: false, status: undefined as number | undefined };
        spans.push(span);
        return {
          setAttribute: (k: string, v: unknown) => void (span.attrs[k] = v),
          setStatus: (st: { code: number }) => void (span.status = st.code),
          end: () => void (span.ended = true),
        };
      },
    };
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      middleware: [otel({ tracer, inject: (hd) => void (hd.traceparent = "00-abc-def-01") })],
    });
    const r = await api.get("/x?token=secret");
    expect(r).toMatchObject({ data: { tp: "00-abc-def-01" } });
    expect(spans[0]).toMatchObject({ name: "HTTP GET", ended: true, status: 1, attrs: { "http.response.status_code": 200 } });
    expect(String(spans[0]?.attrs["url.full"])).toContain("token=[REDACTED]");
  });

  it("OAuth2 client credentials: caches, refreshes on 401", async () => {
    let issued = 0;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      expect(String(init.body)).toContain("grant_type=client_credentials");
      return new Response(JSON.stringify({ access_token: `t${++issued}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const s = await h.serve((req, res) => (req.headers.authorization === "Bearer t2" ? json(res, 200, {}) : json(res, 401, {})));
    const auth = createOAuth2ClientCredentials({
      tokenUrl: "https://idp.test/token",
      clientId: "c",
      clientSecret: "s",
      fetch: fetchMock,
    });
    const api = h.engine({ baseUrl: s.url, auth });
    expect((await api.get("/x")).ok).toBe(true);
    expect((await api.get("/y")).ok).toBe(true);
    expect(issued).toBe(2);
  });
});

describe("redis store", () => {
  it("shares cached responses (Buffers included), invalidates by resource and tag", async () => {
    let n = 0;
    const s = await h.serve((req, res) => {
      if (req.url === "/bin") return void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([1, 2, 3]));
      json(res, 200, { n: ++n });
    });
    const store = new RedisCacheStore(fakeRedis());
    const a = h.engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, store, keySecret: "shared" } });
    const b = h.engine({ baseUrl: s.url, defaultAuth: false, cache: { enabled: true, store, keySecret: "shared" } });
    await a.get("/x", { cache: { tags: ["t"] } });
    expect(await b.get("/x")).toMatchObject({ data: { n: 1 }, meta: { cached: true } });
    await a.get("/bin");
    const bin = await b.get("/bin");
    expect(bin.ok && Buffer.isBuffer(bin.data) && [...bin.data]).toEqual([1, 2, 3]);
    await b.invalidateTags("t");
    expect((await a.get("/x")).meta?.cached).toBeUndefined();
    await a.invalidateResource("/x");
    expect((await b.get("/x")).meta?.cached).toBeUndefined();
  });

  it("distributed rate limiter rejects above the shared limit", async () => {
    const redis = fakeRedis();
    const l1 = new RedisRateLimiter(redis, { limit: 2, windowMs: 60_000, onLimit: "reject" });
    const l2 = new RedisRateLimiter(redis, { limit: 2, windowMs: 60_000, onLimit: "reject" });
    await l1.acquire();
    await l2.acquire();
    await expect(l1.acquire()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("testing utilities", () => {
  it("createMockEngine matches routes, params and errors", async () => {
    const api = h.track(
      createMockEngine({
        "GET /users/:id": ({ params }) => ({ body: { id: params.id } }),
        "POST /users": { status: 201, body: { created: true } },
        "* /broken": { status: 500, body: { message: "boom" } },
      }),
    );
    expect(await api.get("/users/7")).toMatchObject({ ok: true, data: { id: "7" } });
    expect(await api.post("/users", {})).toMatchObject({ status: 201, data: { created: true } });
    expect(await api.delete("/broken")).toMatchObject({ ok: false, status: 500, error: "boom" });
    expect(await api.get("/nope")).toMatchObject({ ok: false, code: "MOCK_NOT_FOUND" });
  });

  it("recorder saves fixtures and replays them offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gae-rec-"));
    try {
      const s = await h.serve((_q, res) => json(res, 200, { live: true }));
      const rec = h.engine({ baseUrl: s.url, defaultAuth: false, middleware: [recorder({ dir, mode: "record" })] });
      await rec.get("/x");
      expect(readdirSync(dir)).toHaveLength(1);
      const replay = h.engine({ baseUrl: s.url, defaultAuth: false, middleware: [recorder({ dir, mode: "replay" })] });
      expect(await replay.get("/x")).toMatchObject({ data: { live: true } });
      expect(await replay.get("/other")).toMatchObject({ code: "MOCK_NOT_FOUND" });
      expect(s.hits).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OpenAPI codegen", () => {
  const spec = {
    openapi: "3.1.0",
    paths: {
      "/users/{id}": {
        get: {
          operationId: "getUser",
          summary: "Fetch a user",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
        },
        delete: { responses: { "204": {} } },
      },
      "/users": {
        post: {
          operationId: "create-user",
          parameters: [{ name: "dry_run", in: "query", schema: { type: "boolean" } }],
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewUser" } } } },
          responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            role: { enum: ["admin", "user"] },
            tags: { type: "array", items: { type: "string" } },
            note: { type: ["string", "null"] },
          },
        },
        NewUser: {
          allOf: [{ $ref: "#/components/schemas/User" }, { type: "object", properties: { password: { type: "string" } } }],
        },
      },
    },
  };

  it("emits types and endpoint definitions that type-check", () => {
    const code = generateFromOpenApi(spec, { importFrom: "../../src/index" });
    expect(code).toContain('export type User = {\n  id: string;\n  role?: "admin" | "user";');
    expect(code).toContain(
      'getUser: { method: "GET", path: "/users/:id" } as EndpointDefinition<"/users/:id", GetUserResponse, never, GetUserQuery>',
    );
    expect(code).toContain("createUser:");
    expect(code).toContain("export type DeleteUsersIdResponse = void;");

    const dir = mkdtempSync(join(resolve("test"), ".gen-"));
    try {
      writeFileSync(
        join(dir, "api.ts"),
        `${code}\nimport { createEngine } from "../../src/index";\nconst c = createEngine({ baseUrl: "http://x" }).endpoints(endpoints);\nexport const p = c.getUser({ path: { id: "1" } });\n`,
      );
      const tsc = resolve("node_modules/.bin/tsc");
      try {
        execFileSync(
          tsc,
          [
            "--noEmit",
            "--ignoreConfig",
            "--strict",
            "--module",
            "esnext",
            "--moduleResolution",
            "bundler",
            "--target",
            "es2023",
            "--types",
            "node",
            "--skipLibCheck",
            join(dir, "api.ts"),
          ],
          { stdio: "pipe" },
        );
      } catch (e) {
        throw new Error(String((e as { stdout?: Buffer }).stdout));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
