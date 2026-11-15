// ── Typed endpoints ──────────────────────────────────────────────
//
//   const getUser = api.endpoint({ method: "GET", path: "/users/:id", response: User });
//   const r = await getUser({ path: { id: 7 } });   // ApiResult<User>
//
// Path params are inferred from the template and percent-encoded (no
// traversal), response / body types come from the schemas.

import { unwrap } from "../core/result";
import { fillPathTemplate } from "../http/url";
import type { HttpMethod, ParamValue } from "../types/http";
import type { RequestOptions } from "../types/request";
import type { ApiResult } from "../types/result";
import type { InferOutput, Schema } from "../types/schema";

/** First path segment of a `:param` tail (internal helper of `PathParamNames`). */
export type PathParamName<S extends string> = S extends `${infer P}/${string}` ? P : S extends `${infer P}?${string}` ? P : S;

/** `"/users/:id/posts/:postId"` → `"id" | "postId"` */
export type PathParamNames<P extends string> = P extends `${string}:${infer Rest}`
  ? PathParamName<Rest> | PathParamNames<Rest extends `${string}/${infer Tail}` ? `/${Tail}` : "">
  : never;

export type PathParams<P extends string> = [PathParamNames<P>] extends [never]
  ? Record<string, never>
  : { [K in PathParamNames<P>]: string | number };

export interface EndpointDefinition<
  P extends string = string,
  TResponse = unknown,
  TBody = never,
  TQuery extends Record<string, ParamValue> = Record<string, ParamValue>,
> {
  method?: HttpMethod;
  path: P;
  response?: Schema<TResponse>;
  body?: Schema<TBody>;
  query?: Schema<TQuery>;
  /** Defaults merged into every call. */
  defaults?: Omit<RequestOptions<TBody, TResponse>, "endpoint" | "method" | "body" | "params">;
}

export type EndpointInput<P extends string, TBody, TQuery> = Omit<
  RequestOptions<TBody, unknown>,
  "endpoint" | "method" | "body" | "params" | "schema" | "responseSchema"
> &
  ([keyof PathParams<P>] extends [never] ? { path?: PathParams<P> } : { path: PathParams<P> }) &
  ([TBody] extends [never] ? { body?: never } : unknown extends TBody ? { body?: TBody } : { body: TBody }) & {
    query?: TQuery;
  };

export interface Endpoint<P extends string, TResponse, TBody, TQuery> {
  (input: EndpointInput<P, TBody, TQuery>): Promise<ApiResult<TResponse>>;
  readonly definition: EndpointDefinition<P, TResponse, TBody, TQuery & Record<string, ParamValue>>;
  /** Resolved relative URL for an input. */
  url(input: Pick<EndpointInput<P, TBody, TQuery>, "path">): string;
  /** Stable key for client caches (TanStack Query, SWR). */
  queryKey(input?: Partial<EndpointInput<P, TBody, TQuery>>): readonly unknown[];
  /** `{ queryKey, queryFn }` for TanStack Query (`useQuery(getUser.queryOptions({...}))`). */
  queryOptions(input: EndpointInput<P, TBody, TQuery>): {
    queryKey: readonly unknown[];
    queryFn: (ctx: { signal?: AbortSignal }) => Promise<TResponse>;
  };
  /** `{ mutationKey, mutationFn }` for TanStack Query mutations. */
  mutationOptions(): {
    mutationKey: readonly unknown[];
    mutationFn: (input: EndpointInput<P, TBody, TQuery>) => Promise<TResponse>;
  };
}

export type Requester = <TResponse, TBody>(options: RequestOptions<TBody, TResponse>) => Promise<ApiResult<TResponse>>;

/** Declare an endpoint without binding it (bind with `api.endpoint(def)` or `bindEndpoints`). */
export function defineEndpoint<
  const P extends string,
  S extends Schema<unknown> | undefined = undefined,
  B = never,
  Q extends Record<string, ParamValue> = Record<string, ParamValue>,
>(
  def: Omit<EndpointDefinition<P, InferOutput<S>, B, Q>, "response"> & { response?: S },
): EndpointDefinition<P, S extends undefined ? unknown : InferOutput<S>, B, Q> {
  return def as EndpointDefinition<P, S extends undefined ? unknown : InferOutput<S>, B, Q>;
}

export function bindEndpoint<P extends string, TResponse, TBody, TQuery extends Record<string, ParamValue>>(
  request: Requester,
  def: EndpointDefinition<P, TResponse, TBody, TQuery>,
): Endpoint<P, TResponse, TBody, TQuery> {
  const method = def.method ?? "GET";
  const toUrl = (input: { path?: Record<string, string | number> | undefined }): string =>
    fillPathTemplate(def.path, input.path as Record<string, string | number> | undefined);

  const call = (input: EndpointInput<P, TBody, TQuery>): Promise<ApiResult<TResponse>> => {
    const {
      path: _path,
      query,
      body,
      ...rest
    } = input as EndpointInput<P, TBody, TQuery> & {
      path?: Record<string, string | number>;
      body?: TBody;
    };
    let endpoint: string;
    try {
      endpoint = toUrl(input as { path?: Record<string, string | number> });
    } catch (err) {
      return Promise.resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: 400,
        code: "INVALID_URL",
      });
    }
    return request<TResponse, TBody>({
      ...def.defaults,
      ...rest,
      endpoint,
      method,
      metricsLabel: `${method} ${def.path}`,
      ...(query ? { params: query } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(def.body ? { schema: def.body } : {}),
      ...(def.response ? { responseSchema: def.response } : {}),
    } as RequestOptions<TBody, TResponse>);
  };

  const keyOf = (input?: Partial<EndpointInput<P, TBody, TQuery>>): readonly unknown[] => {
    const i = (input ?? {}) as { path?: unknown; query?: unknown; body?: unknown };
    return [method, def.path, i.path ?? {}, i.query ?? {}, ...(i.body !== undefined ? [i.body] : [])] as const;
  };

  return Object.assign(call, {
    definition: def,
    url: (input: Pick<EndpointInput<P, TBody, TQuery>, "path">) => toUrl(input as { path?: Record<string, string | number> }),
    queryKey: keyOf,
    queryOptions: (input: EndpointInput<P, TBody, TQuery>) => ({
      queryKey: keyOf(input),
      queryFn: async ({ signal }: { signal?: AbortSignal }) =>
        unwrap(await call({ ...input, ...(signal ? { signal } : {}) } as EndpointInput<P, TBody, TQuery>)),
    }),
    mutationOptions: () => ({
      mutationKey: [method, def.path] as const,
      mutationFn: async (input: EndpointInput<P, TBody, TQuery>) => unwrap(await call(input)),
    }),
  }) as Endpoint<P, TResponse, TBody, TQuery>;
}

/** Bind a record of definitions to an engine: `const client = bindEndpoints(api, defs)`. */
export function bindEndpoints<D extends Record<string, EndpointDefinition<string, unknown, unknown, Record<string, ParamValue>>>>(
  request: Requester,
  defs: D,
): {
  [K in keyof D]: D[K] extends EndpointDefinition<infer P, infer R, infer B, infer Q> ? Endpoint<P, R, B, Q> : never;
} {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(defs)) out[name] = bindEndpoint(request, def);
  return out as never;
}
