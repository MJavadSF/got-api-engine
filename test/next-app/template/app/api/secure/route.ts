import { api } from "../../../lib/api";

export const POST = (req: Request) =>
  api.handleRoute(req, { endpoint: "/secure", method: "POST", auth: true, cookieAuth: { name: "at" }, csrf: true });
