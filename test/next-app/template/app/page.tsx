// Server Component: the engine runs during rendering.
import { api } from "../lib/api";

export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await api.serverGet<{ id: number; name: string }>("/users/1", { cache: false });
  return <pre id="data">{JSON.stringify(r.ok ? r.data : { error: r.code })}</pre>;
}
