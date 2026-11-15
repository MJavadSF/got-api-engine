// ── Pagination as an async iterator ──────────────────────────────
//
//   for await (const order of api.paginate<Order>("/orders", { strategy: "cursor" })) …
//
// Strategies: RFC 8288 `Link: <…>; rel="next"`, cursor, page number, or a
// custom `next()` function. Errors are thrown as `ApiError`.

import { ApiError } from "../errors/api-error";
import { parseLinkHeader } from "../http/directives";
import { getHeader } from "../http/headers";
import type { ParamValue } from "../types/http";
import type { RequestOptions } from "../types/request";
import type { ApiResult, SuccessResult } from "../types/result";

export interface PaginateOptions<T> extends Omit<RequestOptions<never, unknown>, "endpoint"> {
  /** @default "link" */
  strategy?: "link" | "cursor" | "page";
  /** Items of one page. @default data.items ?? data.data ?? data.results ?? data (if array) */
  items?: (data: unknown) => readonly T[];
  /** cursor: query param name. @default "cursor" */
  cursorParam?: string;
  /** cursor: next cursor from a page. @default data.nextCursor ?? data.next_cursor ?? data.cursor?.next */
  nextCursor?: (data: unknown) => string | number | null | undefined;
  /** page: query param name. @default "page" */
  pageParam?: string;
  /** page: first page number. @default 1 */
  startPage?: number;
  /** Fully custom continuation: return the next request (or null to stop). */
  next?: (page: SuccessResult<unknown>, current: RequestOptions<never, unknown>) => RequestOptions<never, unknown> | null;
  /** Safety cap. @default 1000 */
  maxPages?: number;
}

type Requester = (options: RequestOptions<never, unknown>) => Promise<ApiResult<unknown>>;

function defaultItems<T>(data: unknown): readonly T[] {
  if (Array.isArray(data)) return data as T[];
  const d = data as Record<string, unknown> | null;
  const list = d?.["items"] ?? d?.["data"] ?? d?.["results"];
  return Array.isArray(list) ? (list as T[]) : [];
}

function defaultCursor(data: unknown): string | number | undefined {
  const d = data as Record<string, unknown> | null;
  const c = d?.["nextCursor"] ?? d?.["next_cursor"] ?? (d?.["cursor"] as Record<string, unknown> | undefined)?.["next"];
  return typeof c === "string" || typeof c === "number" ? c : undefined;
}

export async function* paginate<T>(
  request: Requester,
  baseUrl: string,
  endpoint: string,
  options: PaginateOptions<T> = {},
): AsyncGenerator<T, void, undefined> {
  const {
    strategy = "link",
    items = defaultItems<T>,
    cursorParam = "cursor",
    nextCursor = defaultCursor,
    pageParam = "page",
    startPage = 1,
    next,
    maxPages = 1000,
    ...base
  } = options;

  let current: RequestOptions<never, unknown> | null = {
    ...base,
    endpoint,
    ...(strategy === "page" && !next ? { params: { ...base.params, [pageParam]: startPage } } : {}),
  };
  let page = startPage;

  for (let n = 0; current && n < maxPages; n++) {
    const res = await request(current);
    if (!res.ok) throw new ApiError(res);
    const list = items(res.data);
    for (const item of list) yield item;

    if (next) {
      current = next(res, current);
      continue;
    }
    if (strategy === "link") {
      // `next` links carry their own query string; resolve relative links against the base origin.
      const link = parseLinkHeader(getHeader(res.headers ?? {}, "link"))["next"];
      const { params: _drop, ...rest } = base;
      current = link ? { ...rest, endpoint: new URL(link, `${baseUrl}/`).href } : null;
    } else if (strategy === "cursor") {
      const c = nextCursor(res.data);
      current =
        c === undefined || c === null || c === ""
          ? null
          : { ...current, params: { ...current.params, [cursorParam]: c } as Record<string, ParamValue> };
    } else {
      if (list.length === 0) return;
      page++;
      current = { ...current, params: { ...current.params, [pageParam]: page } };
    }
  }
}
