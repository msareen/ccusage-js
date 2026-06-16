# AGENTS.md - ccusage Package

This is the published `ccusage` npm package — a **Bun-only TypeScript** CLI (ported
from the original Rust implementation, which has been removed). It analyzes coding-agent
token usage and cost from local data files.

## Skills

- Use `development` for commands, dependency policy, style, exports, and validation.
- Use `testing` for Vitest and Bun tests, fixtures, Claude models, and LiteLLM pricing.
- Use `agent-sources` for data directories, JSONL structure, session naming, cost modes, and report behavior.
- Use `typescript` before reading or editing TypeScript or JavaScript code.

## Package Notes

- Entry point / published bin launcher: `src/main.ts` (built to `dist/main.js` by tsdown).
- Supported agents: **claude, codex, gemini** only. Top-level report commands
  (`daily`/`monthly`/`weekly`/`session`/`blocks`/`statusline`) default to Claude.
- Source layout mirrors the former Rust modules: `core/` (types, date, pricing, cost,
  summary, output, options, config, table-output, project-names, agent-report),
  `cli/` (parser, help, errors), `commands/` (reports, blocks, statusline, codex),
  `terminal/` (table), `adapter/{claude,codex,gemini}/`.
- Embedded pricing: `src/data/*.json`; refresh LiteLLM via `bun run embed:pricing`.
- Benchmark/fixture scripts: `scripts/generate-large-fixture.ts`, `scripts/bench.mjs`.

Keep the public surface centered on `ccusage` and stable `--json` output. Tests run with
`bun test` (in-source) and Vitest; run with `TZ=UTC` for deterministic date bucketing.
