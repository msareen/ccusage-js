/**
 * Core data structures ported from `rust/crates/ccusage/src/types.rs`.
 *
 * Token counts are represented as JS numbers. Real usage values stay well below
 * Number.MAX_SAFE_INTEGER (2^53), so integer arithmetic is exact.
 */

/** Cost calculation mode (`-m/--mode`). */
export type CostMode = 'auto' | 'calculate' | 'display';

/** Speed tier reported by some agents (`usage.speed`). */
export type Speed = 'standard' | 'fast';

/** Raw `cache_creation` breakdown by ephemeral cache duration. */
export type CacheCreationRaw = {
	ephemeral_5m_input_tokens: number;
	ephemeral_1h_input_tokens: number;
};

/** Raw token usage as found in a JSONL `message.usage` object. */
export type TokenUsageRaw = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	speed?: Speed;
	cache_creation?: CacheCreationRaw;
};

export function emptyUsage(): TokenUsageRaw {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
}

/**
 * Total cache-creation tokens. Mirrors `TokenUsageRaw::cache_creation_token_count`:
 * prefer the duration breakdown when present, else the flat field.
 */
export function cacheCreationTokenCount(usage: TokenUsageRaw): number {
	if (usage.cache_creation != null) {
		return (
			usage.cache_creation.ephemeral_5m_input_tokens
			+ usage.cache_creation.ephemeral_1h_input_tokens
		);
	}
	return usage.cache_creation_input_tokens;
}

/** Parsed top-level usage entry (`UsageEntry`). */
export type UsageEntry = {
	sessionId?: string;
	timestamp: string;
	version?: string;
	message: UsageMessage;
	costUSD?: number;
	requestId?: string;
	isApiErrorMessage?: boolean;
	isSidechain?: boolean;
};

export type UsageMessage = {
	usage: TokenUsageRaw;
	model?: string;
	id?: string;
};

/** Accumulated token counts (`TokenCounts`). */
export type TokenCounts = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	extraTotalTokens: number;
};

export function newTokenCounts(): TokenCounts {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		extraTotalTokens: 0,
	};
}

export function addUsage(counts: TokenCounts, usage: TokenUsageRaw): void {
	counts.inputTokens += usage.input_tokens;
	counts.outputTokens += usage.output_tokens;
	counts.cacheCreationTokens += cacheCreationTokenCount(usage);
	counts.cacheReadTokens += usage.cache_read_input_tokens;
}

export function tokenCountsTotal(counts: TokenCounts): number {
	return (
		counts.inputTokens
		+ counts.outputTokens
		+ counts.cacheCreationTokens
		+ counts.cacheReadTokens
		+ counts.extraTotalTokens
	);
}

/** Per-model breakdown (`ModelBreakdown`). `extraTotalTokens`/`missingPricing` are internal only. */
export type ModelBreakdown = {
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	extraTotalTokens: number;
	cost: number;
	missingPricing: boolean;
};

export function newModelBreakdown(modelName: string): ModelBreakdown {
	return {
		modelName,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		extraTotalTokens: 0,
		cost: 0,
		missingPricing: false,
	};
}

/** A loaded, costed usage entry (`LoadedEntry`). */
export type LoadedEntry = {
	data: UsageEntry;
	timestamp: number; // epoch millis
	date: string;
	project: string;
	sessionId: string;
	projectPath: string;
	cost: number;
	extraTotalTokens: number;
	credits?: number;
	messageCount?: number;
	model?: string;
	usageLimitResetTime?: number;
	missingPricingModel?: string;
};

/** Aggregated usage summary row (`UsageSummary`). */
export type UsageSummary = {
	date?: string;
	month?: string;
	week?: string;
	sessionId?: string;
	projectPath?: string;
	lastActivity?: string;
	firstActivity?: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	extraTotalTokens: number;
	totalCost: number;
	credits?: number;
	messageCount?: number;
	modelsUsed: string[];
	modelBreakdowns: ModelBreakdown[];
	project?: string;
	versions?: string[];
};

export function newUsageSummary(): UsageSummary {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		extraTotalTokens: 0,
		totalCost: 0,
		modelsUsed: [],
		modelBreakdowns: [],
	};
}

export function summaryTotalTokens(summary: UsageSummary): number {
	return (
		summary.inputTokens
		+ summary.outputTokens
		+ summary.cacheCreationTokens
		+ summary.cacheReadTokens
		+ summary.extraTotalTokens
	);
}
