// One engine per server process, exactly as an app would do it.
import { createNextEngine } from "got-api-engine/next";
import { after } from "./after";

const upstream = process.env.UPSTREAM_URL;
if (!upstream) throw new Error("UPSTREAM_URL is not set");

export const api = createNextEngine({
  baseUrl: upstream,
  defaultAuth: "optional",
  messages: "fa",
  logLevel: "silent",
  cache: { enabled: true, ttlMs: 50, staleWhileRevalidate: true },
  waitUntil: after,
});
