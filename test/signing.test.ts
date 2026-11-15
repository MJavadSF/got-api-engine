// Per-attempt signing: every retry, failover and hedge is signed for its own URL / time.
import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { awsSigV4, hmacSign, type Middleware } from "../src/index";
import { signSigV4 } from "../src/plugins/signing";
import { useHarness } from "./harness";
import { json, sleep } from "./server";

const h = useHarness();
const CREDS = { accessKeyId: "AKID", secretAccessKey: "SECRET" };

/** Server-side SigV4 verification, exactly as a gateway would do it. */
function verifySigV4(req: IncomingMessage, body: string): boolean {
  const amz = String(req.headers["x-amz-date"]);
  const date = new Date(
    `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (k.startsWith("x-amz-") || k === "content-type") headers[k] = String(v);
  const expected = signSigV4({
    method: String(req.method),
    url: `http://${req.headers.host}${req.url}`,
    headers,
    body,
    region: "eu-west-1",
    service: "execute-api",
    credentials: CREDS,
    date,
  });
  return expected["Authorization"] === req.headers.authorization;
}

describe("per-attempt signing", () => {
  it("SigV4 stays valid after failover to another upstream (different host)", async () => {
    const good = await h.serve((req, res, ctx) => json(res, 200, { valid: verifySigV4(req, ctx.body) }));
    const api = h.engine({
      baseUrl: ["http://127.0.0.1:1", good.url],
      defaultAuth: false,
      retry: { limit: 1, baseDelayMs: 1 },
      middleware: [awsSigV4({ region: "eu-west-1", service: "execute-api", credentials: CREDS })],
    });
    const r = await api.post<{ valid: boolean }>("/orders?x=1", { a: 1 });
    expect(r).toMatchObject({ ok: true, data: { valid: true }, meta: { attempts: 2 } });
  });

  it("every retry gets a fresh HMAC timestamp and a valid signature", async () => {
    let n = 0;
    const seen: Array<{ ts: string; valid: boolean }> = [];
    const s = await h.serve((req, res, ctx) => {
      const ts = String(req.headers["x-timestamp"]);
      const bodyHash = createHash("sha256").update(ctx.body).digest("hex");
      const expected = createHmac("sha256", "k").update(`${ts}.${req.method}.${req.url}.${bodyHash}`).digest("hex");
      seen.push({ ts, valid: expected === req.headers["x-signature"] });
      json(res, ++n === 1 ? 503 : 200, {});
    });
    let clock = 1_700_000_000_000;
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      retry: { limit: 1, baseDelayMs: 1 },
      middleware: [hmacSign({ secret: "k", now: () => new Date((clock += 1000)) })],
    });
    expect((await api.put("/pay", { amount: 5 })).ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.every((x) => x.valid)).toBe(true);
    expect(seen[0]?.ts).not.toBe(seen[1]?.ts);
  });

  it("a hedged attempt to another upstream is signed for that upstream", async () => {
    const results: Array<{ who: string; valid: boolean }> = [];
    const slow = await h.serve(async (req, res, ctx) => {
      results.push({ who: "slow", valid: verifySigV4(req, ctx.body) });
      await sleep(300);
      json(res, 200, { who: "slow" });
    });
    const fast = await h.serve((req, res, ctx) => {
      results.push({ who: "fast", valid: verifySigV4(req, ctx.body) });
      json(res, 200, { who: "fast" });
    });
    const attempts: Array<{ attempt: number; hedge: boolean }> = [];
    const spy: Middleware = async (ctx, next) => {
      ctx.onAttempt((a) => void attempts.push({ attempt: a.attempt, hedge: a.hedge }));
      return next();
    };
    const api = h.engine({
      baseUrl: [slow.url, fast.url],
      defaultAuth: false,
      hedge: { afterMs: 30 },
      middleware: [spy, awsSigV4({ region: "eu-west-1", service: "execute-api", credentials: CREDS })],
    });
    const r = await api.get<{ who: string }>("/x");
    expect(r).toMatchObject({ ok: true, data: { who: "fast" }, meta: { hedged: true } });
    expect(results).toEqual([
      { who: "slow", valid: true },
      { who: "fast", valid: true },
    ]);
    expect(attempts).toEqual([
      { attempt: 1, hedge: false },
      { attempt: 1, hedge: true },
    ]);
  });

  it("headers added by attempt hooks are stripped on redirects to foreign origins", async () => {
    const evil = await h.serve((req, res) => json(res, 200, { token: req.headers["x-amz-security-token"] ?? null }));
    const s = await h.serve((_q, res) => void res.writeHead(302, { location: `${evil.url}/steal` }).end());
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      middleware: [awsSigV4({ region: "eu-west-1", service: "s3", credentials: { ...CREDS, sessionToken: "SESSION-SECRET" } })],
    });
    const r = await api.get<{ token: string | null }>("/x");
    expect(r).toMatchObject({ ok: true, data: { token: null } });
  });

  it("a throwing hook fails the request as INTERNAL_ERROR without retries or circuit impact", async () => {
    const s = await h.serve((_q, res) => json(res, 200, {}));
    const broken: Middleware = async (ctx, next) => {
      ctx.onAttempt(() => {
        throw new Error("no credentials");
      });
      return next();
    };
    const api = h.engine({
      baseUrl: s.url,
      defaultAuth: false,
      circuitBreaker: { enabled: true, failureThreshold: 1 },
      middleware: [broken],
    });
    expect(await api.get("/x")).toMatchObject({ ok: false, status: 500, code: "INTERNAL_ERROR" });
    expect(s.hits).toBe(0);
    expect(api.getCircuitState()).toBe("closed");
  });
});
