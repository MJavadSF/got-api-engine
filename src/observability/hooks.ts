// ── Lifecycle hook runner (hooks never break a request) ─────────

import { asArray } from "../http/misc";
import type { EngineHooks, LoggerInterface } from "../types/observability";

type HookArg<K extends keyof EngineHooks> = Parameters<Extract<NonNullable<EngineHooks[K]>, (...a: never[]) => unknown>>[0];
type HookFn = (arg: unknown) => void | Promise<void>;

const NAMES: ReadonlyArray<keyof EngineHooks> = ["onRequest", "onResponse", "onError", "onCircuitStateChange", "onRetry"];

export class HookRunner {
  /** Normalised once: the hot path only checks an array length. */
  private readonly lists: Record<keyof EngineHooks, HookFn[]>;

  constructor(
    hooks: EngineHooks | undefined,
    private readonly log: LoggerInterface,
  ) {
    this.lists = Object.fromEntries(NAMES.map((n) => [n, asArray(hooks?.[n] as unknown) as HookFn[]])) as Record<
      keyof EngineHooks,
      HookFn[]
    >;
  }

  /** Cheap guard so callers can skip building a payload nobody listens to. */
  has(name: keyof EngineHooks): boolean {
    return this.lists[name].length > 0;
  }

  async emit<K extends keyof EngineHooks>(name: K, arg: HookArg<K>): Promise<void> {
    for (const hook of this.lists[name]) {
      try {
        await hook(arg);
      } catch (err) {
        this.log.warn(`Hook ${String(name)} threw`, { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
