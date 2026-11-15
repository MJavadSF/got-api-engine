# Endpointهای تایپ‌شده و تولید کد

## تعریف endpoint

```ts
import { defineEndpoint } from "got-api-engine";
import { z } from "zod";

const Post = z.object({ id: z.string(), title: z.string() });

export const updatePost = api.endpoint(
  defineEndpoint({ method: "PUT", path: "/users/:userId/posts/:postId", body: Post.omit({ id: true }), response: Post }),
);

const r = await updatePost({ path: { userId: 1, postId: "a/b" }, body: { title: "سلام" } });
//    ^ ApiResult<{ id: string; title: string }>
```

- پارامترهای مسیر **الزامی، تایپ‌شده و encode‌شده** هستند و `".."` رد می‌شود.
- body قبل از ارسال و پاسخ بعد از دریافت اعتبارسنجی می‌شوند.
- metricهای هر route با الگوی مسیر ثبت می‌شوند (`PUT /users/:userId/posts/:postId`).

هر schemaی که [Standard Schema](https://standardschema.dev) را پیاده کند (Zod، Valibot، ArkType و
حتی اعتبارسنجی async) یا `safeParse` داشته باشد قابل استفاده است.

## TanStack Query

```ts
useQuery(getUser.queryOptions({ path: { id } }));
useMutation(updatePost.mutationOptions());
```

## تولید کد از OpenAPI

```bash
npx got-api-engine-codegen openapi.json -o src/api.generated.ts
```

```ts
import { endpoints } from "./api.generated";
const client = api.endpoints(endpoints);
await client.getUser({ path: { id: "1" } }); // کاملاً تایپ‌شده
```

ورودی باید JSON باشد (فایل YAML را اول به JSON تبدیل کنید).
