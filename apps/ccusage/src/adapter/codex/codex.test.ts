import { describe, expect, it } from 'bun:test';
import { codexConfigRequestsFastServiceTier } from './speed.ts';
import { codexRawUsageFromJson } from './types.ts';
import { calculateCodexModelCost, nonCachedInputTokens } from './report.ts';
import { PricingMap } from '../../core/pricing.ts';
import type { CodexModelUsage } from './types.ts';

describe('codexConfigRequestsFastServiceTier', () => {
	it('detects explicit fast/priority values', () => {
		expect(codexConfigRequestsFastServiceTier('service_tier = "fast"')).toBe(true);
		expect(codexConfigRequestsFastServiceTier("service_tier = 'priority' # higher")).toBe(true);
	});

	it('ignores unrelated or substring values', () => {
		expect(codexConfigRequestsFastServiceTier('service_tier_override = "fast"')).toBe(false);
		expect(codexConfigRequestsFastServiceTier('service_tier = "breakfast"')).toBe(false);
		expect(codexConfigRequestsFastServiceTier('service_tier = "standard"')).toBe(false);
	});
});

describe('codexRawUsageFromJson', () => {
	it('reads aliased fields and clamps cache to input', () => {
		const usage = codexRawUsageFromJson({
			prompt_tokens: 1500,
			cached_tokens: 300,
			completion_tokens: 200,
			total_tokens: 1700,
		});
		expect(usage).toEqual({
			inputTokens: 1500,
			cachedInputTokens: 300,
			outputTokens: 200,
			reasoningOutputTokens: 0,
			totalTokens: 1700,
		});
	});

	it('derives total from parts when absent', () => {
		const usage = codexRawUsageFromJson({ input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 });
		expect(usage?.totalTokens).toBe(125);
	});

	it('returns undefined for non-objects', () => {
		expect(codexRawUsageFromJson(5)).toBeUndefined();
		expect(codexRawUsageFromJson(null)).toBeUndefined();
	});
});

describe('calculateCodexModelCost', () => {
	const pricing = new PricingMap();
	pricing.loadJson({
		'gpt-test': {
			input_cost_per_token: 0.000001,
			output_cost_per_token: 0.000010,
		},
	});
	const usage: CodexModelUsage = {
		inputTokens: 100,
		cachedInputTokens: 40,
		outputTokens: 5,
		reasoningOutputTokens: 0,
		totalTokens: 105,
		isFallback: false,
	};

	it('charges cached input at the input rate when no cache_read rate is set', () => {
		// (60 + 40) * 0.000001 + 5 * 0.00001 = 0.00015
		const cost = calculateCodexModelCost('gpt-test', usage, pricing, 'standard');
		expect(Math.abs(cost - 0.00015)).toBeLessThan(1e-12);
	});

	it('doubles the cost at fast speed when no explicit multiplier exists', () => {
		const standard = calculateCodexModelCost('gpt-test', usage, pricing, 'standard');
		const fast = calculateCodexModelCost('gpt-test', usage, pricing, 'fast');
		expect(Math.abs(fast - standard * 2)).toBeLessThan(1e-12);
	});
});

describe('nonCachedInputTokens', () => {
	it('saturates at zero', () => {
		expect(nonCachedInputTokens(10, 40)).toBe(0);
		expect(nonCachedInputTokens(100, 40)).toBe(60);
	});
});
