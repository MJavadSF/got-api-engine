import { createProxy } from "got-api-engine/next";
import { api } from "../../../../lib/api";

export const { GET, POST, PUT, PATCH, DELETE } = createProxy(api, {
  prefix: "/api/proxy",
  allow: ["/users/**", { path: "/orders/*", methods: ["GET"] }],
});
