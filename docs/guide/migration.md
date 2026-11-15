# Upgrading to v4

## Codemod

```bash
npx got-api-engine-codemod v4 src/            # safe rewrites + a report of what needs a human
npx got-api-engine-codemod v4 src/ --dry      # report only
npx got-api-engine-codemod v4 src/ --preserve-behavior
```

- **Always:** `cache.cloneOnRead` → `copy`, TODOs on deprecated browser-storage auth.
- **`--preserve-behavior`:** pins v3 defaults explicitly — `totalTimeoutMs: 0`,
  `strictPath: false`, `circuitBreaker.scope: "engine"`, `forwardClientIp: true` —
  so upgrading changes nothing until you decide.
- **Reported (file:line):** `status === 500` checks, `body: null`,
  `successCount` / `errorCount`, routes relying on `X-Forwarded-For`,
  deep imports.

## Breaking changes

| Area | v3 | v4 |
| --- | --- | --- |
| Node.js | `>=22.0.0` | `>=22.12.0` |
| Overall deadline | none | `totalTimeoutMs: 30000` (`0` disables) |
| Network error status | 500 | **502** (`NETWORK_ERROR`) |
| Client-side errors | `NETWORK_ERROR`, retried | `REQUEST_INVALID` (400) |
| Circuit breaker | one per engine | one per host |
| Next.js `forwardClientIp` | `true` | `false` |
| Next.js 5xx / infra errors | upstream message | generic localised message |
| Path traversal in endpoints | allowed | rejected |
| `Cache-Control: no-store` request header | always sent | not sent |
| `body: null` / numbers | dropped / `String()` | sent as JSON |
| Metrics | — | request-level vs `upstream*` counters |
| Peer deps | `next`, `react`, `zod`, `winston` | `winston` (optional) |
| `BrowserStorageAuthProvider` | supported | deprecated |

The full list is in the [changelog](https://github.com/MJavadSF/got-api-engine/blob/main/CHANGELOG.md).
