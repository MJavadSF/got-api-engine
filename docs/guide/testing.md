# Testing your app

```ts
import { createMockEngine, recorder } from "got-api-engine/testing";

const api = createMockEngine({
  "GET /users/:id": ({ params }) => ({ body: { id: params.id } }),
  "POST /users": { status: 201, body: { id: "1" } },
  "* /flaky": { status: 503 },
});
```

Unmatched requests fail with `MOCK_NOT_FOUND` (or pass through with
`passthrough: true`). Mocks run as middleware, so retries, caching, schemas
and key transforms behave exactly as in production.

## Record and replay

```ts
createEngine({
  baseUrl,
  middleware: [recorder({ dir: "test/fixtures", mode: process.env.CI ? "replay" : "auto" })],
});
```

`record` always hits the network and saves fixtures, `replay` never does,
`auto` replays when a fixture exists.
