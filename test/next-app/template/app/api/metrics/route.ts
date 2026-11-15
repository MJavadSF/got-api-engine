import { api } from "../../../lib/api";

export const dynamic = "force-dynamic";

export const GET = () => new Response(api.metricsText(), { headers: { "content-type": "text/plain; version=0.0.4" } });
