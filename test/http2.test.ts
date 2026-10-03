import { readFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngine } from "../src/index";

const CERT = process.env.TEST_CERT_DIR;

describe.skipIf(!CERT)("http2 (got 16 native client)", () => {
  let server: http2.Http2SecureServer;
  let base = "";
  const sessions = new Set<http2.ServerHttp2Session>();

  beforeAll(async () => {
    server = http2.createSecureServer({
      key: readFileSync(`${CERT}/k.pem`),
      cert: readFileSync(`${CERT}/c.pem`),
    });
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    server.on("request", (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ httpVersion: req.httpVersion }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        // server.close() waits for open sessions; the client keeps pooled h2 sessions alive.
        for (const session of sessions) session.destroy();
        server.close(() => r());
      }),
  );

  it("negotiates HTTP/2 when http2:true (self-signed allowed explicitly for the test)", async () => {
    const api = createEngine({ baseUrl: base, defaultAuth: false, http2: true, rejectUnauthorized: false, logLevel: "silent" });
    const r = await api.get<{ httpVersion: string }>("/x");
    await api.dispose();
    expect(r.ok && r.data.httpVersion).toBe("2.0");
  });

  it("rejects the self-signed certificate by default (TLS verification ON)", async () => {
    const api = createEngine({ baseUrl: base, defaultAuth: false, http2: true, logLevel: "silent", retry: { limit: 0 } });
    const r = await api.get("/x");
    await api.dispose();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("NETWORK_ERROR");
  });
});
