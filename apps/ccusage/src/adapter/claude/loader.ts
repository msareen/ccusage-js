/**
 * Claude usage loading ported from `adapter/claude/mod.rs` and `daily.rs`.
 *
 * Reads JSONL usage files, validates and costs entries, then deduplicates by
 * message/request id (with the sidechain-replay handling from the Rust loader).
 */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import type { LoadedEntry, TokenUsageRaw, UsageEntry, UsageSummary } from '../../core/types.ts';
import {
	addUsage,
	cacheCreationTokenCount,
	newModelBreakdown,
	newTokenCounts,
	newUsageSummary,
} from '../../core/types.ts';
import type { SharedArgs } from '../../core/options.ts';
import { PricingMap } from '../../core/pricing.ts';
import { calculateCostForUsage, missingPricingModelForUsage } from '../../core/cost.ts';
import { formatDateTz, isValidTimezone, parseTsTimestamp } from '../../core/date.ts';
import { claudePaths, extractProject, extractSessionParts, usageFiles } from './paths.ts';

const NULLABLE_REJECT_FIELDS = new Set([
	'id', 'cwd', 'model', 'speed', 'costUSD', 'version', 'sessionId', 'requestId',
	'isApiErrorMessage', 'cache_read_input_tokens', 'cache_creation_input_tokens',
]);

function isSemverPrefix(value: string): boolean {
	return /^\d+\.\d+\.\d/.test(value);
}

/** Mirrors `has_unsupported_null_field`: reject lines that null a non-nullable field. */
function hasUnsupportedNullField(line: string): boolean {
	let offset = 0;
	for (;;) {
		const nullIndex = line.indexOf(':null', offset);
		if (nullIndex < 0) {
			return false;
		}
		let fieldEnd = nullIndex - 1;
		if (line[fieldEnd] !== '"') {
			while (fieldEnd > 0 && line[fieldEnd] !== '"') {
				fieldEnd -= 1;
			}
		}
		if (line[fieldEnd] === '"') {
			let fieldStart = fieldEnd - 1;
			while (fieldStart > 0 && line[fieldStart] !== '"') {
				fieldStart -= 1;
			}
			if (line[fieldStart] === '"' && NULLABLE_REJECT_FIELDS.has(line.slice(fieldStart + 1, fieldEnd))) {
				return true;
			}
		}
		offset = nullIndex + ':null'.length;
	}
}

function isNonEmptyOrAbsent(value: string | undefined): boolean {
	return value == null || value.length > 0;
}

function normalizeUsage(raw: unknown): TokenUsageRaw {
	const u = (raw ?? {}) as Record<string, unknown>;
	const cacheCreationRaw = u.cache_creation as Record<string, unknown> | undefined;
	return {
		input_tokens: Number(u.input_tokens ?? 0),
		output_tokens: Number(u.output_tokens ?? 0),
		cache_creation_input_tokens: Number(u.cache_creation_input_tokens ?? 0),
		cache_read_input_tokens: Number(u.cache_read_input_tokens ?? 0),
		speed: u.speed === 'fast' ? 'fast' : u.speed === 'standard' ? 'standard' : undefined,
		cache_creation: cacheCreationRaw != null
			? {
					ephemeral_5m_input_tokens: Number(cacheCreationRaw.ephemeral_5m_input_tokens ?? 0),
					ephemeral_1h_input_tokens: Number(cacheCreationRaw.ephemeral_1h_input_tokens ?? 0),
				}
			: undefined,
	};
}

/** Parse a usage line into a `UsageEntry`, handling agent-progress wrappers. */
function parseUsageEntry(raw: Record<string, unknown>): UsageEntry | undefined {
	// Agent-progress lines wrap the message under `data.message`.
	let source = raw;
	const data = raw.data as Record<string, unknown> | undefined;
	const wrapped = data?.message as Record<string, unknown> | undefined;
	if (wrapped?.message != null && wrapped.timestamp != null) {
		source = {
			timestamp: wrapped.timestamp,
			message: wrapped.message,
			costUSD: wrapped.costUSD,
			requestId: wrapped.requestId,
			isSidechain: wrapped.isSidechain,
		};
	}

	const message = source.message as Record<string, unknown> | undefined;
	if (message?.usage == null) {
		return undefined;
	}
	const timestamp = source.timestamp;
	if (typeof timestamp !== 'string') {
		return undefined;
	}
	return {
		sessionId: source.sessionId as string | undefined,
		timestamp,
		version: source.version as string | undefined,
		message: {
			usage: normalizeUsage(message.usage),
			model: message.model as string | undefined,
			id: message.id as string | undefined,
		},
		costUSD: source.costUSD as number | undefined,
		requestId: source.requestId as string | undefined,
		isApiErrorMessage: source.isApiErrorMessage as boolean | undefined,
		isSidechain: source.isSidechain as boolean | undefined,
	};
}

function isValidUsageEntry(data: UsageEntry): boolean {
	if (data.version != null && !isSemverPrefix(data.version)) {
		return false;
	}
	return (
		isNonEmptyOrAbsent(data.sessionId)
		&& isNonEmptyOrAbsent(data.requestId)
		&& isNonEmptyOrAbsent(data.message.id)
		&& isNonEmptyOrAbsent(data.message.model)
	);
}

function modelLabel(data: UsageEntry): string | undefined {
	const model = data.message.model;
	if (model == null) {
		return undefined;
	}
	if (model === '<synthetic>') {
		return undefined;
	}
	return data.message.usage.speed === 'fast' ? `${model}-fast` : model;
}

function usageLimitResetTime(rawLine: string, isApiError: boolean | undefined): number | undefined {
	if (isApiError !== true) {
		return undefined;
	}
	const markerStart = rawLine.indexOf('Claude AI usage limit reached');
	if (markerStart < 0) {
		return undefined;
	}
	const pipeIndex = rawLine.indexOf('|', markerStart);
	if (pipeIndex < 0) {
		return undefined;
	}
	const start = pipeIndex + 1;
	let end = start;
	while (end < rawLine.length && rawLine[end]! >= '0' && rawLine[end]! <= '9') {
		end += 1;
	}
	if (start === end) {
		return undefined;
	}
	const seconds = Number(rawLine.slice(start, end));
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return undefined;
	}
	return seconds * 1000;
}

type ParsedEntry = {
	data: UsageEntry;
	timestamp: number;
	date: string;
	cost: number;
	model?: string;
	missingPricingModel?: string;
	usageLimitResetTime?: number;
};

function parseFileLines(content: string, shared: SharedArgs, tz: string | undefined, pricing: PricingMap | undefined): ParsedEntry[] {
	const out: ParsedEntry[] = [];
	for (const line of content.split('\n')) {
		if (!line.includes('"usage":{')) {
			continue;
		}
		if (hasUnsupportedNullField(line)) {
			continue;
		}
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(line) as Record<string, unknown>;
		}
		catch {
			continue;
		}
		const data = parseUsageEntry(raw);
		if (data == null) {
			continue;
		}
		const timestamp = parseTsTimestamp(data.timestamp);
		if (timestamp == null) {
			continue;
		}
		if (!isValidUsageEntry(data)) {
			continue;
		}
		const cost = calculateCostForUsage(data.message.model, data.message.usage, data.costUSD, shared.mode, pricing);
		const missingPricingModel = missingPricingModelForUsage(
			data.message.model, data.message.usage, data.costUSD, shared.mode, pricing,
		);
		out.push({
			data,
			timestamp,
			date: formatDateTz(timestamp, tz),
			cost,
			model: modelLabel(data),
			missingPricingModel,
			usageLimitResetTime: usageLimitResetTime(line, data.isApiErrorMessage),
		});
	}
	return out;
}

function usageTokenTotal(data: UsageEntry): number {
	const usage = data.message.usage;
	return usage.input_tokens + usage.output_tokens + cacheCreationTokenCount(usage) + usage.cache_read_input_tokens;
}

function isSidechain(data: UsageEntry): boolean {
	return data.isSidechain === true;
}

function shouldReplace(candidate: UsageEntry, existing: UsageEntry): boolean {
	const candidateSide = isSidechain(candidate);
	const existingSide = isSidechain(existing);
	if (candidateSide !== existingSide) {
		return existingSide;
	}
	const candidateTotal = usageTokenTotal(candidate);
	const existingTotal = usageTokenTotal(existing);
	if (candidateTotal !== existingTotal) {
		return candidateTotal > existingTotal;
	}
	return candidate.message.usage.speed != null && existing.message.usage.speed == null;
}

/** Deduplicate by (messageId, requestId), with sidechain-replay fallback. Mirrors `push_deduped_entry`. */
function dedupe(entries: LoadedEntry[]): LoadedEntry[] {
	const deduped: LoadedEntry[] = [];
	const exactIndexes = new Map<string, number[]>();
	const messageIndexes = new Map<string, number[]>();

	const register = (map: Map<string, number[]>, key: string, index: number): void => {
		let list = map.get(key);
		if (list == null) {
			list = [];
			map.set(key, list);
		}
		if (!list.includes(index)) {
			list.push(index);
		}
	};

	for (const entry of entries) {
		const messageId = entry.data.message.id;
		if (messageId == null) {
			deduped.push(entry);
			continue;
		}
		const requestId = entry.data.requestId;
		const exactKey = `${messageId} ${requestId ?? ''}`;
		const candidateSide = isSidechain(entry.data);

		let existingIndex: number | undefined = exactIndexes.get(exactKey)?.find(
			i => deduped[i]!.data.message.id === messageId && deduped[i]!.data.requestId === requestId,
		);
		if (existingIndex == null) {
			existingIndex = messageIndexes.get(messageId)?.find(
				i => deduped[i]!.data.message.id === messageId && (candidateSide || isSidechain(deduped[i]!.data)),
			);
		}

		if (existingIndex != null) {
			if (shouldReplace(entry.data, deduped[existingIndex]!.data)) {
				deduped[existingIndex] = entry;
				register(exactIndexes, exactKey, existingIndex);
				register(messageIndexes, messageId, existingIndex);
			}
			continue;
		}

		const index = deduped.length;
		deduped.push(entry);
		register(exactIndexes, exactKey, index);
		register(messageIndexes, messageId, index);
	}
	return deduped;
}

async function readParsedFiles(
	files: string[],
	shared: SharedArgs,
	tz: string | undefined,
	pricing: PricingMap | undefined,
): Promise<ParsedEntry[][]> {
	const read = async (file: string): Promise<ParsedEntry[]> => {
		let content: string;
		try {
			content = await readFile(file, 'utf8');
		}
		catch {
			return [];
		}
		return parseFileLines(content, shared, tz, pricing);
	};

	if (shared.singleThread) {
		const result: ParsedEntry[][] = [];
		for (const file of files) {
			result.push(await read(file));
		}
		return result;
	}
	return Promise.all(files.map(read));
}

async function buildPricing(shared: SharedArgs): Promise<PricingMap | undefined> {
	if (shared.mode === 'display') {
		return undefined;
	}
	return PricingMap.loadWithOverrides(shared.offline, shared.pricingOverrides);
}

/** Mirrors `claude::load_entries`: full deduped entry list. */
export async function loadEntries(shared: SharedArgs, projectFilter: string | undefined): Promise<LoadedEntry[]> {
	const paths = claudePaths();
	const files = usageFiles(paths, projectFilter);
	if (files.length === 0) {
		return [];
	}
	const pricing = await buildPricing(shared);
	const tz = isValidTimezone(shared.timezone);
	const parsedFiles = await readParsedFiles(files, shared, tz, pricing);

	const loaded: LoadedEntry[] = [];
	for (let i = 0; i < files.length; i++) {
		const project = extractProject(files[i]!);
		const [sessionId, projectPath] = extractSessionParts(files[i]!);
		for (const parsed of parsedFiles[i]!) {
			if (projectFilter != null && project !== projectFilter) {
				continue;
			}
			loaded.push({
				data: parsed.data,
				timestamp: parsed.timestamp,
				date: parsed.date,
				project,
				sessionId,
				projectPath,
				cost: parsed.cost,
				extraTotalTokens: 0,
				model: parsed.model,
				usageLimitResetTime: parsed.usageLimitResetTime,
				missingPricingModel: parsed.missingPricingModel,
			});
		}
	}
	return dedupe(loaded);
}

export function filterLoadedEntriesByDate(entries: LoadedEntry[], shared: SharedArgs): LoadedEntry[] {
	if (shared.since == null && shared.until == null) {
		return entries;
	}
	return entries.filter((entry) => {
		const date = entry.date.replace(/-/g, '');
		return (shared.since == null || date >= shared.since) && (shared.until == null || date <= shared.until);
	});
}

/** Mirrors `claude::load_daily_summaries`: group deduped entries by date (and optionally project). */
export async function loadDailySummaries(
	shared: SharedArgs,
	projectFilter: string | undefined,
	groupByProject: boolean,
): Promise<UsageSummary[]> {
	const entries = await loadEntries(shared, projectFilter);

	type Acc = {
		counts: ReturnType<typeof newTokenCounts>;
		cost: number;
		models: string[];
		breakdowns: ReturnType<typeof newModelBreakdown>[];
		breakdownIndexes: Map<string, number>;
	};
	const newAcc = (): Acc => ({
		counts: newTokenCounts(),
		cost: 0,
		models: [],
		breakdowns: [],
		breakdownIndexes: new Map(),
	});
	const addEntry = (acc: Acc, entry: LoadedEntry): void => {
		const usage = entry.data.message.usage;
		addUsage(acc.counts, usage);
		acc.cost += entry.cost;
		const model = entry.model;
		if (model != null) {
			let index = acc.breakdownIndexes.get(model);
			if (index == null) {
				index = acc.breakdowns.length;
				acc.breakdownIndexes.set(model, index);
				acc.models.push(model);
				acc.breakdowns.push(newModelBreakdown(model));
			}
			const b = acc.breakdowns[index]!;
			b.inputTokens += usage.input_tokens;
			b.outputTokens += usage.output_tokens;
			b.cacheCreationTokens += cacheCreationTokenCount(usage);
			b.cacheReadTokens += usage.cache_read_input_tokens;
			b.cost += entry.cost;
			if (entry.missingPricingModel != null) {
				b.missingPricing = true;
			}
		}
	};
	const intoSummary = (acc: Acc): UsageSummary => {
		acc.breakdowns.sort((a, b) => b.cost - a.cost);
		const summary = newUsageSummary();
		summary.inputTokens = acc.counts.inputTokens;
		summary.outputTokens = acc.counts.outputTokens;
		summary.cacheCreationTokens = acc.counts.cacheCreationTokens;
		summary.cacheReadTokens = acc.counts.cacheReadTokens;
		summary.totalCost = acc.cost;
		summary.modelsUsed = acc.models;
		summary.modelBreakdowns = acc.breakdowns;
		return summary;
	};

	if (groupByProject) {
		const groups = new Map<string, Acc>();
		const meta = new Map<string, [string, string]>();
		for (const entry of entries) {
			const key = `${entry.date} ${entry.project}`;
			let acc = groups.get(key);
			if (acc == null) {
				acc = newAcc();
				groups.set(key, acc);
				meta.set(key, [entry.date, entry.project]);
			}
			addEntry(acc, entry);
		}
		return [...groups.keys()].sort().map((key) => {
			const summary = intoSummary(groups.get(key)!);
			const [date, project] = meta.get(key)!;
			summary.date = date;
			summary.project = project;
			return summary;
		});
	}

	const groups = new Map<string, Acc>();
	for (const entry of entries) {
		let acc = groups.get(entry.date);
		if (acc == null) {
			acc = newAcc();
			groups.set(entry.date, acc);
		}
		addEntry(acc, entry);
	}
	return [...groups.keys()].sort().map((date) => {
		const summary = intoSummary(groups.get(date)!);
		summary.date = date;
		return summary;
	});
}

export function fileMtimeMs(p: string): number | undefined {
	try {
		return statSync(p).mtimeMs;
	}
	catch {
		return undefined;
	}
}
