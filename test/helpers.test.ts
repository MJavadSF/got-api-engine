import { describe, expect, it } from "vitest";
import {
  appendParams,
  buildUrl,
  classifyContentType,
  decodeBody,
  getUserIdFromBearerToken,
  mergeHeaders,
  normalizeAuthorization,
  parseApiError,
  parseCacheControl,
  safeStringify,
} from "../src/utils/helpers";
import { parseRetryAfter } from "../src/core/backoff";

describe("safeStringify", () => {
  it("marks true cycles as [Circular]", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(JSON.parse(safeStringify(a))).toEqual({ name: "a", self: "[Circular]" });
  });

  it("does NOT mark repeated (shared, non-circular) references as circular", () => {
    const shared = { x: 1 };
    const out = JSON.parse(safeStringify({ a: shared, b: shared, list: [shared, shared] }));
    expect(out).toEqual({ a: { x: 1 }, b: { x: 1 }, list: [{ x: 1 }, { x: 1 }] });
  });

  it("truncates beyond maxDepth and survives bigint", () => {
    const out = JSON.parse(safeStringify({ a: { b: { c: { d: 1 } } }, n: 10n }, 2));
    expect(out.a.b).toBe("[Object]");
    expect(out.n).toBe("10");
  });
});

describe("appendParams", () => {
  it("encodes, repeats array values and skips null/undefined", () => {
    const url = appendParams("https://x.test/a", { q: "a b", tag: ["x", "y"], skip: undefined, none: null, n: 0, f: false });
    expect(url).toBe("https://x.test/a?q=a%20b&tag=x&tag=y&n=0&f=false");
  });

  it("keeps existing query and places params before the fragment", () => {
    expect(appendParams("https://x.test/a?z=1#frag", { q: 1 })).toBe("https://x.test/a?z=1&q=1#frag");
    expect(appendParams("https://x.test/a?", { q: 1 })).toBe("https://x.test/a?q=1");
  });
});

describe("buildUrl", () => {
  it("joins base and path, tolerating slashes", () => {
    expect(buildUrl("users", "https://api.test/")).toBe("https://api.test/users");
    expect(buildUrl("/users", "https://api.test//")).toBe("https://api.test/users");
    expect(buildUrl("https://other.test/x", "https://api.test")).toBe("https://other.test/x");
  });
});

describe("parseApiError", () => {
  it("handles common shapes", () => {
    expect(parseApiError({ message: "boom" })).toBe("boom");
    expect(parseApiError({ error: "bad" })).toBe("bad");
    expect(parseApiError({ message: [{ title: "a" }, { title: "b" }] })).toBe("a, b");
    expect(parseApiError({ errors: [{ message: "m1" }, { detail: "m2" }] })).toBe("m1, m2");
    expect(parseApiError({ error: { message: "nested" } })).toBe("nested");
    expect(parseApiError('{"detail":"from string"}')).toBe("from string");
    expect(parseApiError("plain text")).toBe("plain text");
  });

  it("does not surface HTML error pages or empty bodies", () => {
    expect(parseApiError("<html><body>502 Bad Gateway</body></html>")).toBe("An unexpected error occurred.");
    expect(parseApiError("")).toBe("An unexpected error occurred.");
    expect(parseApiError(undefined)).toBe("An unexpected error occurred.");
  });
});

describe("mergeHeaders / normalizeAuthorization", () => {
  it("merges case-insensitively so no duplicate Authorization is sent", () => {
    const h = mergeHeaders({ authorization: "old", "X-A": "1" }, { Authorization: "new" });
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "authorization")).toEqual(["Authorization"]);
    expect(h["Authorization"]).toBe("new");
  });

  it("keeps existing schemes and prefixes bare tokens", () => {
    expect(normalizeAuthorization("abc")).toBe("Bearer abc");
    expect(normalizeAuthorization("Bearer abc")).toBe("Bearer abc");
    expect(normalizeAuthorization("Basic dXNlcjpwYXNz")).toBe("Basic dXNlcjpwYXNz");
    expect(normalizeAuthorization("ApiKey k")).toBe("ApiKey k");
  });
});

describe("getUserIdFromBearerToken", () => {
  const jwt = (payload: unknown) =>
    `Bearer h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("decodes UTF-8 payloads correctly", () => {
    expect(getUserIdFromBearerToken(jwt({ sub: "کاربر-۱" }))).toBe("کاربر-۱");
    expect(getUserIdFromBearerToken(jwt({ userId: 42 }))).toBe("42");
  });

  it("returns undefined for junk", () => {
    expect(getUserIdFromBearerToken("Bearer nope")).toBeUndefined();
    expect(getUserIdFromBearerToken(null)).toBeUndefined();
  });
});

describe("decodeBody", () => {
  const buf = (s: string) => Buffer.from(s);

  it("auto: JSON by content-type, text, and sniffing", () => {
    expect(decodeBody(buf('{"a":1}'), "application/json; charset=utf-8", "auto")).toEqual({ ok: true, value: { a: 1 } });
    expect(decodeBody(buf("hello"), "text/plain", "auto")).toEqual({ ok: true, value: "hello" });
    expect(decodeBody(buf('{"a":1}'), undefined, "auto")).toEqual({ ok: true, value: { a: 1 } });
    expect(decodeBody(buf("nope"), undefined, "auto")).toEqual({ ok: true, value: "nope" });
  });

  it("auto: binary stays a Buffer", () => {
    const r = decodeBody(buf("PNG"), "image/png", "auto");
    expect(r.ok && Buffer.isBuffer(r.value)).toBe(true);
  });

  it("strict json fails on garbage; lenient falls back to text", () => {
    expect(decodeBody(buf("<html>"), "application/json", "json").ok).toBe(false);
    expect(decodeBody(buf("<html>"), "application/json", "json", true)).toEqual({ ok: true, value: "<html>" });
  });

  it("honours a non-UTF-8 charset", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    expect(decodeBody(latin1, "text/plain; charset=iso-8859-1", "auto")).toEqual({ ok: true, value: "café" });
  });

  it("classifies content types", () => {
    expect(classifyContentType("application/problem+json")).toBe("json");
    expect(classifyContentType("application/pdf")).toBe("binary");
    expect(classifyContentType("text/html")).toBe("text");
    expect(classifyContentType(undefined)).toBe("unknown");
  });
});

describe("cache-control + retry-after parsing", () => {
  it("parses cache-control", () => {
    expect(parseCacheControl("public, max-age=60")).toEqual({ noStore: false, noCache: false, maxAgeMs: 60_000 });
    expect(parseCacheControl("no-store").noStore).toBe(true);
    expect(parseCacheControl("no-cache, max-age=5").noCache).toBe(true);
  });

  it("parses Retry-After seconds, zero and dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1.5")).toBe(1500);
    const d = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
    expect(d).toBeGreaterThan(3000);
    expect(parseRetryAfter("garbage")).toBeNull();
  });
});
