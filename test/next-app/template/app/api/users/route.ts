import { z } from "zod";
import { api } from "../../../lib/api";

const NewUser = z.object({ name: z.string().min(2) });

export const GET = (req: Request) => api.handleRoute(req, { endpoint: "/users", forwardRequestHeaders: ["accept-language"] });

export const POST = (req: Request) => api.handleRoute(req, { endpoint: "/users", method: "POST", schema: NewUser });
