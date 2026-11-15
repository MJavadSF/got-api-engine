// ── Data transforms: copy protection and key casing ──────────────

import type { KeyCase } from "../types/request";

/** Deep copy for JSON-like data; Buffers / typed arrays are copied too. */
export function cloneBody<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as unknown as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as unknown as T;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Recursively freeze plain objects / arrays (Buffers are left alone). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return value;
}

const toCamel = (k: string): string => k.replace(/[_-]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
const toSnake = (k: string): string =>
  k
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

export function keyTransformer(kind: KeyCase): (key: string) => string {
  if (kind === "camel") return toCamel;
  if (kind === "snake") return toSnake;
  return kind;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Rename keys of plain objects (deep, arrays included). Other values untouched. */
export function transformKeys(value: unknown, kind: KeyCase): unknown {
  const fn = keyTransformer(kind);
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[fn(k)] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0);
}

export { isPlainObject };
