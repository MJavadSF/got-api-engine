import { api } from "../../../lib/api";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/stream", responseType: "stream" });
