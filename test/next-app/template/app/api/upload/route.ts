import { api } from "../../../lib/api";

export const POST = (req: Request) => api.handleRoute(req, { endpoint: "/upload", method: "POST", maxBodyBytes: 64 * 1024 });
