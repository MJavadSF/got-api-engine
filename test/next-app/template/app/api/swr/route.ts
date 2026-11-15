import { api } from "../../../lib/api";

export const dynamic = "force-dynamic";

// Cached with stale-while-revalidate: the background refresh runs via `after`.
export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/counter" });
