/**
 * Codex session/headless JSONL parsing, ported from `adapter/codex/parser.rs`.
 *
 * The Rust version uses byte-level prefilters purely for speed; the observable
 * behaviour is driven by the JSON `type` values and usage fields, which we read
 * here after a single `JSON.parse` per line.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatRfc3339Millis, parseTsTimestamp } from '../../core/date.ts';
import type { CodexRawUsage, CodexTokenUsageEvent } from './types.ts';
import { codexRawUsageFromJson, optionalObjectLossy } from './types.ts';

const SUBAGENT_PREFIX_BYTES = 16 * 1024;

type LineKind = 'session' | 'headless' | undefined;

type JsonObject = Record<string, unknown>;

export function visitCodexSessionFile(
	sessionsDir: string,
	filePath: string,
	visit: (event: CodexTokenUsageEvent) => void,
): void {
	let content: string;
	try {
		content = readFileSync(filePath, 'utf8');
	}
	catch {
		return;
	}

	const lines = content.split('\n');
	const isSubagent = content.slice(0, SUBAGENT_PREFIX_BYTES).includes('thread_spawn');
	const replaySecond = isSubagent ? detectSubagentReplaySecond(lines) : undefined;
	const sessionId = codexSessionId(sessionsDir, filePath);
	const fallbackTimestamp = fileModifiedTimestamp(filePath);

	const state: ParseState = {
		previousTotals: undefined,
		currentModel: undefined,
		currentModelIsFallback: false,
		skipReplay: replaySecond != null,
	};

	for (const line of lines) {
		const kind = codexLineUsageKind(line);
		if (kind == null) {
			continue;
		}
		let obj: JsonObject;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				continue;
			}
			obj = parsed as JsonObject;
		}
		catch {
			continue;
		}

		if (kind === 'session') {
			if (replaySecond != null && state.skipReplay && isReplayCandidate(obj)) {
				const ts = codexSessionTimestamp(obj.timestamp);
				if (ts == null) {
					continue;
				}
				if (ts.length >= 19 && ts.slice(0, 19) === replaySecond) {
					const payload = optionalObjectLossy(obj.payload);
					const info = payload ? optionalObjectLossy(payload.info) : undefined;
					const totalUsage = info ? codexRawUsageFromJson(info.total_token_usage) : undefined;
					if (totalUsage != null) {
						state.previousTotals = totalUsage;
					}
					continue;
				}
				state.skipReplay = false;
			}
			visitCodexSessionEntry(sessionId, obj, state, visit);
		}
		else {
			visitCodexExecEntry(sessionId, obj, fallbackTimestamp, state, visit);
		}
	}
}

type ParseState = {
	previousTotals: CodexRawUsage | undefined;
	currentModel: string | undefined;
	currentModelIsFallback: boolean;
	skipReplay: boolean;
};

function isReplayCandidate(obj: JsonObject): boolean {
	if (obj.type !== 'event_msg') {
		return false;
	}
	const payload = optionalObjectLossy(obj.payload);
	return payload?.type === 'token_count';
}

function detectSubagentReplaySecond(lines: string[]): string | undefined {
	let firstSecond: string | undefined;
	for (const line of lines) {
		if (codexLineUsageKind(line) !== 'session') {
			continue;
		}
		let obj: JsonObject;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				continue;
			}
			obj = parsed as JsonObject;
		}
		catch {
			continue;
		}
		if (obj.type !== 'event_msg') {
			continue;
		}
		const payload = optionalObjectLossy(obj.payload);
		if (payload == null || payload.type !== 'token_count') {
			continue;
		}
		const info = optionalObjectLossy(payload.info);
		const hasUsage
			= info != null
				&& (codexRawUsageFromJson(info.last_token_usage) != null
					|| codexRawUsageFromJson(info.total_token_usage) != null);
		if (!hasUsage) {
			continue;
		}
		const ts = codexSessionTimestamp(obj.timestamp);
		if (ts == null) {
			continue;
		}
		if (ts.length < 19) {
			return undefined;
		}
		const second = ts.slice(0, 19);
		if (firstSecond == null) {
			firstSecond = second;
		}
		else {
			return firstSecond === second ? second : undefined;
		}
	}
	return undefined;
}

function visitCodexSessionEntry(
	sessionId: string,
	obj: JsonObject,
	state: ParseState,
	visit: (event: CodexTokenUsageEvent) => void,
): void {
	const entryType = obj.type;
	if (entryType === 'turn_context') {
		const payload = optionalObjectLossy(obj.payload);
		const model = payload ? codexModelFromParts(payload) : undefined;
		if (model != null) {
			state.currentModel = model;
			state.currentModelIsFallback = false;
		}
		return;
	}
	if (entryType !== 'event_msg') {
		return;
	}
	const timestamp = codexSessionTimestamp(obj.timestamp);
	if (timestamp == null) {
		return;
	}
	const payload = optionalObjectLossy(obj.payload);
	if (payload == null || payload.type !== 'token_count') {
		return;
	}
	const info = optionalObjectLossy(payload.info);
	const totalUsage = info ? codexRawUsageFromJson(info.total_token_usage) : undefined;
	const lastUsage = info ? codexRawUsageFromJson(info.last_token_usage) : undefined;
	const rawUsage
		= lastUsage
			?? (totalUsage != null ? subtractCodexRawUsage(totalUsage, state.previousTotals) : undefined);
	if (totalUsage != null) {
		state.previousTotals = totalUsage;
	}
	if (rawUsage == null) {
		return;
	}
	if (
		rawUsage.inputTokens === 0
		&& rawUsage.cachedInputTokens === 0
		&& rawUsage.outputTokens === 0
		&& rawUsage.reasoningOutputTokens === 0
	) {
		return;
	}

	const parsedModel
		= codexModelFromParts(payload) ?? (info ? codexModelFromParts(info) : undefined);
	const model = resolveModel(parsedModel, state);
	const isFallback = computeIsFallback(parsedModel, model, state);
	emit(sessionId, timestamp, model, rawUsage, isFallback, visit);
}

function visitCodexExecEntry(
	sessionId: string,
	obj: JsonObject,
	fallbackTimestamp: string,
	state: ParseState,
	visit: (event: CodexTokenUsageEvent) => void,
): void {
	const rawUsage = normalizeHeadlessUsage(obj);
	if (rawUsage == null) {
		return;
	}
	const parsedModel = codexModelFromResultValue(obj);
	const timestamp = codexTimestampFromResultValue(obj) ?? fallbackTimestamp;
	const model = resolveModel(parsedModel, state);
	const isFallback = computeIsFallback(parsedModel, model, state);
	emit(sessionId, timestamp, model, rawUsage, isFallback, visit);
}

/** Shared model-resolution from `visit_codex_*` (mutates fallback state). */
function resolveModel(parsedModel: string | undefined, state: ParseState): string {
	if (parsedModel != null) {
		state.currentModel = parsedModel;
		state.currentModelIsFallback = false;
		return parsedModel;
	}
	if (state.currentModel != null) {
		return state.currentModel;
	}
	state.currentModelIsFallback = true;
	state.currentModel = 'gpt-5';
	return 'gpt-5';
}

function computeIsFallback(
	parsedModel: string | undefined,
	model: string,
	state: ParseState,
): boolean {
	// `is_fallback_model` is true when we fell back to "gpt-5", or when a model
	// is carried over from an earlier fallback (`current_model_is_fallback`).
	const usedFallbackBranch = parsedModel == null && model === 'gpt-5' && state.currentModelIsFallback;
	const inheritedFallback = state.currentModelIsFallback && state.currentModel != null;
	return usedFallbackBranch || inheritedFallback;
}

function emit(
	sessionId: string,
	timestamp: string,
	model: string,
	rawUsage: CodexRawUsage,
	isFallbackModel: boolean,
	visit: (event: CodexTokenUsageEvent) => void,
): void {
	visit({
		sessionId,
		timestamp,
		model,
		inputTokens: rawUsage.inputTokens,
		cachedInputTokens: Math.min(rawUsage.cachedInputTokens, rawUsage.inputTokens),
		outputTokens: rawUsage.outputTokens,
		reasoningOutputTokens: rawUsage.reasoningOutputTokens,
		totalTokens: rawUsage.totalTokens,
		isFallbackModel,
	});
}

function codexLineUsageKind(line: string): LineKind {
	const hasEventMsg = line.includes('"type":"event_msg"');
	const hasTokenCount = line.includes('"type":"token_count"');
	const hasTurnContext = line.includes('"type":"turn_context"');
	if (hasTurnContext || (hasEventMsg && hasTokenCount)) {
		return 'session';
	}
	if (
		line.includes('"usage":')
		|| line.includes('"input_tokens":')
		|| line.includes('"prompt_tokens":')
	) {
		return 'headless';
	}
	return undefined;
}

function codexSessionTimestamp(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const text = value.trim();
		return text.length > 0 ? text : undefined;
	}
	if (typeof value === 'number') {
		return normalizeNumericTimestamp(value);
	}
	return undefined;
}

function normalizeCodexTimestamp(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const text = value.trim();
		if (text.length === 0) {
			return undefined;
		}
		const ms = parseTsTimestamp(text);
		return ms != null ? formatRfc3339Millis(ms) : undefined;
	}
	if (typeof value === 'number') {
		return normalizeNumericTimestamp(value);
	}
	return undefined;
}

function normalizeNumericTimestamp(raw: number): string | undefined {
	if (!Number.isFinite(raw) || raw < 0) {
		return undefined;
	}
	const millis = raw > 10_000_000_000 ? raw : raw * 1000;
	return formatRfc3339Millis(Math.trunc(millis));
}

function codexModelFromParts(obj: JsonObject): string | undefined {
	return (
		nonEmptyString(obj.model)
		?? nonEmptyString(obj.model_name)
		?? nonEmptyString(optionalObjectLossy(obj.metadata)?.model)
	);
}

function codexModelFromResultValue(obj: JsonObject): string | undefined {
	return (
		codexModelFromParts(obj)
		?? fromChild(obj.data, codexModelFromParts)
		?? fromChild(obj.result, codexModelFromParts)
		?? fromChild(obj.response, codexModelFromParts)
	);
}

function codexTimestampFromResultValue(obj: JsonObject): string | undefined {
	return (
		normalizeValueFieldsTimestamp(obj)
		?? fromChild(obj.data, normalizeValueFieldsTimestamp)
		?? fromChild(obj.result, normalizeValueFieldsTimestamp)
		?? fromChild(obj.response, normalizeValueFieldsTimestamp)
	);
}

function normalizeValueFieldsTimestamp(obj: JsonObject): string | undefined {
	return (
		normalizeCodexTimestamp(obj.timestamp)
		?? normalizeCodexTimestamp(obj.created_at)
		?? normalizeCodexTimestamp(obj.createdAt)
	);
}

function normalizeHeadlessUsage(obj: JsonObject): CodexRawUsage | undefined {
	const usage = usageFromResultValue(obj);
	if (usage == null) {
		return undefined;
	}
	if (
		usage.inputTokens === 0
		&& usage.cachedInputTokens === 0
		&& usage.outputTokens === 0
		&& usage.reasoningOutputTokens === 0
		&& usage.totalTokens === 0
	) {
		return undefined;
	}
	return usage;
}

function usageFromResultValue(obj: JsonObject): CodexRawUsage | undefined {
	return (
		codexRawUsageFromJson(obj.usage)
		?? fromChild(obj.data, child => codexRawUsageFromJson(child.usage))
		?? fromChild(obj.result, child => codexRawUsageFromJson(child.usage))
		?? fromChild(obj.response, child => codexRawUsageFromJson(child.usage))
	);
}

function fromChild<T>(value: unknown, read: (obj: JsonObject) => T | undefined): T | undefined {
	const obj = optionalObjectLossy(value);
	return obj ? read(obj) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const text = value.trim();
	return text.length > 0 ? text : undefined;
}

function subtractCodexRawUsage(
	current: CodexRawUsage,
	previous: CodexRawUsage | undefined,
): CodexRawUsage {
	const sub = (a: number, b: number): number => Math.max(0, a - b);
	return {
		inputTokens: sub(current.inputTokens, previous?.inputTokens ?? 0),
		cachedInputTokens: sub(current.cachedInputTokens, previous?.cachedInputTokens ?? 0),
		outputTokens: sub(current.outputTokens, previous?.outputTokens ?? 0),
		reasoningOutputTokens: sub(current.reasoningOutputTokens, previous?.reasoningOutputTokens ?? 0),
		totalTokens: sub(current.totalTokens, previous?.totalTokens ?? 0),
	};
}

/** Mirrors `codex_session_id`: path relative to sessions dir, ext stripped, '/'-joined. */
function codexSessionId(sessionsDir: string, filePath: string): string {
	let relative = path.relative(sessionsDir, filePath);
	if (relative === '' || relative.startsWith('..')) {
		relative = filePath;
	}
	const withoutExt = relative.replace(/\.[^./\\]*$/, '');
	const sessionId = withoutExt
		.split(/[/\\]/)
		.filter(part => part.length > 0)
		.join('/');
	return sessionId.length > 0 ? sessionId : 'unknown';
}

function fileModifiedTimestamp(filePath: string): string {
	try {
		const ms = statSync(filePath).mtimeMs;
		return formatRfc3339Millis(Math.trunc(ms));
	}
	catch {
		return formatRfc3339Millis(0);
	}
}
