/**
 * `statusline` command, ported from the statusline half of
 * `rust/crates/ccusage/src/commands/mod.rs`.
 *
 * Reads a Claude Code statusline hook JSON from stdin and prints a one-line
 * status string. Optionally caches the rendered line per session.
 */
import process from 'node:process';
import { readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedArgs } from '../core/options.ts';
import { defaultSharedArgs } from '../core/options.ts';
import { PricingMap } from '../core/pricing.ts';
import { formatDateTz, formatRfc3339Millis, utcNow, MILLIS_PER_MINUTE } from '../core/date.ts';
import { formatCurrency, formatNumber, terminalStyle } from '../core/table-output.ts';
import type { Color } from '../terminal/table.ts';
import { color } from '../terminal/table.ts';
import {
	calculateBurnRate,
	formatRemainingTime,
	identifySessionBlocks,
} from './blocks.ts';
import { loadEntries } from '../adapter/claude/loader.ts';
import { CliError } from '../cli/errors.ts';

const DEFAULT_SESSION_DURATION_HOURS = 5;

export type VisualBurnRate = 'off' | 'emoji' | 'text' | 'emoji-text';
export type CostSource = 'auto' | 'ccusage' | 'cc' | 'both';

export type StatuslineArgs = {
	offline: boolean;
	noOffline: boolean;
	visualBurnRate: VisualBurnRate;
	costSource: CostSource;
	cache: boolean;
	noCache: boolean;
	refreshInterval: number;
	contextLowThreshold: number;
	contextMediumThreshold: number;
	timezone?: string;
	config?: string;
	debug: boolean;
	modelLabelAliases: Map<string, string>;
	pricingOverrides: SharedArgs['pricingOverrides'];
};

export function defaultStatuslineArgs(): StatuslineArgs {
	return {
		offline: true,
		noOffline: false,
		visualBurnRate: 'off',
		costSource: 'auto',
		cache: true,
		noCache: false,
		refreshInterval: 1,
		contextLowThreshold: 50,
		contextMediumThreshold: 80,
		debug: false,
		modelLabelAliases: new Map(),
		pricingOverrides: new Map(),
	};
}

type HookModel = { id?: string; display_name: string };
type HookCost = { total_cost_usd: number };
type HookContext = { total_input_tokens: number; context_window_size: number };
type StatuslineHook = {
	session_id: string;
	transcript_path: string;
	model: HookModel;
	cost?: HookCost;
	context_window?: HookContext;
};

type StatuslineCache = {
	date: string;
	lastOutput: string;
	lastUpdateTime: number;
	transcriptPath: string;
	transcriptMtime: number;
	isUpdating: boolean;
	pid?: number;
};

function resolveModelLabel(aliases: Map<string, string>, displayName: string): string {
	return aliases.get(displayName) ?? displayName;
}

async function calculateSessionCost(sessionId: string, shared: SharedArgs): Promise<number> {
	const entries = await loadEntries(shared, undefined);
	// Rust sums via `f64::sum()`, whose empty/identity value is -0.0.
	let total = -0;
	for (const entry of entries) {
		if (entry.data.sessionId === sessionId || entry.sessionId === sessionId) {
			total += entry.cost;
		}
	}
	return total;
}

function statuslineTodayShared(args: StatuslineArgs, shared: SharedArgs, now: number): SharedArgs {
	const today = formatDateTz(now, args.timezone).replace(/-/g, '');
	return {
		...defaultSharedArgs(),
		since: today,
		until: today,
		offline: shared.offline,
		pricingOverrides: shared.pricingOverrides,
		timezone: args.timezone,
	};
}

function statuslineContextColor(percentage: number, args: StatuslineArgs): Color {
	if (percentage < args.contextLowThreshold) {
		return 'green';
	}
	if (percentage < args.contextMediumThreshold) {
		return 'yellow';
	}
	return 'red';
}

function formatStatuslineContext(
	inputTokens: number,
	contextLimit: number,
	args: StatuslineArgs,
	shared: SharedArgs,
): string {
	const percentage = contextLimit === 0
		? 0
		: Math.round((inputTokens / contextLimit) * 100);
	const contextColor = statuslineContextColor(percentage, args);
	return `${formatNumber(inputTokens)} (${color(terminalStyle(shared), `${percentage}%`, contextColor)})`;
}

async function calculateContextTokensFromTranscript(
	path: string,
	modelId: string | undefined,
	offline: boolean,
	shared: SharedArgs,
): Promise<HookContext | undefined> {
	let content: string;
	try {
		content = readFileSync(path, 'utf8');
	}
	catch {
		return undefined;
	}
	let pricing: PricingMap | undefined;
	const lines = content.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		if (line.length === 0) {
			continue;
		}
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line);
		}
		catch {
			continue;
		}
		if (value.type !== 'assistant') {
			continue;
		}
		const message = value.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, unknown> | undefined;
		if (usage == null) {
			continue;
		}
		const inputTokens = usage.input_tokens;
		if (typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0) {
			continue;
		}
		const cacheCreation = typeof usage.cache_creation_input_tokens === 'number'
			? usage.cache_creation_input_tokens
			: 0;
		const cacheRead = typeof usage.cache_read_input_tokens === 'number'
			? usage.cache_read_input_tokens
			: 0;
		let contextWindowSize = 200000;
		if (modelId != null && modelId.length > 0) {
			if (pricing == null) {
				pricing = await PricingMap.loadWithOverrides(offline, shared.pricingOverrides);
			}
			const limit = pricing.contextLimit(modelId);
			if (limit != null) {
				contextWindowSize = limit;
			}
		}
		return {
			total_input_tokens: inputTokens + cacheCreation + cacheRead,
			context_window_size: contextWindowSize,
		};
	}
	return undefined;
}

async function renderStatusline(
	hook: StatuslineHook,
	args: StatuslineArgs,
	shared: SharedArgs,
): Promise<string> {
	const ccCost = hook.cost?.total_cost_usd;
	let sessionCost: number | undefined;
	switch (args.costSource) {
		case 'cc':
			sessionCost = ccCost;
			break;
		case 'ccusage':
			sessionCost = await calculateSessionCost(hook.session_id, shared).catch(() => undefined);
			break;
		case 'auto':
			sessionCost = ccCost ?? await calculateSessionCost(hook.session_id, shared).catch(() => undefined);
			break;
		case 'both':
			sessionCost = undefined;
			break;
	}

	const ccusageCost = args.costSource === 'both'
		? await calculateSessionCost(hook.session_id, shared).catch(() => undefined)
		: undefined;
	const ccCostBoth = args.costSource === 'both' ? ccCost : undefined;

	const todayShared = statuslineTodayShared(args, shared, utcNow());
	// Rust sums via `f64::sum()`, whose empty/identity value is -0.0.
	let todayCost = -0;
	try {
		const entries = await loadEntries(todayShared, undefined);
		for (const entry of entries) {
			if (entry.date.replace(/-/g, '') === (todayShared.since ?? '')) {
				todayCost += entry.cost;
			}
		}
	}
	catch {
		todayCost = -0;
	}

	let blocks: ReturnType<typeof identifySessionBlocks> = [];
	try {
		blocks = identifySessionBlocks(await loadEntries(shared, undefined), DEFAULT_SESSION_DURATION_HOURS);
	}
	catch {
		blocks = [];
	}
	const activeBlock = blocks.find(block => block.isActive && !block.isGap);
	let blockInfo: string;
	let burnRateInfo = '';
	if (activeBlock != null) {
		const remaining = Math.trunc((activeBlock.endTime - utcNow()) / MILLIS_PER_MINUTE);
		const rate = calculateBurnRate(activeBlock);
		if (rate != null) {
			const segments = [`${formatCurrency(rate.costPerHour)}/hr`];
			const status: [string, string] = rate.tokensPerMinuteForIndicator < 2000
				? ['🟢', 'Normal']
				: rate.tokensPerMinuteForIndicator < 5000
					? ['⚠️', 'Moderate']
					: ['🚨', 'High'];
			if (args.visualBurnRate === 'emoji' || args.visualBurnRate === 'emoji-text') {
				segments.push(status[0]);
			}
			if (args.visualBurnRate === 'text' || args.visualBurnRate === 'emoji-text') {
				segments.push(`(${status[1]})`);
			}
			burnRateInfo = ` | 🔥 ${segments.join(' ')}`;
		}
		blockInfo = `${formatCurrency(activeBlock.costUsd)} block (${formatRemainingTime(remaining)})`;
	}
	else {
		blockInfo = 'No active block';
	}

	let contextPair: [number, number] | undefined;
	if (hook.context_window != null) {
		contextPair = [hook.context_window.total_input_tokens, hook.context_window.context_window_size];
	}
	else {
		const context = await calculateContextTokensFromTranscript(
			hook.transcript_path,
			hook.model.id,
			shared.offline,
			shared,
		);
		if (context != null) {
			contextPair = [context.total_input_tokens, context.context_window_size];
		}
	}
	const contextInfo = contextPair != null
		? formatStatuslineContext(contextPair[0], contextPair[1], args, shared)
		: undefined;

	const sessionDisplay = args.costSource === 'both'
		? `(${ccCostBoth != null ? formatCurrency(ccCostBoth) : 'N/A'} cc / ${ccusageCost != null ? formatCurrency(ccusageCost) : 'N/A'} ccusage)`
		: sessionCost != null ? formatCurrency(sessionCost) : 'N/A';

	const modelLabel = resolveModelLabel(args.modelLabelAliases, hook.model.display_name);

	return `🤖 ${modelLabel} | 💰 ${sessionDisplay} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnRateInfo} | 🧠 ${contextInfo ?? 'N/A'}`;
}

function nowMillis(): number {
	return Date.now();
}

function formatCacheDate(millis: number): string {
	return formatRfc3339Millis(millis);
}

function transcriptMtimeMs(path: string): number | undefined {
	try {
		return Math.trunc(statSync(path).mtimeMs);
	}
	catch {
		return undefined;
	}
}

function statuslineCachePath(sessionId: string): string {
	return join(tmpdir(), 'ccusage-semaphore', `${sessionId}.lock`);
}

function readStatuslineCache(path: string): StatuslineCache | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	}
	catch {
		return undefined;
	}
}

function writeStatuslineCache(path: string, cache: StatuslineCache): void {
	try {
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, JSON.stringify(cache));
	}
	catch {
		// best-effort
	}
}

function processIsAlive(pid: number): boolean {
	// Non-unix fallback mirrors the Rust `cfg(not(unix))` path.
	return pid === process.pid;
}

function cachedStatuslineOutput(
	cache: StatuslineCache,
	currentMtime: number,
	now: number,
	refreshInterval: number,
): string | undefined {
	if (cache.lastOutput.length === 0) {
		return undefined;
	}
	const expired = Math.max(0, now - cache.lastUpdateTime) >= refreshInterval * 1000;
	const fileModified = cache.transcriptMtime !== currentMtime;
	if (expired || fileModified) {
		if (cache.isUpdating && cache.pid != null && processIsAlive(cache.pid)) {
			return cache.lastOutput;
		}
		return undefined;
	}
	return cache.lastOutput;
}

function completedCache(
	hook: StatuslineHook,
	lastOutput: string,
	transcriptMtime: number,
	lastUpdateTime: number,
): StatuslineCache {
	return {
		date: formatCacheDate(lastUpdateTime),
		lastOutput,
		lastUpdateTime,
		transcriptPath: hook.transcript_path,
		transcriptMtime,
		isUpdating: false,
		pid: undefined,
	};
}

function updatingCache(
	hook: StatuslineHook,
	transcriptMtime: number,
	previous: StatuslineCache | undefined,
): StatuslineCache {
	const now = nowMillis();
	return {
		date: formatCacheDate(now),
		lastOutput: previous?.lastOutput ?? '',
		lastUpdateTime: previous?.lastUpdateTime ?? 0,
		transcriptPath: hook.transcript_path,
		transcriptMtime,
		isUpdating: true,
		pid: process.pid,
	};
}

function releaseStatuslineCache(path: string): void {
	const cache = readStatuslineCache(path);
	if (cache != null) {
		cache.isUpdating = false;
		cache.pid = undefined;
		writeStatuslineCache(path, cache);
	}
}

export async function runStatusline(args: StatuslineArgs): Promise<void> {
	if (args.contextLowThreshold >= args.contextMediumThreshold) {
		throw new CliError(
			`Context low threshold (${args.contextLowThreshold}) must be less than medium threshold (${args.contextMediumThreshold})`,
		);
	}

	const stdin = await Bun.stdin.text();
	if (stdin.trim().length === 0) {
		throw new CliError('❌ No input provided');
	}

	let hook: StatuslineHook;
	try {
		hook = JSON.parse(stdin.trim());
	}
	catch (error) {
		throw new CliError(`Invalid input format: ${error instanceof Error ? error.message : String(error)}`);
	}

	const shared: SharedArgs = {
		...defaultSharedArgs(),
		offline: args.offline && !args.noOffline,
		pricingOverrides: args.pricingOverrides,
	};
	const cacheEnabled = args.cache && !args.noCache;
	const cachePath = statuslineCachePath(hook.session_id);
	const currentMtime = transcriptMtimeMs(hook.transcript_path) ?? 0;
	const initialCache = cacheEnabled ? readStatuslineCache(cachePath) : undefined;

	if (initialCache != null) {
		const output = cachedStatuslineOutput(initialCache, currentMtime, nowMillis(), args.refreshInterval);
		if (output != null) {
			process.stdout.write(`${output}\n`);
			return;
		}
	}

	if (cacheEnabled) {
		writeStatuslineCache(cachePath, updatingCache(hook, currentMtime, initialCache));
	}

	let statusline: string;
	try {
		statusline = await renderStatusline(hook, args, shared);
	}
	catch (error) {
		if (initialCache != null && initialCache.lastOutput.length > 0) {
			process.stdout.write(`${initialCache.lastOutput}\n`);
		}
		else {
			process.stdout.write('❌ Error generating status\n');
		}
		if (cacheEnabled) {
			releaseStatuslineCache(cachePath);
		}
		throw new CliError(error instanceof Error ? error.message : String(error));
	}
	process.stdout.write(`${statusline}\n`);
	if (cacheEnabled) {
		writeStatuslineCache(cachePath, completedCache(hook, statusline, currentMtime, nowMillis()));
	}
}
