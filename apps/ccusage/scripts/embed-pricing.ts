#!/usr/bin/env bun
/**
 * Build-time pricing embed.
 *
 * Fetches the LiteLLM pricing table from the BerriAI/litellm `main` branch,
 * compacts it to the embedded model set, and writes the snapshot into
 * `src/data/litellm-pricing.json`.
 *
 * Usage: bun scripts/embed-pricing.ts
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DATA_DIR = path.join(HERE, '..', 'src', 'data');
const LITELLM_FILE = 'model_prices_and_context_window.json';

const EMBED_FIELDS = [
	'input_cost_per_token',
	'output_cost_per_token',
	'cache_creation_input_token_cost',
	'cache_read_input_token_cost',
	'input_cost_per_token_above_200k_tokens',
	'output_cost_per_token_above_200k_tokens',
	'cache_creation_input_token_cost_above_200k_tokens',
	'cache_read_input_token_cost_above_200k_tokens',
	'max_input_tokens',
	'provider_specific_entry',
] as const;

/** Mirrors `is_embedded_model` in build.rs. */
function isEmbeddedModel(model: string): boolean {
	return (
		model.startsWith('claude-')
		|| model.startsWith('anthropic.')
		|| model.startsWith('anthropic/')
		|| model.startsWith('us.anthropic.')
		|| model.startsWith('eu.anthropic.')
		|| model.startsWith('global.anthropic.')
		|| model.startsWith('jp.anthropic.')
		|| model.startsWith('au.anthropic.')
		|| model.startsWith('gpt-')
		|| model.startsWith('openai/')
		|| model.startsWith('azure/')
		|| model.startsWith('zai/')
		|| model.startsWith('openrouter/openai/')
	);
}

function compactPricing(raw: Record<string, unknown>): Record<string, unknown> {
	const compact: Record<string, unknown> = {};
	for (const [model, pricing] of Object.entries(raw)) {
		if (!isEmbeddedModel(model) || pricing == null || typeof pricing !== 'object') {
			continue;
		}
		const fields: Record<string, unknown> = {};
		for (const field of EMBED_FIELDS) {
			const value = (pricing as Record<string, unknown>)[field];
			if (value != null) {
				fields[field] = value;
			}
		}
		if ('input_cost_per_token' in fields && 'output_cost_per_token' in fields) {
			compact[model] = fields;
		}
	}
	return compact;
}

function litellmUrl(): string {
	return `https://raw.githubusercontent.com/BerriAI/litellm/main/${LITELLM_FILE}`;
}

async function main(): Promise<void> {
	const url = litellmUrl();
	process.stderr.write(`Fetching LiteLLM pricing from ${url}\n`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch LiteLLM pricing: HTTP ${response.status}`);
	}
	const raw = (await response.json()) as Record<string, unknown>;
	const compact = compactPricing(raw);
	await writeFile(
		path.join(DATA_DIR, 'litellm-pricing.json'),
		`${JSON.stringify(compact)}\n`,
	);
	process.stderr.write(`Embedded ${Object.keys(compact).length} LiteLLM models\n`);
}

await main();
