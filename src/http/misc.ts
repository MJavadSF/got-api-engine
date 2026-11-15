// ── Small, dependency-free utilities ─────────────────────────────

import { randomUUID } from "node:crypto";
import type { Timings } from "../types/http";

export const generateRequestId = (): string => randomUUID();
export const generateIdempotencyKey = (): string => randomUUID();

/** Accept an externally supplied correlation id only if it is header-safe. */
export function sanitizeRequestId(id: string | null | undefined): string | undefined {
  return id && /^[\w.:-]{1,128}$/.test(id) ? id : undefined;
}

const XFF_SAFE = /^[\d.,: a-fA-F]+$/;
/** Accept an X-Forwarded-For value only if it looks like a list of IPs. */
export function sanitizeForwardedFor(xff: string | null): string | null {
  return xff && XFF_SAFE.test(xff) ? xff : null;
}

export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

/** Circular-reference-safe JSON stringifier (bigint → string). */
export function safeStringify(value: unknown, maxDepth = 3, space: number | undefined = 2): string {
  const ancestors: object[] = [];
  const out = JSON.stringify(
    value,
    function (this: unknown, _key: string, v: unknown): unknown {
      if (typeof v === "bigint") return v.toString();
      if (typeof v !== "object" || v === null) return v;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(v)) return "[Circular]";
      if (ancestors.length >= maxDepth) return "[Object]";
      ancestors.push(v);
      return v;
    },
    space,
  );
  return out ?? "undefined";
}

/**
 * Read a user id from an (UNVERIFIED) JWT for logging/correlation only.
 * Never use it for authorization decisions.
 */
export function getUserIdFromBearerToken(authHeader?: string | null): string | undefined {
  if (!authHeader || !/^Bearer\s/i.test(authHeader)) return undefined;
  const payload = decodeJwtPayload(authHeader.replace(/^Bearer\s+/i, ""));
  const id = payload?.["sub"] ?? payload?.["userId"] ?? payload?.["id"];
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** got's `response.timings.phases` → our `Timings`. */
export function toTimings(phases: Partial<Record<keyof Timings, number | undefined>> | undefined): Timings | undefined {
  if (!phases) return undefined;
  const pick = (v: number | undefined): number | undefined => (v === undefined ? undefined : Math.round(v));
  return {
    wait: pick(phases.wait),
    dns: pick(phases.dns),
    tcp: pick(phases.tcp),
    tls: pick(phases.tls),
    request: pick(phases.request),
    firstByte: pick(phases.firstByte),
    download: pick(phases.download),
    total: pick(phases.total),
  };
}

export function asArray<T>(v: T | readonly T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? [...(v as readonly T[])] : [v as T];
}
