import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  port: number;
  hits: number;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, ctx: { hit: number; body: string }) => void | Promise<void>;

export async function startServer(handler: Handler): Promise<TestServer> {
  const state: TestServer = {
    url: "",
    port: 0,
    hits: 0,
    requests: [],
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      state.hits++;
      state.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      Promise.resolve(handler(req, res, { hit: state.hits, body })).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.port = port;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
