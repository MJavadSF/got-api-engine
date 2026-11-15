# Contributing

```bash
npm ci
npm run check     # lint (Biome) + typecheck + tests with coverage + build + package lint
```

- **Lint / format:** [Biome](https://biomejs.dev) (`npm run lint:fix`).
- **Tests:** Vitest. Every bug fix gets a regression test (`test/fixes.test.ts`), every feature
  a behaviour test. TLS / HTTP/2 tests generate a throw-away certificate with `openssl`.
- **Architecture:** see "Architecture" in the README. Keep stages small and pure where possible;
  the engine class only wires them together.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:` …).
