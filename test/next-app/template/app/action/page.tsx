// A real Server Action, posted as a plain HTML form (no JavaScript needed).
import { redirect } from "next/navigation";
import { api } from "../../lib/api";

export const dynamic = "force-dynamic";

async function createUser(form: FormData) {
  "use server";
  const state = await api.serverForm<{ created: Record<string, unknown> }>("POST", "/users", form);
  redirect(`/action?state=${encodeURIComponent(JSON.stringify(state))}`);
}

// Next 15+ passes a Promise; Next 14 passes a plain object (awaiting it is harmless).
export default async function ActionPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const params = await searchParams;
  return (
    <main>
      <form action={createUser}>
        <input name="name" defaultValue="" />
        <button type="submit">save</button>
      </form>
      <pre id="state">{params.state ?? ""}</pre>
    </main>
  );
}
