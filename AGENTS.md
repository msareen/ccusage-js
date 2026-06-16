# AGENTS.md

This file points agents at the right repo-local skills and keeps only the guidance that should always be visible.

## Skill Routing

Use these skills before working in this repository:

- `development` - monorepo layout, CLI packaging, commands, code style, dependency policy, and post-change checks.
- `testing` - Vitest and Bun tests, CLI snapshots, Claude model names, LiteLLM pricing tests, and filesystem fixtures.
- `typescript` - TypeScript package/tooling work, Bun scripts, package launchers, schema tooling, and typed fixtures.
- `agent-sources` - agent adapter log locations, token mappings, cost rules, and CLI behavior.
- `docs` - cross-repository documentation impact checks for README files, docs guides, VitePress navigation, screenshots, schema docs, and user-facing commands/options.
- `skill-creator` - repo-local skill creation, SKILL.md frontmatter, description trigger quality, and reference layout.
- `ast-grep` - structural code searches in TypeScript and AST-based migration verification.
- `bun-api-reference` - local Bun runtime API docs and type references under `node_modules/bun-types`.
- `tdd` - Red-Green-Refactor workflow for logic changes.
- `create-pr` - single entry point for PR work, from branch creation through AI review requests, review-thread replies, and passing CI.
- `fix-ci` - diagnose and fix failing GitHub Actions checks with `gh`, then push small follow-up commits.

## Monorepo Packages

Check the nearest package-specific `AGENTS.md` before editing package code:

- `apps/ccusage/AGENTS.md` - main Claude Code usage CLI and library
- `docs/AGENTS.md` - VitePress documentation site

## Always-On Reminders

- The canonical user-facing CLI is `ccusage` with agent subcommands `ccusage claude`, `ccusage codex`, and `ccusage gemini`. Only these three agents are supported; top-level report commands default to Claude.
- This is a **Bun-only TypeScript** project. The Rust implementation and the per-platform native-binary packages have been removed; do not reintroduce Rust, Nix, pnpm, or `ccusage-<platform>` packages.
- All runtime behavior lives in `apps/ccusage/src` (TypeScript). Put new behavior there unless the work is specifically about npm packaging, the generated schema, docs tooling, or benchmark scripts.
- Use Bun as the package manager and runner (`bun install`, `bun run`, `bun test`). The build is `bun run build` (tsdown → `dist/main.js`).
- TypeScript rules apply to `.ts`, `.tsx`, `.js`, and `.jsx` files. Use `typescript`, especially `satisfies` and `as const satisfies` for typed literals.
- For package code, use `.ts` extensions for local imports, avoid dynamic imports, and use Vitest/Bun test globals without importing them. Indent with tabs.
- Run `just typecheck` or `just test` (or `bun test`) when a change touches behavior, types, or package code. `just` is the single entry point for repo tasks (`just --list`); recipes route to Bun.
- PR branches are squash-merged by default; prefer stacked, small, revertable follow-up commits over `git commit --amend` unless explicitly requested.
- Use US English for repository-facing GitHub communication, including issue comments, PR descriptions, review replies, triage notes, and bot-directed replies.
- Do what has been asked, nothing more. Do not proactively create documentation files unless explicitly requested.

## Cross-Cutting Flow

For changes that affect user-facing agents, commands, options, report modes,
configuration, JSON output, screenshots, or examples:

1. Implement the runtime/package/docs change in the owning location.
2. Use the `docs` skill to audit documentation impact.
3. Update the root `README.md`, `apps/ccusage/README.md`, relevant `docs/guide/`
   pages, related cross-links, and VitePress navigation when the user-facing
   surface changed.
4. Skip documentation edits for internal-only refactors, test-only changes, or
   skill maintenance unless they change user-facing behavior.
