/** Cost calculation ported from `rust/crates/ccusage/src/cost.rs`. */
import type { CostMode, TokenUsageRaw } from './types.ts';
import type { Pricing, PricingMap } from './pricing.ts';
import { cacheCreationTokenCount } from './types.ts';

const CACHE_CREATE_1H_INPUT_MULTIPLIER = 2.0;
const TIER_THRESHOLD = 200_000;

export function totalUsageTokens(usage: TokenUsageRaw): number {
	return (
		usage.input_tokens
		+ usage.output_tokens
		+ cacheCreationTokenCount(usage)
		+ usage.cache_read_input_tokens
	);
}

export function calculateCostForUsage(
	model: string | undefined,
	usage: TokenUsageRaw,
	costUsd: number | undefined,
	mode: CostMode,
	pricing: PricingMap | undefined,
): number {
	switch (mode) {
		case 'display':
			return costUsd ?? 0;
		case 'auto':
			return costUsd ?? calculateCostFromTokens(model, usage, pricing);
		case 'calculate':
			return calculateCostFromTokens(model, usage, pricing);
	}
}

export function missingPricingModelForUsage(
	model: string | undefined,
	usage: TokenUsageRaw,
	costUsd: number | undefined,
	mode: CostMode,
	pricing: PricingMap | undefined,
): string | undefined {
	if (mode === 'display' || (mode === 'auto' && costUsd != null)) {
		return undefined;
	}
	return missingPricingModelForTokenTotal(model, totalUsageTokens(usage), pricing);
}

export function missingPricingModelForTokenTotal(
	model: string | undefined,
	totalTokens: number,
	pricing: PricingMap | undefined,
): string | undefined {
	if (totalTokens === 0 || model == null || pricing == null) {
		return undefined;
	}
	return pricing.find(model) == null ? model : undefined;
}

function calculateCostFromTokens(
	model: string | undefined,
	usage: TokenUsageRaw,
	pricingMap: PricingMap | undefined,
): number {
	if (model == null) {
		return 0;
	}
	const pricing: Pricing | undefined = pricingMap?.find(model);
	if (pricing == null) {
		return 0;
	}
	const multiplier = usage.speed === 'fast' ? pricing.fastMultiplier : 1.0;
	const [cacheCreate5m, cacheCreate1h] = usage.cache_creation != null
		? [usage.cache_creation.ephemeral_5m_input_tokens, usage.cache_creation.ephemeral_1h_input_tokens]
		: [usage.cache_creation_input_tokens, 0];
	const cacheCreate1hCost = pricing.input * CACHE_CREATE_1H_INPUT_MULTIPLIER;
	const cacheCreate1hCostAbove200k = pricing.inputAbove200k != null
		? pricing.inputAbove200k * CACHE_CREATE_1H_INPUT_MULTIPLIER
		: undefined;
	return (
		(tieredCost(usage.input_tokens, pricing.input, pricing.inputAbove200k)
			+ tieredCost(usage.output_tokens, pricing.output, pricing.outputAbove200k)
			+ tieredCost(cacheCreate5m, pricing.cacheCreate, pricing.cacheCreateAbove200k)
			+ tieredCost(cacheCreate1h, cacheCreate1hCost, cacheCreate1hCostAbove200k)
			+ tieredCost(usage.cache_read_input_tokens, pricing.cacheRead, pricing.cacheReadAbove200k))
		* multiplier
	);
}

export function tieredCost(tokens: number, base: number, above: number | undefined): number {
	if (tokens === 0) {
		return 0;
	}
	if (above != null && tokens > TIER_THRESHOLD) {
		return TIER_THRESHOLD * base + (tokens - TIER_THRESHOLD) * above;
	}
	return tokens * base;
}
