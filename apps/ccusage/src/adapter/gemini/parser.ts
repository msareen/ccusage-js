/** Gemini usage-event parsing ported from `adapter/gemini/parser.rs`.
 *
 * Reads Gemini CLI chat logs (`.json` whole-session files and `.jsonl` event
 * streams), extracts token usage from the several shapes Gemini emits (direct
 * `type:"gemini"` events, per-model `stats`, flat `stats`), and converts each to
 * a costed `LoadedEntry`. */
import { readFileSync, statSync } from 'node:fs';
import type { LoadedEntry, TokenUsageRaw, UsageEntry } from '../../core/types.ts';
import type { CostMode } from '../../core/types.ts';
import { PricingMap } from '../../core/pricing.ts';
import { calculateCostForUsage, totalUsageTokens } from '../../core/cost.ts';
import { formatDateTz, formatRfc3339Millis, parseTsTimestamp } from '../../core/date.ts';

const DEFAULT_MODEL = 'unknown';
const PROVIDER_PREFIXES = ['google', 'gemini', 'vertex_ai', 'openrouter/google'];

type Json = Record<string, unknown>;

type GeminiTokens = {
	input: number;
	output: number;
	cached: number;
	thoughts: number;
	tool: number;
	total?: number;
};

export type GeminiUsageEvent = {
	timestamp: number;
	timestampText: string;
	sessionId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	messageId?: string;
};

function isObject(value: unknown): value is Json {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Mirrors `non_empty_json_string`: trimmed non-empty string, else undefined. */
function stringAt(record: Json, key: string): string | undefined {
	const raw = asString(record[key]);
	if (raw == null) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function valueU64(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.trunc(Math.max(0, value));
}

function tokenNumber(record: Json, keys: string[]): number {
	for (const key of keys) {
		const value = valueU64(record[key]);
		if (value != null) {
			return value;
		}
	}
	return 0;
}

function parseTokens(value: unknown): GeminiTokens | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	return {
		input: tokenNumber(value, ['input', 'prompt', 'input_tokens', 'prompt_tokens']),
		output: tokenNumber(value, ['output', 'candidates', 'output_tokens', 'candidates_tokens']),
		cached: tokenNumber(value, ['cached', 'cached_tokens']),
		thoughts: tokenNumber(value, ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens']),
		tool: tokenNumber(value, ['tool', 'tool_tokens']),
		total: valueU64(value.total ?? value.total_tokens),
	};
}

function subtractCachedOverlapTokens(tokens: GeminiTokens): [number, number] {
	const cacheRead = tokens.cached;
	const cachedPortion = Math.min(tokens.input, cacheRead);
	return [tokens.input - cachedPortion, cacheRead];
}

function normalizeSessionInput(tokens: GeminiTokens): [number, number] {
	const inclusiveTotal = tokens.input + tokens.output + tokens.thoughts + tokens.tool;
	const exclusiveTotal = inclusiveTotal + tokens.cached;
	if (tokens.cached > 0 && tokens.total === inclusiveTotal && tokens.total !== exclusiveTotal) {
		return subtractCachedOverlapTokens(tokens);
	}
	return [tokens.input, tokens.cached];
}

/** Mirrors `apply_total_token_fallback`. */
function applyTotalTokenFallback(
	usage: TokenUsageRaw,
	extraTotalTokens: number,
	totalTokens: number,
): [TokenUsageRaw, number] {
	const known = totalUsageTokens(usage) + extraTotalTokens;
	const missing = Math.max(0, totalTokens - known);
	if (missing === 0) {
		return [usage, extraTotalTokens];
	}
	if (usage.output_tokens === 0) {
		return [{ ...usage, output_tokens: missing }, extraTotalTokens];
	}
	return [usage, extraTotalTokens + missing];
}

function buildEvent(
	model: string | undefined,
	sessionId: string,
	timestamp: number,
	tokens: GeminiTokens,
	normalizeInput: (tokens: GeminiTokens) => [number, number],
	messageId: string | undefined,
): GeminiUsageEvent | undefined {
	const trimmedModel = model?.trim();
	if (trimmedModel == null || trimmedModel.length === 0) {
		return undefined;
	}
	const [inputWithoutCache, cacheReadTokens] = normalizeInput(tokens);
	const inputTokens = inputWithoutCache + tokens.tool;
	const totalTokens = tokens.total
		?? inputTokens + tokens.output + cacheReadTokens + tokens.thoughts;
	const baseUsage: TokenUsageRaw = {
		input_tokens: inputTokens,
		output_tokens: tokens.output,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: cacheReadTokens,
	};
	const [displayUsage, extraTotalTokens] = applyTotalTokenFallback(baseUsage, tokens.thoughts, totalTokens);
	if (
		displayUsage.input_tokens === 0
		&& displayUsage.output_tokens === 0
		&& displayUsage.cache_read_input_tokens === 0
		&& extraTotalTokens === 0
	) {
		return undefined;
	}
	return {
		timestamp,
		timestampText: formatRfc3339Millis(timestamp),
		sessionId,
		model: trimmedModel,
		inputTokens: displayUsage.input_tokens,
		outputTokens: displayUsage.output_tokens,
		cacheReadTokens: displayUsage.cache_read_input_tokens,
		reasoningTokens: extraTotalTokens,
		totalTokens,
		messageId,
	};
}

function timestampAt(record: Json, key: string): number | undefined {
	const raw = asString(record[key]);
	return raw != null ? parseTsTimestamp(raw) : undefined;
}

function fileModifiedTimestamp(path: string): number {
	try {
		return Math.trunc(statSync(path).mtimeMs);
	}
	catch {
		return 0;
	}
}

function parseDirectEvent(
	record: Json,
	modelHint: string | undefined,
	sessionId: string,
	fallbackTimestamp: number,
): GeminiUsageEvent | undefined {
	const tokens = parseTokens(record.tokens);
	if (tokens == null) {
		return undefined;
	}
	return buildEvent(
		stringAt(record, 'model') ?? modelHint,
		sessionId,
		timestampAt(record, 'timestamp') ?? timestampAt(record, 'created_at') ?? fallbackTimestamp,
		tokens,
		normalizeSessionInput,
		stringAt(record, 'id'),
	);
}

function statsFrom(record: Json): unknown {
	if (record.stats != null) {
		return record.stats;
	}
	const result = record.result;
	return isObject(result) ? result.stats : undefined;
}

function parseStatsEvents(
	stats: unknown,
	modelHint: string | undefined,
	sessionId: string,
	timestamp: number,
): GeminiUsageEvent[] {
	if (!isObject(stats)) {
		return [];
	}
	if (isObject(stats.models)) {
		const events: GeminiUsageEvent[] = [];
		for (const [model, data] of Object.entries(stats.models)) {
			if (!isObject(data)) {
				continue;
			}
			const tokens = parseTokens(data.tokens);
			if (tokens == null) {
				continue;
			}
			const event = buildEvent(model, sessionId, timestamp, tokens, subtractCachedOverlapTokens, undefined);
			if (event != null) {
				events.push(event);
			}
		}
		if (events.length > 0) {
			return events;
		}
	}
	const tokens = parseTokens(stats);
	if (tokens == null) {
		return [];
	}
	const event = buildEvent(
		modelHint ?? DEFAULT_MODEL,
		sessionId,
		timestamp,
		tokens,
		subtractCachedOverlapTokens,
		undefined,
	);
	return event != null ? [event] : [];
}

export function parseJsonFile(path: string): GeminiUsageEvent[] {
	const fallbackTimestamp = fileModifiedTimestamp(path);
	let content: string;
	try {
		content = readFileSync(path, 'utf8');
	}
	catch {
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	}
	catch {
		return [];
	}
	if (!isObject(value)) {
		return [];
	}
	const record = value;
	const sessionId = stringAt(record, 'sessionId')
		?? stringAt(record, 'session_id')
		?? fileStem(path);
	const sessionTimestamp = timestampAt(record, 'startTime')
		?? timestampAt(record, 'lastUpdated')
		?? fallbackTimestamp;
	if (Array.isArray(record.messages)) {
		const events: GeminiUsageEvent[] = [];
		for (const message of record.messages) {
			if (isObject(message) && message.type === 'gemini') {
				const event = parseDirectEvent(message, undefined, sessionId, sessionTimestamp);
				if (event != null) {
					events.push(event);
				}
			}
		}
		return events;
	}
	if (record.type === 'gemini') {
		const event = parseDirectEvent(record, undefined, sessionId, fallbackTimestamp);
		return event != null ? [event] : [];
	}
	return parseStatsEvents(
		statsFrom(record),
		stringAt(record, 'model'),
		sessionId,
		timestampAt(record, 'timestamp') ?? fallbackTimestamp,
	);
}

export function parseJsonlFile(path: string): GeminiUsageEvent[] {
	const fallbackTimestamp = fileModifiedTimestamp(path);
	let sessionId = fileStem(path);
	let currentModel: string | undefined;
	const events: GeminiUsageEvent[] = [];
	const directEventIndexes = new Map<string, number>();
	let content: string;
	try {
		content = readFileSync(path, 'utf8');
	}
	catch {
		return [];
	}
	for (const line of content.split('\n')) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		}
		catch {
			continue;
		}
		if (!isObject(value)) {
			continue;
		}
		const record = value;
		const session = stringAt(record, 'sessionId') ?? stringAt(record, 'session_id');
		if (session != null) {
			sessionId = session;
		}
		const model = stringAt(record, 'model');
		if (model != null) {
			currentModel = model;
		}
		if (record.type === 'gemini') {
			const event = parseDirectEvent(record, currentModel, sessionId, fallbackTimestamp);
			if (event == null) {
				continue;
			}
			const id = stringAt(record, 'id');
			if (id != null) {
				const index = directEventIndexes.get(id);
				if (index != null) {
					events[index] = event;
				}
				else {
					directEventIndexes.set(id, events.length);
					events.push(event);
				}
			}
			else {
				events.push(event);
			}
			continue;
		}
		const stats = statsFrom(record);
		if (stats != null) {
			events.push(...parseStatsEvents(
				stats,
				currentModel,
				sessionId,
				timestampAt(record, 'timestamp') ?? fallbackTimestamp,
			));
		}
	}
	return events;
}

function fileStem(p: string): string {
	const base = p.replace(/\\/g, '/').split('/').pop() ?? '';
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return stem.length > 0 ? stem : 'unknown';
}

function modelCandidates(model: string): string[] {
	const candidates = [...PROVIDER_PREFIXES.map(prefix => `${prefix}/${model}`), model];
	const seen = new Set<string>();
	return candidates.filter(candidate => (seen.has(candidate) ? false : (seen.add(candidate), true)));
}

function calculateGeminiCost(
	model: string,
	usage: TokenUsageRaw,
	mode: CostMode,
	pricing: PricingMap,
): number {
	if (mode === 'display') {
		return 0;
	}
	for (const candidate of modelCandidates(model)) {
		if (pricing.find(candidate) != null) {
			return calculateCostForUsage(candidate, usage, undefined, 'calculate', pricing);
		}
	}
	return 0;
}

function missingGeminiPricing(
	model: string,
	usage: TokenUsageRaw,
	mode: CostMode,
	pricing: PricingMap,
): string | undefined {
	if (mode === 'display') {
		return undefined;
	}
	const total = totalUsageTokens(usage);
	if (total === 0) {
		return undefined;
	}
	const allMissing = modelCandidates(model).every(candidate => pricing.find(candidate) == null);
	return allMissing ? model : undefined;
}

export function eventToLoaded(
	event: GeminiUsageEvent,
	tz: string | undefined,
	mode: CostMode,
	pricing: PricingMap,
): LoadedEntry {
	const usage: TokenUsageRaw = {
		input_tokens: event.inputTokens,
		output_tokens: event.outputTokens,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: event.cacheReadTokens,
	};
	const costUsage: TokenUsageRaw = {
		...usage,
		output_tokens: event.outputTokens + event.reasoningTokens,
	};
	const extraTotalTokens = Math.max(
		0,
		event.totalTokens - (event.inputTokens + event.outputTokens + event.cacheReadTokens),
	);
	const cost = calculateGeminiCost(event.model, costUsage, mode, pricing);
	const missingPricingModel = missingGeminiPricing(event.model, costUsage, mode, pricing);
	const data: UsageEntry = {
		sessionId: event.sessionId,
		timestamp: event.timestampText,
		message: {
			usage,
			model: event.model,
			id: event.messageId,
		},
	};
	return {
		data,
		date: formatDateTz(event.timestamp, tz),
		timestamp: event.timestamp,
		project: 'gemini',
		sessionId: event.sessionId,
		projectPath: 'Gemini',
		cost,
		extraTotalTokens,
		model: event.model,
		missingPricingModel,
	};
}
