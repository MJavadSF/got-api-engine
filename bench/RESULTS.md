# Benchmark results

Node v22.23.4 · 2 × Intel(R) Xeon(R) Processor @ 2.30GHz · median of 5 rounds · 2026-11-15

Each run is a fresh process with a 2,000-request warm-up; the upstream runs in its own process on the same machine.
Absolute numbers depend on the machine — compare the columns, not across machines.
**CPU µs/req** (client process only) is the most stable column on shared machines; req/s and latency include the upstream and OS scheduling.

## GET small JSON, 1 in flight (latency)

Unique URL per request, so no client can collapse requests.

| Client | req/s | relative | CPU µs/req | p50 ms | p99 ms | RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| undici.request | 9,712 | 100% | 124.2 | 0.06 | 0.56 | 119 |
| ofetch | 3,828 | 39% | 287.7 | 0.18 | 2.43 | 131 |
| fetch | 3,215 | 33% | 324.8 | 0.2 | 3.36 | 127 |
| ky | 3,158 | 33% | 351.6 | 0.24 | 3.44 | 140 |
| axios | 2,576 | 27% | 402.9 | 0.29 | 3.15 | 123 |
| **got-api-engine (lean)** | 2,110 | 22% | 522.2 | 0.35 | 3.71 | 141 |
| **got-api-engine** | 1,816 | 19% | 607.3 | 0.43 | 3.49 | 142 |
| got | 1,812 | 19% | 575.2 | 0.44 | 3.83 | 139 |

## GET small JSON, 50 in flight (throughput)

Unique URL per request, so no client can collapse requests.

| Client | req/s | relative | CPU µs/req | p50 ms | p99 ms | RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| undici.request | 16,892 | 100% | 76.3 | 1.95 | 15.64 | 137 |
| ofetch | 8,775 | 52% | 153.6 | 3.97 | 20.1 | 155 |
| fetch | 7,603 | 45% | 171.1 | 4.38 | 22.14 | 151 |
| ky | 4,972 | 29% | 262.2 | 8.28 | 33.42 | 192 |
| axios | 4,849 | 29% | 249.3 | 8.88 | 28.86 | 159 |
| got | 4,320 | 26% | 286.1 | 10.58 | 32.54 | 175 |
| **got-api-engine (lean)** | 3,903 | 23% | 317 | 11.54 | 35.26 | 186 |
| **got-api-engine** | 3,158 | 19% | 396 | 14.4 | 41.71 | 179 |

## GET ~400 KB JSON, 10 in flight (parsing)

Unique URL per request, so no client can collapse requests.

| Client | req/s | relative | CPU µs/req | p50 ms | p99 ms | RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| undici.request | 355 | 100% | 3533.8 | 26.56 | 61.96 | 247 |
| fetch | 303 | 85% | 4247.2 | 30.58 | 73.79 | 213 |
| **got-api-engine (lean)** | 299 | 84% | 4278.9 | 28.36 | 76.5 | 227 |
| got | 291 | 82% | 4349.2 | 29.62 | 95.32 | 241 |
| axios | 281 | 79% | 4582.7 | 30.92 | 89.34 | 230 |
| ofetch | 274 | 77% | 4604.5 | 36.04 | 68.77 | 238 |
| **got-api-engine** | 271 | 76% | 4716.8 | 31.11 | 87.62 | 218 |
| ky | 236 | 66% | 5384.7 | 38.99 | 86.99 | 201 |

## POST JSON, 50 in flight

Unique URL per request, so no client can collapse requests.

| Client | req/s | relative | CPU µs/req | p50 ms | p99 ms | RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| undici.request | 13,918 | 100% | 86.9 | 2.24 | 16.03 | 129 |
| fetch | 5,975 | 43% | 227.4 | 7.18 | 24.2 | 163 |
| ofetch | 4,605 | 33% | 288.9 | 8.88 | 33.8 | 167 |
| axios | 3,329 | 24% | 380.3 | 13.03 | 36.61 | 157 |
| got | 2,929 | 21% | 435.5 | 15.79 | 41.44 | 161 |
| **got-api-engine (lean)** | 2,768 | 20% | 468.4 | 16.15 | 41.82 | 174 |
| **got-api-engine** | 2,509 | 18% | 515.2 | 18.36 | 48.17 | 173 |
| ky | 2,469 | 18% | 508.5 | 17.96 | 49.33 | 179 |

## Feature: 5,000 identical GETs, 50 in flight (cache stampede)

Not a speed contest: it shows request collapsing. Only got-api-engine (dedupe on by default) sends fewer requests upstream; "lean" disables dedupe.

| Client | req/s | relative | CPU µs/req | p50 ms | p99 ms | RSS MB | upstream calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **got-api-engine** | 34,157 | 100% | 42.7 | 1.02 | 6.86 | 128 | 100 |
| undici.request | 17,456 | 51% | 77.2 | 2.01 | 16.15 | 123 | 5,000 |
| fetch | 7,964 | 23% | 164 | 4.56 | 25.67 | 146 | 5,000 |
| ofetch | 6,560 | 19% | 210 | 5.09 | 23.66 | 145 | 5,000 |
| ky | 4,868 | 14% | 275.4 | 8.72 | 30.78 | 165 | 5,000 |
| axios | 4,305 | 13% | 296.1 | 9.81 | 31.25 | 149 | 5,000 |
| got | 3,136 | 9% | 390.6 | 14.06 | 42.32 | 157 | 5,000 |
| **got-api-engine (lean)** | 2,766 | 8% | 474 | 16.94 | 43.87 | 171 | 5,000 |
