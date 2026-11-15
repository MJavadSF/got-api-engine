// ── Koa-style middleware composition ────────────────────────────

import type { Middleware, MiddlewareContext } from "../types/middleware";
import type { ApiResult } from "../types/result";

export function compose(
  middleware: readonly Middleware[],
  terminal: (ctx: MiddlewareContext) => Promise<ApiResult<unknown>>,
): (ctx: MiddlewareContext) => Promise<ApiResult<unknown>> {
  return (ctx) => {
    let index = -1;
    const dispatch = (i: number): Promise<ApiResult<unknown>> => {
      if (i <= index) return Promise.reject(new Error("next() called multiple times"));
      index = i;
      const mw = middleware[i];
      if (!mw) return terminal(ctx);
      return mw(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
