# Authentication

```ts
auth: "token"                                          // static (bare tokens become Bearer)
auth: () => getToken()                                 // sync or async function
auth: createApiKeyAuth("k", "X-API-Key")
auth: createBasicAuth("user", "pass")
auth: createRefreshableAuth({ refresh: fetchToken })   // cached until expiry, single-flight refresh
auth: createOAuth2ClientCredentials({ tokenUrl, clientId, clientSecret, scope })
refreshAuth: async () => newToken                      // optional hook on 401
```

## Required, optional, none

`defaultAuth: true` (the default) makes credentials required —
`AUTH_REQUIRED` when none are available. Per request use `auth: false`,
`auth: "optional"` or an explicit `authToken`.

## Scoping

The engine's credentials are only sent to the `baseUrl` origins and to
`credentialHosts`. An absolute URL to any other host gets
`CREDENTIALS_BLOCKED` (or no credentials with `"optional"`), and every
credential header — including custom ones such as `X-API-Key` — is stripped
on redirects to foreign origins.

## 401 refresh

After an upstream 401 on a request that used the engine's credentials, the
engine refreshes **once, single-flight** across concurrent requests and
replays the request:

- with `refreshAuth`: its return value becomes the new token (or nothing, if
  your `auth` source now returns the fresh one);
- otherwise, a provider exposing `refreshNow()` (e.g. `createRefreshableAuth`,
  `createOAuth2ClientCredentials`) is refreshed automatically.

Extra headers from the provider (`getHeaders`) are kept across refreshes.
