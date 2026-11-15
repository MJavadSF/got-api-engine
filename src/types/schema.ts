// ── Schema interop: Standard Schema v1 + legacy Zod-like safeParse ──

/** Minimal Standard Schema v1 surface (Zod ≥3.24, Valibot, ArkType, …). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** Legacy structural schema (anything with `safeParse`). */
export interface ZodLike<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { flatten?: () => unknown; issues?: unknown } };
}

/** Any schema the engine accepts. */
export type Schema<T = unknown> = StandardSchemaV1<unknown, T> | ZodLike<T>;

/** Output type of a schema. */
export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : S extends ZodLike<infer T> ? T : unknown;
