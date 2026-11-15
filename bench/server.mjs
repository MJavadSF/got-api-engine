// Upstream used by the benchmarks. Runs in its own process so that it never
// competes with the client under test for the same event loop.

import http from "node:http";

const small = JSON.stringify({ id: 1, name: "Sara", email: "sara@example.com", roles: ["admin", "user"], active: true });
const large = JSON.stringify({
  items: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `user-${i}`, score: i * 1.5, tags: ["a", "b", "c"] })),
});

let count = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/__count") return res.end(String(count));
  count++;
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(Buffer.concat(chunks));
    });
    return;
  }
  const body = req.url?.startsWith("/large") ? large : small;
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
});
server.keepAliveTimeout = 60_000;
server.listen(0, "127.0.0.1", () => {
  process.send?.({ port: server.address().port, largeBytes: Buffer.byteLength(large) });
});
process.on("message", (m) => {
  if (m === "stop") server.close(() => process.exit(0));
});
