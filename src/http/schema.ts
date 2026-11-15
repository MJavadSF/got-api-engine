// ── Schema validation (safeParse when available, else Standard Schema v1) ──

import type { Schema, StandardSchemaIssue, StandardSchemaV1, ZodLike } from "../types/schema";

export type Validation<T> = { ok: true; data: T } | { ok: false; details: unknown };

function isStandard(schema: unknown): schema is StandardSchemaV1<unknown, unknown> {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as Partial<StandardSchemaV1>)["~standard"]?.validate === "function"
  );
}

/** Serialisable payload from a schema library's failure object. */
export function schemaErrorDetails(error: { flatten?: () => unknown; issues?: unknown } | undefined): unknown {
  if (!error) return undefined;
  if (typeof error.flatten === "function") {
    try {
      return error.flatten();
    } catch {
      /* fall through */
    }
  }
  return error.issues ?? error;
}

function standardIssues(issues: ReadonlyArray<StandardSchemaIssue>): unknown {
  return issues.map((i) => ({
    message: i.message,
    ...(i.path
      ? { path: i.path.map((p) => (typeof p === "object" && p !== null && "key" in p ? (p as { key: unknown }).key : p)) }
      : {}),
  }));
}

export async function validateSchema<T>(schema: Schema<T>, value: unknown): Promise<Validation<T>> {
  try {
    // Prefer `safeParse` when present (sync, richer `flatten()` details).
    if (typeof (schema as Partial<ZodLike<T>>).safeParse !== "function" && isStandard(schema)) {
      const res = await schema["~standard"].validate(value);
      return res.issues ? { ok: false, details: standardIssues(res.issues) } : { ok: true, data: res.value as T };
    }
    const parsed = (schema as ZodLike<T>).safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, details: schemaErrorDetails(parsed.error) };
  } catch (err) {
    return { ok: false, details: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
