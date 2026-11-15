# Benchmarks

```bash
cd bench
npm install
node run.mjs                    # 3 rounds, all clients → console
node run.mjs --rounds 5 --out RESULTS.md
node run.mjs --only got,got-api-engine
```

## Method

- **Isolation:** every (client, scenario, round) runs in a fresh process; the
  upstream runs in its own process. The median of the rounds is reported.
- **Warm-up:** 2,000 requests before measuring (JIT and connection pools reach
  steady state). `process.cpuUsage()` includes JIT compiler threads, so a short
  warm-up penalises libraries with more code.
- **Fairness:** every client uses keep-alive and parses JSON; every request has
  a unique URL, so no client can collapse requests — except in the explicitly
  labelled `identical-burst` scenario, which exists to show request collapsing.
- **Columns:** *CPU µs/req* (client process only) is the most stable number on
  shared machines; req/s and latency also depend on the upstream and the OS
  scheduler.
- `got-api-engine` runs with its defaults (dedupe, metrics, 30 s deadline,
  redaction, strict paths); `got-api-engine (lean)` switches the optional parts off.

Numbers depend on the machine. Compare columns within one run, not across machines.
