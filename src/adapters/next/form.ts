// ── Server Action form state (React `useActionState`) ────────────

import type { ApiResult } from "../../types/result";

export type FormState<T = unknown> =
  | { ok: true; data: T; message?: undefined; fieldErrors?: undefined }
  | { ok: false; message: string; code?: string | undefined; fieldErrors?: Record<string, string[]> | undefined };

function fieldErrorsFrom(details: unknown): Record<string, string[]> | undefined {
  // Zod `flatten()` shape.
  const flat = details as { fieldErrors?: Record<string, unknown> } | undefined;
  if (flat?.fieldErrors && typeof flat.fieldErrors === "object") {
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat.fieldErrors)) if (Array.isArray(v)) out[k] = v.map(String);
    return Object.keys(out).length ? out : undefined;
  }
  // Standard Schema issues: [{ message, path }].
  if (Array.isArray(details)) {
    const out: Record<string, string[]> = {};
    for (const issue of details as Array<{ message?: unknown; path?: unknown[] }>) {
      const key = Array.isArray(issue.path) && issue.path.length ? issue.path.map(String).join(".") : "_form";
      out[key] = [...(out[key] ?? []), String(issue.message ?? "Invalid value")];
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/** Serialisable state for `useActionState`, with per-field validation errors. */
export function toFormState<T>(result: ApiResult<T>): FormState<T> {
  if (result.ok) return { ok: true, data: result.data };
  return { ok: false, message: result.error, code: result.code, fieldErrors: fieldErrorsFrom(result.details) };
}

/** FormData → plain object (repeated keys → arrays). Files keep FormData semantics. */
export function formDataToObject(form: FormData): Record<string, unknown> | FormData {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") return form; // contains files → send as multipart
    if (key.startsWith("$ACTION")) continue; // React internal fields
    const prev = out[key];
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}
