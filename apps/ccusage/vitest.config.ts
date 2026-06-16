import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		// In-source tests live in these files; the dedicated `*.test.ts` files use
		// the `bun:test` runner and are executed via `bun test`, not Vitest.
		includeSource: [
			'scripts/generate-large-fixture.ts',
		],
		exclude: [...configDefaults.exclude, 'src/**/*.test.ts'],
		globals: true,
	},
});
