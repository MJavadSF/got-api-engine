# Security

| Protection | Default |
| --- | --- |
| TLS verification in every environment; custom CA / mTLS via `tls` | on |
| Credentials only to trusted origins, stripped (incl. custom headers) on foreign redirects | on |
| Path-traversal guard (`strictPath`) | on |
| Response size cap (`maxResponseBytes`) | 50 MiB |
| Next.js request body cap (`maxBodyBytes`) | 10 MiB |
| HMAC'd credentials / query strings in cache keys | on |
| Log and hook redaction (`authorization`, `cookie`, `*token*`, `*secret*`, `session`, …) | on |
| Generic error messages to browsers for infrastructure errors / upstream 5xx | on |
| `X-Forwarded-For` forwarding | off |
| SSRF guard (`ssrfProtection`) | opt-in |
| CSRF origin check for cookie-authenticated routes (`csrf`) | opt-in |

## SSRF

Enable `ssrfProtection: true` on any engine that requests user-supplied URLs.
It blocks private, loopback, link-local and reserved ranges (IPv4 and IPv6,
including IPv4-mapped, Teredo and NAT64), checks the **resolved** address at
connect time (defeating DNS rebinding — also for HTTP/2) and validates every
redirect. `allowHosts` / `blockHosts` refine it.

## Client errors

Malformed input never reaches the network: invalid headers and
non-serialisable bodies fail with `REQUEST_INVALID` before any attempt.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/MJavadSF/got-api-engine/blob/main/SECURITY.md).
