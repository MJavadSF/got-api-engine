import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngine } from "../src/index";

const CERT = process.env.TEST_CERT_DIR;

describe.skipIf(!CERT)("TLS", () => {
  let server: https.Server;
  let base = "";
  beforeAll(async () => {
    server = https.createServer({ key: readFileSync(`${CERT}/k.pem`), cert: readFileSync(`${CERT}/c.pem`) }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"secure":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("verifies certificates by default in every NODE_ENV", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const api = createEngine({ baseUrl: base, defaultAuth: false, logLevel: "silent", retryLimit: 0 });
    try {
      const r = await api.get("/x");
      expect(r).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    } finally {
      process.env.NODE_ENV = prev;
      await api.dispose();
    }
  });

  it("trusts a custom CA via `tls.ca` (no need to disable verification)", async () => {
    const api = createEngine({
      baseUrl: base,
      defaultAuth: false,
      logLevel: "silent",
      tls: { ca: readFileSync(`${CERT}/c.pem`) },
    });
    const r = await api.get<{ secure: boolean }>("/x");
    expect(r.ok && r.data.secure).toBe(true);
    await api.dispose();
  });
});
