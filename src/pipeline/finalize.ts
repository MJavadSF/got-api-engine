// ── Finalize stage: per-caller shaping of a raw result ───────────
//
// Runs once per caller (leader, dedupe follower or cache hit alike), so each
// caller gets its own key transforms and its own `responseSchema` check.

import { fail } from "../core/result";
import type { MessageResolver } from "../errors/messages";
import { validateSchema } from "../http/schema";
import { transformKeys } from "../http/transform";
import type { EngineConfig } from "../types/config";
import type { RequestOptions } from "../types/request";
import type { ApiResult } from "../types/result";

export async function finalizeResult(
  result: ApiResult<unknown>,
  options: RequestOptions<unknown, unknown>,
  config: EngineConfig,
  messages: MessageResolver,
): Promise<ApiResult<unknown>> {
  if (!result.ok || options.responseType === "stream") return result;

  const keyCase =
    options.transformKeys === false ? undefined : (options.transformKeys?.response ?? config.transformKeys?.response);
  let data = keyCase ? transformKeys(result.data, keyCase) : result.data;

  if (options.responseSchema) {
    const v = await validateSchema(options.responseSchema, data);
    if (!v.ok) {
      return fail(messages("RESPONSE_VALIDATION"), 502, {
        code: "RESPONSE_VALIDATION",
        details: v.details,
        ...(result.meta ? { meta: result.meta } : {}),
      });
    }
    data = v.data;
  }
  return data === result.data ? result : { ...result, data };
}

/** Replace a failure with the caller's `fallback`, if any. */
export async function applyFallback(
  result: ApiResult<unknown>,
  options: RequestOptions<unknown, unknown>,
): Promise<ApiResult<unknown> | null> {
  if (result.ok || options.fallback === undefined) return null;
  const fb = options.fallback;
  const data = typeof fb === "function" ? await (fb as (e: typeof result) => unknown)(result) : fb;
  return {
    ok: true,
    data,
    status: 200,
    meta: { ...result.meta, fallback: true, fallbackFrom: result.code },
  };
}
