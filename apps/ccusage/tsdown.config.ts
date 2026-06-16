import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: {
		main: './src/main.ts',
	},
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: true,
	minify: true,
	treeshake: {
		moduleSideEffects: false,
	},
	fixedExtension: false,
	dts: false,
	publint: true,
	deps: {
		onlyBundle: false,
	},
	inputOptions: {
		optimization: {
			inlineConst: {
				mode: 'all',
				pass: 2,
			},
		},
		preserveEntrySignatures: false,
	},
	outputOptions: {
		comments: {
			legal: false,
			annotation: true,
			jsdoc: false,
		},
	},
	nodeProtocol: true,
	define: {
		'import.meta.vitest': 'undefined',
	},
});
