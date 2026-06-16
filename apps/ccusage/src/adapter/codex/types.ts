/** Codex shared data structures, ported from the Rust `types.rs` Codex section. */

export type CodexRawUsage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

export type CodexTokenUsageEvent = {
	sessionId: string;
	timestamp: string;
	model?: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	isFallbackModel: boolean;
};

export type CodexModelUsage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	isFallback: boolean;
};

export type CodexGroup = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	models: Map<string, CodexModelUsage>;
	lastActivity?: string;
};

export function newCodexModelUsage(): CodexModelUsage {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		isFallback: false,
	};
}

export function newCodexGroup(): CodexGroup {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		models: new Map(),
		lastActivity: undefined,
	};
}

/**
 * Reconstruct a `CodexRawUsage` from an arbitrary JSON usage object, mirroring
 * the lossy serde `Deserialize` impl in `codex/types.rs`: read the first present
 * alias for each field, treat numeric strings as numbers, ignore non-numeric
 * values, and derive `total_tokens` from the parts when absent or zero.
 */
export function codexRawUsageFromJson(value: unknown): CodexRawUsage | undefined {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	const u64 = (key: string): number | undefined => optionalU64Lossy(obj[key]);

	const input = u64('input_tokens') ?? u64('prompt_tokens') ?? u64('input') ?? 0;
	const output = u64('output_tokens') ?? u64('completion_tokens') ?? u64('output') ?? 0;
	const reasoning = u64('reasoning_output_tokens') ?? u64('reasoning_tokens') ?? 0;
	const cached
		= u64('cached_input_tokens') ?? u64('cache_read_input_tokens') ?? u64('cached_tokens') ?? 0;
	const totalRaw = u64('total_tokens');
	const total
		= totalRaw != null && (totalRaw > 0 || input + output + reasoning === 0)
			? totalRaw
			: input + output + reasoning;

	return {
		inputTokens: input,
		cachedInputTokens: cached,
		outputTokens: output,
		reasoningOutputTokens: reasoning,
		totalTokens: total,
	};
}

/** Mirrors `deserialize_optional_u64_lossy`: accept unsigned ints or numeric strings. */
function optionalU64Lossy(value: unknown): number | undefined {
	if (typeof value === 'number') {
		if (Number.isInteger(value) && value >= 0) {
			return value;
		}
		return undefined;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) {
			return undefined;
		}
		const parsed = Number(trimmed);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** Mirrors `deserialize_optional_object_lossy`: only objects survive; everything else is `None`. */
export function optionalObjectLossy(value: unknown): Record<string, unknown> | undefined {
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}
