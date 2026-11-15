# Benchmarks

got-api-engine is built on got and adds a lot on top of it — retries, deadlines,
dedupe, metrics, redaction, credential scoping. The goal is that this costs
little, so the benchmark compares it with plain got and with the other common
clients. Method and scripts: [`bench/`](https://github.com/MJavadSF/got-api-engine/tree/main/bench).

## Summary

- **Serial latency:** with its defaults the engine is on par with plain got;
  the lean configuration is faster.
- **Under concurrency:** the defaults cost 10–30 % of got's throughput (metrics,
  dedupe bookkeeping, deadlines); the lean configuration stays within 5–10 %.
- **Large JSON:** parsing dominates — all got-based clients are equivalent.
- **Identical concurrent requests:** dedupe answers 5,000 requests with **100**
  upstream calls instead of 5,000.
- `undici.request` is the raw-speed baseline (no JSON helpers, no retries): it
  shows what the transport layer itself costs.

<!--@include: ../../bench/RESULTS.md{3,}-->
