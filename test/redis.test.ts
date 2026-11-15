// RedisCacheStore / RedisRateLimiter against a fake with real expiry semantics.
import { describe, expect, it } from "vitest";
import type { CachedResponse } from "../src/index";
import { RedisCacheStore, RedisRateLimiter } from "../src/stores/redis";
import { fakeRedis } from "./fake-redis";
import { sleep } from "./server";

const entry = (tags?: string[]): CachedResponse => ({
  status: 200,
  body: { ok: true },
  headers: {},
  storedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...(tags ? { tags } : {}),
});

describe.each([
  ["with EVAL (atomic)", true],
  ["without EVAL (fallback)", false],
])("RedisCacheStore tags %s", (_name, withEval) => {
  it("a short-lived entry never shortens the tag index of longer-lived entries", async () => {
    const redis = fakeRedis({ withEval });
    const store = new RedisCacheStore(redis);
    await store.set("long", entry(["users"]), 60_000);
    await store.set("short", entry(["users"]), 20);
    await sleep(60); // "short" expired; the tag index must survive

    expect(await store.get("long")).toBeDefined();
    await store.deleteByTags(["users"]);
    expect(await store.get("long")).toBeUndefined();
  });

  it("the tag index outlives its longest member and is extended, never shortened", async () => {
    const redis = fakeRedis({ withEval });
    const store = new RedisCacheStore(redis);
    await store.set("a", entry(["t"]), 5_000);
    const first = await redis.pttl("gae:t:t");
    await store.set("b", entry(["t"]), 100);
    const second = await redis.pttl("gae:t:t");
    expect(first).toBeGreaterThan(5_000);
    expect(second).toBeGreaterThanOrEqual(first - 50);
    await store.set("c", entry(["t"]), 600_000);
    expect(await redis.pttl("gae:t:t")).toBeGreaterThan(600_000);
  });

  it("indexes before writing, so an entry is never unreachable from its tag", async () => {
    const redis = fakeRedis({ withEval });
    const store = new RedisCacheStore(redis);
    await store.set("k", entry(["t"]), 1000);
    const writes = redis.commands.filter((c) => c === "set" || c === "eval" || c === "sadd");
    expect(writes.at(-1)).toBe("set");
  });
});

describe("RedisCacheStore housekeeping", () => {
  it("uses EVAL when available (single round-trip per tag)", async () => {
    const redis = fakeRedis({ withEval: true });
    await new RedisCacheStore(redis).set("k", entry(["a", "b"]), 1000);
    expect(redis.commands.filter((c) => c === "eval")).toHaveLength(2);
    expect(redis.commands).not.toContain("pexpire");
  });

  it("clear() removes cache entries and tag indexes but keeps rate-limiter state", async () => {
    const redis = fakeRedis();
    const store = new RedisCacheStore(redis);
    const limiter = new RedisRateLimiter(redis, { limit: 1, windowMs: 60_000, onLimit: "reject" });
    await store.set("k", entry(["t"]), 60_000);
    await limiter.acquire();
    await store.clear();
    expect(await store.get("k")).toBeUndefined();
    expect(await redis.smembers("gae:t:t")).toEqual([]);
    await expect(limiter.acquire()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("escapes glob characters in the prefix", async () => {
    const redis = fakeRedis();
    const mine = new RedisCacheStore(redis, { prefix: "app[1]:" });
    const other = new RedisCacheStore(redis, { prefix: "app1:" });
    await mine.set("GET http://a/x|a|v", entry(), 60_000);
    await other.set("GET http://a/x|a|v", entry(), 60_000);
    await mine.deleteMatching(() => true);
    await mine.clear();
    expect(await other.get("GET http://a/x|a|v")).toBeDefined();
    expect(await mine.get("GET http://a/x|a|v")).toBeUndefined();
  });

  it("round-trips Buffers and treats non-finite TTLs as one day", async () => {
    const redis = fakeRedis();
    const store = new RedisCacheStore(redis);
    await store.set("b", { ...entry(), body: Buffer.from([1, 2]) }, Number.POSITIVE_INFINITY);
    const got = await store.get("b");
    const body = got?.body;
    expect(Buffer.isBuffer(body) ? [...body] : body).toEqual([1, 2]);
    expect(await redis.pttl("gae:c:b")).toBeGreaterThan(86_000_000);
  });
});

describe("RedisRateLimiter", () => {
  it("waits for the next window and honours pauseUntil", async () => {
    const redis = fakeRedis();
    const limiter = new RedisRateLimiter(redis, { limit: 1, windowMs: 100, maxWaitMs: 1000 });
    await limiter.acquire();
    const t = Date.now();
    await limiter.acquire();
    expect(Date.now() - t).toBeGreaterThan(0);
    limiter.pauseUntil(Date.now() + 120);
    const t2 = Date.now();
    await limiter.acquire();
    expect(Date.now() - t2).toBeGreaterThanOrEqual(100);
  });

  it("rejects when the wait would exceed maxWaitMs", async () => {
    const redis = fakeRedis();
    const limiter = new RedisRateLimiter(redis, { limit: 1, windowMs: 60_000, maxWaitMs: 10 });
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    limiter.pauseUntil(Date.now() + 60_000);
    await expect(limiter.acquire()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("resource index (mutation invalidation without SCAN)", () => {
  const key = (path: string, variant = "") => `GET http://api.test${path}||${variant}`;

  it("drops every variant of a resource without scanning the keyspace", async () => {
    const redis = fakeRedis({ withEval: true });
    const store = new RedisCacheStore(redis);
    await store.set(key("/users/1"), entry(), 60_000);
    await store.set(key("/users/1", "v2"), entry(), 60_000);
    await store.set(`GET http://api.test/users/1?q=abc||`, entry(), 60_000);
    await store.set(key("/users/2"), entry(), 60_000);
    redis.commands.length = 0;
    await store.deleteByResources(["http://api.test/users/1"]);
    expect(redis.commands).not.toContain("scan");
    expect(await store.get(key("/users/1"))).toBeUndefined();
    expect(await store.get(key("/users/1", "v2"))).toBeUndefined();
    expect(await store.get("GET http://api.test/users/1?q=abc||")).toBeUndefined();
    expect(await store.get(key("/users/2"))).toBeDefined();
  });

  it("a short-lived variant never shortens the resource index", async () => {
    const redis = fakeRedis();
    const store = new RedisCacheStore(redis);
    await store.set(key("/r", "long"), entry(), 60_000);
    await store.set(key("/r", "short"), entry(), 20);
    await sleep(60);
    await store.deleteByResources(["http://api.test/r"]);
    expect(await store.get(key("/r", "long"))).toBeUndefined();
  });

  it("engines sharing a Redis store invalidate each other's reads after a mutation", async () => {
    const { createServer } = await import("node:http");
    let n = 0;
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.method === "GET" ? { n: ++n } : {}));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { createEngine } = await import("../src/index");
    const redis = fakeRedis({ withEval: true });
    const mk = () =>
      createEngine({
        baseUrl: base,
        defaultAuth: false,
        logLevel: "silent",
        cache: { enabled: true, store: new RedisCacheStore(redis), keySecret: "s" },
      });
    const a = mk();
    const b = mk();
    try {
      await a.get("/users/1");
      expect((await b.get("/users/1")).meta?.cached).toBe(true);
      redis.commands.length = 0;
      await b.put("/users/1", { x: 1 });
      expect(redis.commands).not.toContain("scan");
      expect(await a.get("/users/1")).toMatchObject({ data: { n: 2 } });
    } finally {
      await a.dispose();
      await b.dispose();
      server.close();
    }
  });
});
