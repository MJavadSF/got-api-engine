// One adapter per HTTP client. Every adapter is configured the way a
// production app would use it: keep-alive connections, JSON parsing, no retry
// on success paths. `get` / `post` must return the parsed JSON body.

import http from "node:http";

const keepAlive = () => new http.Agent({ keepAlive: true, maxSockets: 256 });

export const clients = {
  async fetch(base) {
    // Node's global fetch (undici under the hood).
    return {
      get: async (p) => (await fetch(base + p)).json(),
      post: async (p, body) =>
        (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json(),
      close: async () => {},
    };
  },

  async "undici.request"(base) {
    const { Pool } = await import("undici");
    const pool = new Pool(base, { connections: 256 });
    return {
      get: async (p) => (await pool.request({ path: p, method: "GET" })).body.json(),
      post: async (p, body) =>
        (
          await pool.request({ path: p, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        ).body.json(),
      close: () => pool.close(),
    };
  },

  async got(base) {
    const { default: got } = await import("got");
    const client = got.extend({ prefixUrl: base, agent: { http: keepAlive() }, retry: { limit: 0 }, responseType: "json" });
    return {
      get: async (p) => (await client.get(p.slice(1))).body,
      post: async (p, body) => (await client.post(p.slice(1), { json: body })).body,
      close: async () => {},
    };
  },

  async axios(base) {
    const { default: axios } = await import("axios");
    const client = axios.create({ baseURL: base, httpAgent: keepAlive() });
    return {
      get: async (p) => (await client.get(p)).data,
      post: async (p, body) => (await client.post(p, body)).data,
      close: async () => {},
    };
  },

  async ky(base) {
    const { default: ky } = await import("ky");
    const client = ky.create({ baseUrl: base, retry: 0 });
    return {
      get: (p) => client.get(p).json(),
      post: (p, body) => client.post(p, { json: body }).json(),
      close: async () => {},
    };
  },

  async ofetch(base) {
    const { ofetch } = await import("ofetch");
    const client = ofetch.create({ baseURL: base, retry: 0 });
    return {
      get: (p) => client(p),
      post: (p, body) => client(p, { method: "POST", body }),
      close: async () => {},
    };
  },

  // got-api-engine with its defaults (dedupe, metrics, redaction, timeouts).
  async "got-api-engine"(base) {
    const { createEngine } = await import("../dist/index.mjs");
    const api = createEngine({ baseUrl: base, defaultAuth: false, logLevel: "silent" });
    return engineAdapter(api);
  },

  // got-api-engine with everything that is not needed for the hot path switched off.
  async "got-api-engine (lean)"(base) {
    const { createEngine } = await import("../dist/index.mjs");
    const api = createEngine({
      baseUrl: base,
      defaultAuth: false,
      logLevel: "silent",
      metrics: false,
      dedupe: false,
      totalTimeoutMs: 0,
      strictPath: false,
    });
    return engineAdapter(api);
  },
};

function engineAdapter(api) {
  const unwrap = (r) => {
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    return r.data;
  };
  return {
    get: async (p) => unwrap(await api.get(p)),
    post: async (p, body) => unwrap(await api.post(p, body)),
    close: () => api.dispose(),
  };
}
