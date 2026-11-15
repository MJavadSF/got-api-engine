# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 4.x     | ✅        |
| < 4.0   | ❌ — please upgrade (see the migration guide in CHANGELOG.md) |

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/MJavadSF/got-api-engine/security/advisories/new)
and include a minimal reproduction. You will get an answer within 7 days.

## Security-relevant defaults (v4)

- TLS verification on in every environment; custom CAs via `tls.ca` instead of disabling it.
- Engine credentials are only sent to `baseUrl` origins and `credentialHosts`, and are stripped
  (including custom headers such as `X-API-Key`) on redirects to any other origin.
- Relative endpoints may not contain dot segments or escape the base path (`strictPath`).
- Buffered responses are capped (`maxResponseBytes`, 50 MiB); Next.js request bodies too (`maxBodyBytes`, 10 MiB).
- Cache keys contain only HMACs of credentials and query strings (`cache.keySecret`).
- Next.js error responses never include internal hostnames, IPs or upstream 5xx details.
- `X-Forwarded-For` is not forwarded unless `forwardClientIp: true`.
- Logs and hook payloads are redacted (`authorization`, `cookie`, `*token*`, `*secret*`, …).
