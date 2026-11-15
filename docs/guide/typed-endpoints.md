# Typed endpoints and codegen

## Endpoints

```ts
import { defineEndpoint } from "got-api-engine";
import { z } from "zod";

const Post = z.object({ id: z.string(), title: z.string() });

export const updatePost = api.endpoint(
  defineEndpoint({ method: "PUT", path: "/users/:userId/posts/:postId", body: Post.omit({ id: true }), response: Post }),
);

const r = await updatePost({ path: { userId: 1, postId: "a/b" }, query: { notify: true }, body: { title: "Hi" } });
//    ^ ApiResult<{ id: string; title: string }>
```

- Path parameters are **required, typed and percent-encoded**; `".."` is rejected.
- The body is validated before sending, the response after receiving.
- Per-route metrics use the template (`PUT /users/:userId/posts/:postId`).

Any [Standard Schema](https://standardschema.dev) works — Zod ≥ 3.24, Valibot,
ArkType, with async validation — as well as anything exposing `safeParse`.

## TanStack Query

```ts
useQuery(getUser.queryOptions({ path: { id } }));
useMutation(updatePost.mutationOptions());
getUser.queryKey({ path: { id } }); // ["GET", "/users/:id", { id }, {}]
```

## OpenAPI → TypeScript

```bash
npx got-api-engine-codegen openapi.json -o src/api.generated.ts
```

```ts
import { endpoints } from "./api.generated";
const client = api.endpoints(endpoints);
await client.getUser({ path: { id: "1" } }); // fully typed
```

The generator emits a type per `components.schemas` entry (objects, arrays,
enums, `oneOf` / `anyOf` / `allOf`, nullable) and one definition per
operation (`operationId` → name). Input must be JSON (convert YAML first).
