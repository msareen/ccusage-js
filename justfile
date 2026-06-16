# Task runner — the single entry point for development and release.
#
# Bun-only: this project was ported from Rust to TypeScript and runs entirely on
# Bun. Each workspace package has its own justfile, imported below as a module;
# root recipes aggregate them.
#
# Run `just --list` (or `just <module>::--list`) to see everything.

mod ccusage 'apps/ccusage'
mod docs

[private]
default:
    @just --list

# Build every workspace package
build: ccusage::build docs::build

# Install workspace dependencies exactly as CI expects them
install:
    bun install --frozen-lockfile

# Install dependencies, then type-check every workspace package
typecheck: install ccusage::typecheck docs::typecheck

# Run the test suite
test: test-vitest

# Run Vitest once at the repo root (its config aggregates every package project)
test-vitest:
    TZ=UTC bun run vitest run

# Run the in-source Bun test suite for the ccusage package
test-bun:
    cd apps/ccusage && TZ=UTC bun test

# Generate a large benchmark fixture for performance checks
generate-large-fixture output_dir codex_output_dir size_mib="1024":
    bun apps/ccusage/scripts/generate-large-fixture.ts --output-dir "{{output_dir}}" --codex-output-dir "{{codex_output_dir}}" --size-mib {{size_mib}}

# Update the locked LiteLLM pricing snapshot
update-litellm-pricing:
    cd apps/ccusage && bun run embed:pricing

# Bump every package version, then commit, tag, push
release: ccusage::typecheck ccusage::build
    bun run bumpp -r
    git checkout -- $(git ls-files '*package.json')
