import { afterEach } from "vitest";
import { createNextEngine, type NextApiEngine } from "../src/adapters/next/index";
import { createEngine, type EngineConfig, type GotApiEngine } from "../src/index";
import { startServer, type TestServer } from "./server";

/** Per-file helpers that clean up servers and engines after every test. */
export function useHarness() {
  const servers: TestServer[] = [];
  const engines: GotApiEngine[] = [];
  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.dispose()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  return {
    async serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
      const s = await startServer(handler);
      servers.push(s);
      return s;
    },
    engine(cfg: EngineConfig): GotApiEngine {
      const e = createEngine({ logLevel: "silent", ...cfg });
      engines.push(e);
      return e;
    },
    next(cfg: EngineConfig): NextApiEngine {
      const e = createNextEngine({ logLevel: "silent", ...cfg });
      engines.push(e);
      return e;
    },
    track<T extends GotApiEngine>(e: T): T {
      engines.push(e);
      return e;
    },
  };
}

/** A schema that accepts `{ v: number }` (safeParse style). */
export const numberV = {
  safeParse: (d: unknown) =>
    typeof (d as { v?: unknown } | null)?.v === "number"
      ? { success: true as const, data: d as { v: number } }
      : { success: false as const, error: { issues: [{ message: "v must be a number", path: ["v"] }] } },
};

/** A Standard Schema v1 accepting `{ name: string }`, trimming the name. */
export const standardName = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: async (value: unknown) => {
      const name = (value as { name?: unknown } | null)?.name;
      return typeof name === "string"
        ? { value: { name: name.trim() } }
        : { issues: [{ message: "name is required", path: [{ key: "name" }] }] };
    },
  },
};
