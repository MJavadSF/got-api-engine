// In-memory Redis fake with real expiry semantics for every key type.
// PTTL: -2 missing, -1 no expiry. SCAN MATCH honours glob escapes.
import { ADD_TO_INDEX_SCRIPT, type RedisLike } from "../src/stores/redis";

interface Slot {
  kind: "string" | "set";
  value: string | Set<string>;
  expiresAt: number | null;
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "\\" && i + 1 < glob.length) re += `\\${glob[++i]}`;
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

export interface FakeRedis extends RedisLike {
  readonly data: Map<string, Slot>;
  commands: string[];
}

export function fakeRedis(options: { withEval?: boolean } = {}): FakeRedis {
  const data = new Map<string, Slot>();
  const commands: string[] = [];
  const live = (k: string): Slot | undefined => {
    const s = data.get(k);
    if (s && s.expiresAt !== null && s.expiresAt <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return s;
  };
  const pttl = (k: string): number => {
    const s = live(k);
    if (!s) return -2;
    return s.expiresAt === null ? -1 : Math.max(0, s.expiresAt - Date.now());
  };
  const pexpire = (k: string, ms: number): number => {
    const s = live(k);
    if (!s) return 0;
    s.expiresAt = Date.now() + ms;
    return 1;
  };
  const sadd = (k: string, members: string[]): number => {
    const s = live(k) ?? { kind: "set" as const, value: new Set<string>(), expiresAt: null };
    data.set(k, s);
    let added = 0;
    for (const m of members) {
      const set = s.value as Set<string>;
      if (!set.has(m)) added++;
      set.add(m);
    }
    return added;
  };

  const redis: FakeRedis = {
    data,
    commands,
    get: async (k) => {
      commands.push("get");
      const s = live(k);
      return s?.kind === "string" ? (s.value as string) : null;
    },
    set: async (k, v, _mode, ttl) => {
      commands.push("set");
      data.set(k, { kind: "string", value: v, expiresAt: Date.now() + ttl });
      return "OK";
    },
    del: async (...keys) => {
      commands.push("del");
      return keys.reduce((n, k) => n + (live(k) && data.delete(k) ? 1 : 0), 0);
    },
    scan: async (_cursor, _m, pattern) => {
      commands.push("scan");
      const re = globToRegex(pattern);
      return ["0", [...data.keys()].filter((k) => live(k) && re.test(k))];
    },
    sadd: async (k, ...m) => {
      commands.push("sadd");
      return sadd(k, m);
    },
    smembers: async (k) => {
      commands.push("smembers");
      const s = live(k);
      return s?.kind === "set" ? [...(s.value as Set<string>)] : [];
    },
    pexpire: async (k, ms) => {
      commands.push("pexpire");
      return pexpire(k, ms);
    },
    incr: async (k) => {
      commands.push("incr");
      const s = live(k);
      const n = Number(s?.value ?? 0) + 1;
      data.set(k, { kind: "string", value: String(n), expiresAt: s?.expiresAt ?? null });
      return n;
    },
    pttl: async (k) => {
      commands.push("pttl");
      return pttl(k);
    },
  };

  if (options.withEval) {
    redis.eval = async (script, _numKeys, key, member, ttl) => {
      commands.push("eval");
      if (script !== ADD_TO_INDEX_SCRIPT) throw new Error("unknown script");
      // Same semantics as the Lua script, executed atomically.
      sadd(String(key), [String(member)]);
      if (pttl(String(key)) < Number(ttl)) pexpire(String(key), Number(ttl));
      return 1;
    };
  }
  return redis;
}
