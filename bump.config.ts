import { defineConfig } from 'bumpp';

// Bun-only TypeScript project: bumpp updates the workspace package.json files.
// (The former Rust `cargo set-version` step was removed with the Rust crates.)
export default defineConfig({});
