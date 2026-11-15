import { describe, expect, it } from "vitest";
import { isCredentialTarget } from "../src/security/hosts";
import { buildRedactor, redactUrl, withRedaction } from "../src/security/redact";
import {
  assertUrlAllowed,
  buildGuardedLookup,
  findSsrfError,
  isPrivateAddress,
  resolveSsrfConfig,
  SsrfError,
} from "../src/security/ssrf";
import type { LoggerInterface } from "../src/types";

const cfg = resolveSsrfConfig(true)!;

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:169.254.169.254",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertUrlAllowed", () => {
  it.each([
    "http://127.0.0.1/",
    "http://localhost/",
    "http://sub.localhost/",
    "http://[::1]/",
    "http://2130706433/", // decimal IPv4
    "http://0x7f.1/", // hex/short IPv4
    "http://0177.0.0.1/", // octal IPv4
    "http://[::ffff:127.0.0.1]/", // regression: normalised to ::ffff:7f00:1
    "http://[::ffff:169.254.169.254]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://service.internal/",
    "http://printer.local/",
  ])("blocks %s", (url) => {
    expect(() => assertUrlAllowed(url, cfg)).toThrow(SsrfError);
  });

  it("blocks non-http protocols and embedded credentials", () => {
    expect(() => assertUrlAllowed("file:///etc/passwd", cfg)).toThrow(SsrfError);
    expect(() => assertUrlAllowed("ftp://x.test/", cfg)).toThrow(SsrfError);
    expect(() => assertUrlAllowed("http://user:pw@example.com/", cfg)).toThrow(SsrfError);
  });

  it("allows public hosts and honours allow/block lists", () => {
    expect(() => assertUrlAllowed("https://example.com/", cfg)).not.toThrow();
    const allow = resolveSsrfConfig({ allowHosts: ["*.example.com"] })!;
    expect(() => assertUrlAllowed("https://api.example.com/", allow)).not.toThrow();
    expect(() => assertUrlAllowed("https://evil.com/", allow)).toThrow(/allowlist/);
    const block = resolveSsrfConfig({ blockHosts: ["*.corp.test"] })!;
    expect(() => assertUrlAllowed("https://a.corp.test/", block)).toThrow(/blocklisted/);
    const priv = resolveSsrfConfig({ allowPrivateNetworks: true })!;
    expect(() => assertUrlAllowed("http://127.0.0.1/", priv)).not.toThrow();
  });
});

describe("guarded DNS lookup (connect-time, defeats rebinding)", () => {
  const fakeLookup = (addrs: string[]) => (_h: string, _o: unknown, cb: (e: null, a: unknown, f?: number) => void) => {
    cb(
      null,
      addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  };

  it("rejects a public name that resolves to a private address", async () => {
    const lookup = buildGuardedLookup(cfg, fakeLookup(["93.184.216.34", "10.0.0.5"]) as never);
    const err = await new Promise<Error | null>((resolve) => lookup("evil.example", { all: true }, (e) => resolve(e)));
    expect(err).toBeInstanceOf(SsrfError);
    expect(err?.message).toMatch(/10\.0\.0\.5/);
  });

  it("supports the single-address callback form", async () => {
    const inner = (_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, "127.0.0.1", 4);
    const lookup = buildGuardedLookup(cfg, inner as never);
    const err = await new Promise<Error | null>((resolve) => lookup("x.example", {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(SsrfError);
  });

  it("passes public addresses through", async () => {
    const lookup = buildGuardedLookup(cfg, fakeLookup(["93.184.216.34"]) as never);
    const res = await new Promise<unknown>((resolve) => lookup("ok.example", { all: true }, (_e, a) => resolve(a)));
    expect(res).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("findSsrfError unwraps got-style wrapped errors", () => {
    const inner = new SsrfError("nope");
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner, code: "ERR_GOT_REQUEST_ERROR" });
    expect(findSsrfError(wrapped)).toBe(inner);
    expect(findSsrfError(new Error("plain"))).toBeUndefined();
  });
});

describe("isCredentialTarget", () => {
  it("only trusts the baseUrl origin and listed hosts", () => {
    expect(isCredentialTarget("https://api.test/users", "https://api.test")).toBe(true);
    expect(isCredentialTarget("https://api.test:8443/x", "https://api.test")).toBe(false);
    expect(isCredentialTarget("http://api.test/x", "https://api.test")).toBe(false);
    expect(isCredentialTarget("https://evil.test/x", "https://api.test")).toBe(false);
    expect(isCredentialTarget("https://cdn.trusted.test/x", "https://api.test", ["*.trusted.test"])).toBe(true);
  });
});

describe("redaction", () => {
  it("redacts sensitive keys, bearer strings, URLs and errors — but not error codes", () => {
    const redact = buildRedactor(["x-internal"]);
    const out = redact({
      headers: { Authorization: "Bearer abc", "X-Internal": "s", accept: "json" },
      value: "Bearer zzz",
      url: "https://a.test/p?token=secret&ok=1",
      code: "HTTP_ERROR",
      nested: { password: "p" },
    }) as Record<string, any>;
    expect(out.headers.Authorization).toBe("[REDACTED]");
    expect(out.headers["X-Internal"]).toBe("[REDACTED]");
    expect(out.headers.accept).toBe("json");
    expect(out.value).toBe("[REDACTED]");
    expect(out.url).toBe("https://a.test/p?token=[REDACTED]&ok=1");
    expect(out.code).toBe("HTTP_ERROR");
    expect(out.nested.password).toBe("[REDACTED]");
  });

  it("redactUrl strips credentials and sensitive params", () => {
    expect(redactUrl("https://u:p@a.test/x?api_key=k&q=1")).toBe("https://a.test/x?api_key=[REDACTED]&q=1");
    expect(redactUrl("/relative?token=1")).toBe("/relative?token=1");
  });

  it("withRedaction wraps every level and child loggers", () => {
    const seen: unknown[] = [];
    const base: LoggerInterface = {
      debug: (_m, meta) => void seen.push(meta),
      info: (_m, meta) => void seen.push(meta),
      warn: (_m, meta) => void seen.push(meta),
      error: (_m, meta) => void seen.push(meta),
      child: (cm) => {
        seen.push(cm);
        return base;
      },
    };
    const log = withRedaction(base, buildRedactor());
    log.warn("x", { token: "t" });
    log.child!({ authorization: "a" }).error("y", { password: "p" });
    expect(seen).toEqual([{ token: "[REDACTED]" }, { authorization: "[REDACTED]" }, { password: "[REDACTED]" }]);
  });
});
