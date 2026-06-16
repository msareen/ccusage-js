/**
 * Model pricing ported from `rust/crates/ccusage/src/pricing.rs`.
 *
 * Differences from the Rust version: network sources (LiteLLM refresh and the
 * models.dev fallback) are fetched up front in `loadWithOverrides` so that
 * `find` stays synchronous. The embedded LiteLLM snapshot is produced by
 * `scripts/embed-pricing.ts` (replacing the Rust `build.rs`).
 */
import fastMultiplierOverridesJson from '../data/fast-multiplier-overrides.json' with { type: 'json' };
import modelsDevJson from '../data/models-dev-pricing.json' with { type: 'json' };
import litellmSnapshot from '../data/litellm-pricing.json' with { type: 'json' };

const LITELLM_PRICING_URL
	= 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const PRICING_FETCH_TIMEOUT_MS = 10_000;
/** Anthropic date-suffixed aliases use YYYYMMDD; other numeric suffixes are distinct versions. */
const MODEL_DATE_SUFFIX_DIGITS = 8;

export type Pricing = {
	input: number;
	output: number;
	cacheCreate: number;
	cacheRead: number;
	cacheReadExplicit: boolean;
	inputAbove200k?: number;
	outputAbove200k?: number;
	cacheCreateAbove200k?: number;
	cacheReadAbove200k?: number;
	fastMultiplier: number;
};

export function emptyPricing(): Pricing {
	return {
		input: 0,
		output: 0,
		cacheCreate: 0,
		cacheRead: 0,
		cacheReadExplicit: false,
		fastMultiplier: 1.0,
	};
}

/** Runtime pricing override (`--pricing-override` / config). */
export type PricingOverride = {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_creation_input_token_cost?: number;
	cache_read_input_token_cost?: number;
	input_cost_per_token_above_200k_tokens?: number;
	output_cost_per_token_above_200k_tokens?: number;
	cache_creation_input_token_cost_above_200k_tokens?: number;
	cache_read_input_token_cost_above_200k_tokens?: number;
	max_input_tokens?: number;
	fast_multiplier?: number;
};

type LiteLlmPricing = {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_creation_input_token_cost?: number;
	cache_read_input_token_cost?: number;
	input_cost_per_token_above_200k_tokens?: number;
	output_cost_per_token_above_200k_tokens?: number;
	cache_creation_input_token_cost_above_200k_tokens?: number;
	cache_read_input_token_cost_above_200k_tokens?: number;
	max_input_tokens?: number;
	provider_specific_entry?: { fast?: number };
};

type FastMultiplierOverrides = {
	exact: Record<string, number>;
	normalized_prefix: Record<string, number>;
};

const fastOverrides = fastMultiplierOverridesJson as FastMultiplierOverrides;

function fastMultiplierFor(model: string): number | undefined {
	const exact = fastOverrides.exact[model];
	if (exact != null) {
		return exact;
	}
	const normalized = model.replace(/[.@]/g, '-');
	for (const part of normalized.split(/[/:]/)) {
		for (const [base, multiplier] of Object.entries(fastOverrides.normalized_prefix)) {
			if (matchesModelSuffix(part, base)) {
				return multiplier;
			}
		}
	}
	return undefined;
}

function matchesModelSuffix(part: string, base: string): boolean {
	const index = part.lastIndexOf(base);
	if (index < 0) {
		return false;
	}
	const suffix = part.slice(index);
	return suffix === base || suffix[base.length] === '-';
}

export class PricingMap {
	entries = new Map<string, Pricing>();
	contextLimits = new Map<string, number>();
	private enableEmbeddedModelsDevFallback = false;
	/** Network models.dev fallback, prefetched in loadWithOverrides. */
	private networkModelsDev?: PricingMap;

	/** Mirrors `PricingMap::load_embedded`. */
	static loadEmbedded(): PricingMap {
		const map = new PricingMap();
		map.loadJson(litellmSnapshot as Record<string, unknown>);
		map.putBuiltinPricing();
		map.enableEmbeddedModelsDevFallback = true;
		return map;
	}

	/** Mirrors `PricingMap::load_with_overrides`. Async to allow network fetches up front. */
	static async loadWithOverrides(
		offline: boolean,
		overrides: Iterable<[string, PricingOverride]>,
	): Promise<PricingMap> {
		const map = PricingMap.loadEmbedded();
		if (!offline) {
			const json = await fetchJson(LITELLM_PRICING_URL);
			if (json != null) {
				map.loadJson(json);
			}
			const modelsDev = await fetchJson(MODELS_DEV_API_URL);
			if (modelsDev != null) {
				const fallback = new PricingMap();
				fallback.loadModelsDevMissing(modelsDev);
				map.networkModelsDev = fallback;
			}
		}
		map.applyOverrides(overrides);
		return map;
	}

	loadJson(raw: Record<string, unknown>): number {
		let loaded = 0;
		for (const [model, value] of Object.entries(raw)) {
			if (value == null || typeof value !== 'object') {
				continue;
			}
			const pricing = value as LiteLlmPricing;
			const input = pricing.input_cost_per_token;
			const output = pricing.output_cost_per_token;
			if (input == null || output == null) {
				continue;
			}
			const cacheReadExplicit = pricing.cache_read_input_token_cost != null;
			const fastMultiplier
				= pricing.provider_specific_entry?.fast
				?? fastMultiplierFor(model)
				?? 1.0;
			this.entries.set(model, {
				input,
				output,
				cacheCreate: pricing.cache_creation_input_token_cost ?? input * 1.25,
				cacheRead: pricing.cache_read_input_token_cost ?? input * 0.1,
				cacheReadExplicit,
				inputAbove200k: pricing.input_cost_per_token_above_200k_tokens,
				outputAbove200k: pricing.output_cost_per_token_above_200k_tokens,
				cacheCreateAbove200k: pricing.cache_creation_input_token_cost_above_200k_tokens,
				cacheReadAbove200k: pricing.cache_read_input_token_cost_above_200k_tokens,
				fastMultiplier,
			});
			if (pricing.max_input_tokens != null) {
				this.contextLimits.set(model, pricing.max_input_tokens);
			}
			loaded += 1;
		}
		return loaded;
	}

	/** Mirrors `load_models_dev_json_missing`. */
	loadModelsDevMissing(raw: Record<string, unknown>): number {
		let loaded = 0;
		for (const provider of Object.values(raw)) {
			const models = (provider as { models?: Record<string, unknown> })?.models;
			if (models == null) {
				continue;
			}
			for (const [modelKey, modelValue] of Object.entries(models)) {
				const model = modelValue as {
					id?: string;
					cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
					limit?: { context?: number };
				};
				const modelId = model.id ?? modelKey;
				if (this.entries.has(modelId)) {
					continue;
				}
				const cost = model.cost;
				if (cost?.input == null || cost.output == null) {
					continue;
				}
				const input = cost.input / 1_000_000;
				const output = cost.output / 1_000_000;
				const cacheReadExplicit = cost.cache_read != null;
				this.entries.set(modelId, {
					input,
					output,
					cacheCreate: cost.cache_write != null ? cost.cache_write / 1_000_000 : input * 1.25,
					cacheRead: cost.cache_read != null ? cost.cache_read / 1_000_000 : input * 0.1,
					cacheReadExplicit,
					fastMultiplier: 1.0,
				});
				if (model.limit?.context != null) {
					this.contextLimits.set(modelId, model.limit.context);
				}
				loaded += 1;
			}
		}
		return loaded;
	}

	find(model: string): Pricing | undefined {
		return (
			this.findEntry(model)
			?? this.networkModelsDev?.findEntry(model)
			?? (this.enableEmbeddedModelsDevFallback
				? embeddedModelsDevPricing().findEntry(model)
				: undefined)
		);
	}

	private findEntry(model: string): Pricing | undefined {
		const direct = this.entries.get(model);
		if (direct != null) {
			return direct;
		}
		const normalizedModel = normalizedPricingKey(model);
		let best: { key: string; pricing: Pricing } | undefined;
		for (const [candidate, pricing] of this.entries) {
			if (!pricingKeyMatches(candidate, model, normalizedModel)) {
				continue;
			}
			if (best == null || compareCandidates(candidate, best.key) > 0) {
				best = { key: candidate, pricing };
			}
		}
		return best?.pricing;
	}

	contextLimit(model: string): number | undefined {
		return (
			this.contextLimitEntry(model)
			?? this.networkModelsDev?.contextLimitEntry(model)
			?? (this.enableEmbeddedModelsDevFallback
				? embeddedModelsDevPricing().contextLimitEntry(model)
				: undefined)
		);
	}

	private contextLimitEntry(model: string): number | undefined {
		const direct = this.contextLimits.get(model);
		if (direct != null) {
			return direct;
		}
		const normalizedModel = normalizedPricingKey(model);
		let best: { key: string; limit: number } | undefined;
		for (const [candidate, limit] of this.contextLimits) {
			if (!pricingKeyMatches(candidate, model, normalizedModel)) {
				continue;
			}
			if (best == null || compareCandidates(candidate, best.key) > 0) {
				best = { key: candidate, limit };
			}
		}
		return best?.limit;
	}

	applyOverrides(overrides: Iterable<[string, PricingOverride]>): void {
		for (const [model, override] of overrides) {
			this.applyOverride(model, override);
		}
	}

	private applyOverride(model: string, override: PricingOverride): void {
		const base = this.entries.get(model) ?? emptyPricing();
		const newInput = override.input_cost_per_token ?? base.input;
		const shouldScale
			= override.input_cost_per_token != null && base.input > 0 && !base.cacheReadExplicit;
		const scale = shouldScale ? newInput / base.input : 1.0;

		const cacheCreate = override.cache_creation_input_token_cost != null
			? override.cache_creation_input_token_cost
			: shouldScale && base.cacheCreate > 0
				? base.cacheCreate * scale
				: base.cacheCreate;

		const cacheRead = override.cache_read_input_token_cost != null
			? override.cache_read_input_token_cost
			: shouldScale && base.cacheRead > 0
				? base.cacheRead * scale
				: base.cacheRead;

		const cacheCreateAbove200k = override.cache_creation_input_token_cost_above_200k_tokens != null
			? override.cache_creation_input_token_cost_above_200k_tokens
			: shouldScale && base.cacheCreateAbove200k != null
				? base.cacheCreateAbove200k * scale
				: base.cacheCreateAbove200k;

		const cacheReadAbove200k = override.cache_read_input_token_cost_above_200k_tokens != null
			? override.cache_read_input_token_cost_above_200k_tokens
			: shouldScale && base.cacheReadAbove200k != null
				? base.cacheReadAbove200k * scale
				: base.cacheReadAbove200k;

		this.entries.set(model, {
			input: newInput,
			output: override.output_cost_per_token ?? base.output,
			cacheCreate,
			cacheRead,
			cacheReadExplicit: override.cache_read_input_token_cost != null || base.cacheReadExplicit,
			inputAbove200k: override.input_cost_per_token_above_200k_tokens ?? base.inputAbove200k,
			outputAbove200k: override.output_cost_per_token_above_200k_tokens ?? base.outputAbove200k,
			cacheCreateAbove200k,
			cacheReadAbove200k,
			fastMultiplier: override.fast_multiplier ?? base.fastMultiplier,
		});
		if (override.max_input_tokens != null) {
			this.contextLimits.set(model, override.max_input_tokens);
		}
	}

	/** Hardcoded fallback pricing. Mirrors `put_builtin_pricing`. */
	private putBuiltinPricing(): void {
		const claudeOpus45: Pricing = {
			input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 0.5e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		};
		this.entries.set('claude-opus-4-5', { ...claudeOpus45 });
		for (const m of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
			this.entries.set(m, { ...claudeOpus45, fastMultiplier: fastMultiplierFor(m) ?? 1.0 });
		}
		this.entries.set('claude-haiku-4-5', {
			input: 1e-6, output: 5e-6, cacheCreate: 1.25e-6, cacheRead: 0.1e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('claude-opus-4', {
			input: 15e-6, output: 75e-6, cacheCreate: 18.75e-6, cacheRead: 1.5e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('claude-sonnet-4-6', {
			input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('claude-sonnet-4', {
			input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6,
			cacheReadExplicit: true,
			inputAbove200k: 6e-6, outputAbove200k: 22.5e-6,
			cacheCreateAbove200k: 7.5e-6, cacheReadAbove200k: 0.6e-6,
			fastMultiplier: 1.0,
		});
		const claude35Haiku: Pricing = {
			input: 0.8e-6, output: 4e-6, cacheCreate: 1.0e-6, cacheRead: 0.08e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		};
		this.entries.set('claude-3-5-haiku', { ...claude35Haiku });
		this.entries.set('claude-3-5-haiku-20241022', { ...claude35Haiku });
		this.entries.set('claude-3-opus', {
			input: 15e-6, output: 75e-6, cacheCreate: 18.75e-6, cacheRead: 1.5e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('claude-3-sonnet', {
			input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('claude-3-haiku', {
			input: 0.25e-6, output: 1.25e-6, cacheCreate: 0.3e-6, cacheRead: 0.03e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('gpt-5', {
			input: 1.25e-6, output: 10e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('gpt-5.5', {
			input: 5e-6, output: 30e-6, cacheCreate: 5e-6, cacheRead: 0.5e-6,
			cacheReadExplicit: true, fastMultiplier: fastMultiplierFor('gpt-5.5') ?? 1.0,
		});
		this.entries.set('grok-4.3', {
			input: 1.25e-6, output: 2.5e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6,
			cacheReadExplicit: false, fastMultiplier: 1.0,
		});
		this.entries.set('moonshot/kimi-k2.5', {
			input: 0.6e-6, output: 3e-6, cacheCreate: 0.75e-6, cacheRead: 0.1e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('moonshot/kimi-k2.6', {
			input: 0.95e-6, output: 4e-6, cacheCreate: 1.1875e-6, cacheRead: 0.16e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		const gpt51: Pricing = {
			input: 1.25e-6, output: 10e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		};
		this.entries.set('gpt-5.1', { ...gpt51 });
		this.entries.set('gpt-5.1-codex', { ...gpt51 });
		const gpt5Codex: Pricing = {
			input: 1.75e-6, output: 14e-6, cacheCreate: 1.75e-6, cacheRead: 0.175e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		};
		this.entries.set('gpt-5.2-codex', { ...gpt5Codex });
		this.entries.set('gpt-5.3-codex', { ...gpt5Codex, fastMultiplier: fastMultiplierFor('gpt-5.3-codex') ?? 1.0 });
		this.entries.set('gpt-5.2', { ...gpt5Codex });
		this.entries.set('gpt-5.4', {
			input: 2.5e-6, output: 15e-6, cacheCreate: 2.5e-6, cacheRead: 0.25e-6,
			cacheReadExplicit: true, fastMultiplier: fastMultiplierFor('gpt-5.4') ?? 1.0,
		});
		this.entries.set('gpt-5.4-mini', {
			input: 0.75e-6, output: 4.5e-6, cacheCreate: 0.75e-6, cacheRead: 0.075e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		this.entries.set('gpt-5.4-nano', {
			input: 0.2e-6, output: 1.25e-6, cacheCreate: 0.2e-6, cacheRead: 0.02e-6,
			cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		const glm = (input: number, output: number, cacheRead: number): Pricing => ({
			input, output, cacheCreate: 0, cacheRead, cacheReadExplicit: true, fastMultiplier: 1.0,
		});
		const glmBase = glm(0.6e-6, 2.2e-6, 0.11e-6);
		this.entries.set('glm-4.5', { ...glmBase });
		this.entries.set('zai/glm-4.5', { ...glmBase });
		this.entries.set('zai/glm-4.5-x', glm(2.2e-6, 8.9e-6, 0.45e-6));
		this.entries.set('zai/glm-4.5-air', glm(0.2e-6, 1.1e-6, 0.03e-6));
		this.entries.set('zai/glm-4.5-airx', glm(1.1e-6, 4.5e-6, 0.22e-6));
		this.entries.set('zai/glm-4.5v', glm(0.6e-6, 1.8e-6, 0.11e-6));
		this.entries.set('zai/glm-4-32b-0414-128k', glm(0.1e-6, 0.1e-6, 0));
		this.entries.set('zai/glm-4.5-flash', glm(0, 0, 0));
		this.entries.set('glm-4.6', { ...glmBase });
		this.entries.set('glm-4.7', { ...glmBase });
		this.entries.set('glm-5', { ...glmBase, input: 1.0e-6, output: 3.2e-6, cacheRead: 0.2e-6 });
		this.entries.set('glm-5-turbo', { ...glmBase, input: 1.2e-6, output: 4.0e-6, cacheRead: 0.24e-6 });
		this.entries.set('glm-5.1', { ...glmBase, input: 1.4e-6, output: 4.4e-6, cacheRead: 0.26e-6 });

		this.contextLimits.set('gpt-5.5', 1_050_000);
		this.contextLimits.set('grok-4.3', 1_000_000);
		this.contextLimits.set('gpt-5.4', 1_050_000);
		for (const m of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
			this.contextLimits.set(m, 1_000_000);
		}
		this.contextLimits.set('moonshot/kimi-k2.5', 262_144);
		this.contextLimits.set('moonshot/kimi-k2.6', 262_144);
		for (const m of [
			'claude-opus-4-5', 'claude-haiku-4-5', 'claude-opus-4', 'claude-sonnet-4',
			'claude-3-5-haiku', 'claude-3-5-haiku-20241022', 'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku',
		]) {
			this.contextLimits.set(m, 200_000);
		}
	}
}

/** `left.len().cmp(&right.len()).then_with(|| right.cmp(left))` => prefer longer, then lexically smaller. */
function compareCandidates(left: string, right: string): number {
	if (left.length !== right.length) {
		return left.length - right.length;
	}
	// then_with(|| right.cmp(left)): larger when `right` > `left`, i.e. when left is smaller.
	if (right > left) {
		return 1;
	}
	if (right < left) {
		return -1;
	}
	return 0;
}

function pricingKeyMatches(candidate: string, model: string, normalizedModel: string): boolean {
	if (containsPricingKey(model, candidate) || containsPricingKey(candidate, model)) {
		return true;
	}
	const normalizedCandidate = normalizedPricingKey(candidate);
	return (
		containsPricingKey(normalizedModel, normalizedCandidate)
		|| containsPricingKey(normalizedCandidate, normalizedModel)
	);
}

function isPricingKeyBoundary(ch: string | undefined): boolean {
	if (ch == null) {
		return true;
	}
	return !/[a-z0-9]/i.test(ch);
}

function containsPricingKey(value: string, key: string): boolean {
	if (key.length === 0) {
		return false;
	}
	let from = 0;
	for (;;) {
		const index = value.indexOf(key, from);
		if (index < 0) {
			return false;
		}
		const before = index > 0 ? value[index - 1] : undefined;
		const suffix = value.slice(index + key.length);
		if (
			(before === undefined || isPricingKeyBoundary(before))
			&& suffixAllowsPricingKeyMatch(key, suffix)
		) {
			return true;
		}
		from = index + 1;
	}
}

function suffixAllowsPricingKeyMatch(key: string, suffix: string): boolean {
	const separator = suffix[0];
	if (separator === undefined) {
		return true;
	}
	if (!isPricingKeyBoundary(separator)) {
		return false;
	}
	return !suffixStartsWithNumericModelVersion(key, suffix);
}

function suffixStartsWithNumericModelVersion(key: string, suffix: string): boolean {
	const lastKey = key[key.length - 1];
	if (lastKey === undefined || !/[0-9]/.test(lastKey)) {
		return false;
	}
	if (suffix[0] !== '-' && suffix[0] !== '.') {
		return false;
	}
	const rest = suffix.slice(1);
	let digitLen = 0;
	while (digitLen < rest.length && /[0-9]/.test(rest[digitLen]!)) {
		digitLen += 1;
	}
	if (digitLen === 0) {
		return false;
	}
	const afterDigits = rest[digitLen];
	return !(digitLen === MODEL_DATE_SUFFIX_DIGITS && isPricingKeyBoundary(afterDigits));
}

function normalizedPricingKey(value: string): string {
	if (value.includes('.') || value.includes('@')) {
		return value.replace(/[.@]/g, '-');
	}
	return value;
}

let embeddedModelsDev: PricingMap | undefined;

function embeddedModelsDevPricing(): PricingMap {
	if (embeddedModelsDev == null) {
		const map = new PricingMap();
		map.loadModelsDevMissing(modelsDevJson as Record<string, unknown>);
		embeddedModelsDev = map;
	}
	return embeddedModelsDev;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), PRICING_FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) {
				return undefined;
			}
			return (await response.json()) as Record<string, unknown>;
		}
		finally {
			clearTimeout(timeout);
		}
	}
	catch {
		return undefined;
	}
}
