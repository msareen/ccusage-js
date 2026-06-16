/**
 * 5-hour billing blocks, ported from `rust/crates/ccusage/src/blocks.rs`
 * and the `run_blocks` runner in `commands/mod.rs`.
 */
import process from 'node:process';
import type { LoadedEntry, TokenCounts } from '../core/types.ts';
import { addUsage, newTokenCounts, tokenCountsTotal } from '../core/types.ts';
import type { SharedArgs, SortOrder } from '../core/options.ts';
import {
	MILLIS_PER_DAY,
	MILLIS_PER_HOUR,
	MILLIS_PER_MINUTE,
	amPm,
	floorToHour,
	formatDateTz,
	formatRfc3339Millis,
	formatUtcSecond,
	hour12,
	localParts,
	utcNow,
} from '../core/date.ts';
import { printJsonOrJq, wantsJson } from '../core/output.ts';
import {
	formatCurrency,
	formatModelsMultiline,
	formatNumber,
	shouldUseCompactLayout,
	terminalStyle,
} from '../core/table-output.ts';
import type { Align, Color } from '../terminal/table.ts';
import { SimpleTable, color, printBoxTitle, terminalWidth } from '../terminal/table.ts';
import { loadEntries } from '../adapter/claude/loader.ts';
import { CliError } from '../cli/errors.ts';

const DEFAULT_RECENT_DAYS = 3;
const BLOCKS_WARNING_THRESHOLD = 0.8;
const BLOCKS_COMPACT_WIDTH_THRESHOLD = 120;

export type SessionBlock = {
	id: string;
	startTime: number;
	endTime: number;
	actualEndTime?: number;
	isActive: boolean;
	isGap: boolean;
	entries: LoadedEntry[];
	tokenCounts: TokenCounts;
	costUsd: number;
	models: string[];
	usageLimitResetTime?: number;
};

export type BurnRate = {
	tokensPerMinute: number;
	tokensPerMinuteForIndicator: number;
	costPerHour: number;
};

export type Projection = {
	totalTokens: number;
	totalCost: number;
	remainingMinutes: number;
};

export function identifySessionBlocks(
	entries: LoadedEntry[],
	sessionDurationHours: number,
): SessionBlock[] {
	if (entries.length === 0) {
		return [];
	}
	const sessionDuration = Math.trunc(sessionDurationHours * MILLIS_PER_HOUR);
	const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
	const now = utcNow();
	const blocks: SessionBlock[] = [];
	let currentStart: number | undefined;
	let currentEntries: LoadedEntry[] = [];

	for (const entry of sorted) {
		if (currentStart != null) {
			const lastTime = currentEntries.length > 0
				? currentEntries[currentEntries.length - 1]!.timestamp
				: currentStart;
			const sinceStart = entry.timestamp - currentStart;
			const sinceLast = entry.timestamp - lastTime;
			if (sinceStart > sessionDuration || sinceLast > sessionDuration) {
				blocks.push(createBlock(currentStart, currentEntries, now, sessionDuration));
				currentEntries = [];
				if (sinceLast > sessionDuration) {
					blocks.push(createGapBlock(lastTime, entry.timestamp, sessionDuration));
				}
				currentStart = floorToHour(entry.timestamp);
			}
		}
		else {
			currentStart = floorToHour(entry.timestamp);
		}
		currentEntries.push(entry);
	}

	if (currentStart != null && currentEntries.length > 0) {
		blocks.push(createBlock(currentStart, currentEntries, now, sessionDuration));
	}
	return blocks;
}

function createBlock(
	start: number,
	entries: LoadedEntry[],
	now: number,
	duration: number,
): SessionBlock {
	const end = start + duration;
	const actualEnd = entries.length > 0 ? entries[entries.length - 1]!.timestamp : undefined;
	const isActive = actualEnd != null && now - actualEnd < duration && now < end;
	const tokenCounts = newTokenCounts();
	let cost = 0;
	const models: string[] = [];
	const seenModels = new Set<string>();
	let usageLimitResetTime: number | undefined;
	for (const entry of entries) {
		addUsage(tokenCounts, entry.data.message.usage);
		cost += entry.cost;
		if (entry.model != null && !seenModels.has(entry.model)) {
			seenModels.add(entry.model);
			models.push(entry.model);
		}
		if (usageLimitResetTime == null) {
			usageLimitResetTime = entry.usageLimitResetTime;
		}
	}
	return {
		id: formatRfc3339Millis(start),
		startTime: start,
		endTime: end,
		actualEndTime: actualEnd,
		isActive,
		isGap: false,
		entries,
		tokenCounts,
		costUsd: cost,
		models,
		usageLimitResetTime,
	};
}

function createGapBlock(last: number, next: number, duration: number): SessionBlock {
	const start = last + duration;
	return {
		id: `gap-${formatRfc3339Millis(start)}`,
		startTime: start,
		endTime: next,
		actualEndTime: undefined,
		isActive: false,
		isGap: true,
		entries: [],
		tokenCounts: newTokenCounts(),
		costUsd: 0,
		models: [],
		usageLimitResetTime: undefined,
	};
}

export function filterBlocksByDate(blocks: SessionBlock[], shared: SharedArgs): SessionBlock[] {
	if (shared.since == null && shared.until == null) {
		return blocks;
	}
	return blocks.filter((block) => {
		const date = formatDateTz(block.startTime, shared.timezone).replace(/-/g, '');
		return (
			(shared.since == null || date >= shared.since)
			&& (shared.until == null || date <= shared.until)
		);
	});
}

export function sortBlocks(blocks: SessionBlock[], order: SortOrder): void {
	blocks.sort((a, b) => a.startTime - b.startTime);
	if (order === 'desc') {
		blocks.reverse();
	}
}

export function calculateBurnRate(block: SessionBlock): BurnRate | undefined {
	if (block.entries.length === 0 || block.isGap) {
		return undefined;
	}
	const first = block.entries[0]!.timestamp;
	const last = block.entries[block.entries.length - 1]!.timestamp;
	const durationMinutes = (last - first) / MILLIS_PER_MINUTE;
	if (durationMinutes <= 0) {
		return undefined;
	}
	const totalTokens = tokenCountsTotal(block.tokenCounts);
	const nonCache = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
	return {
		tokensPerMinute: totalTokens / durationMinutes,
		tokensPerMinuteForIndicator: nonCache / durationMinutes,
		costPerHour: (block.costUsd / durationMinutes) * 60,
	};
}

function projectBlockUsage(block: SessionBlock): Projection | undefined {
	if (!block.isActive || block.isGap) {
		return undefined;
	}
	const burn = calculateBurnRate(block);
	if (burn == null) {
		return undefined;
	}
	const remainingMinutes = Math.round((block.endTime - utcNow()) / MILLIS_PER_MINUTE);
	const totalTokens = tokenCountsTotal(block.tokenCounts) + burn.tokensPerMinute * remainingMinutes;
	const totalCost = block.costUsd + (burn.costPerHour / 60) * remainingMinutes;
	return {
		totalTokens: Math.round(totalTokens),
		totalCost: Math.round(totalCost * 100) / 100,
		remainingMinutes,
	};
}

function parseTokenLimit(value: string | undefined, maxTokens: number): number | undefined {
	if (value == null || value === '' || value === 'max') {
		return maxTokens > 0 ? maxTokens : undefined;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function blockJson(
	block: SessionBlock,
	tokenLimit: string | undefined,
	maxTokens: number,
): Record<string, unknown> {
	const burnRate = block.isActive ? calculateBurnRate(block) : undefined;
	const projection = block.isActive ? projectBlockUsage(block) : undefined;

	let tokenLimitStatus: Record<string, unknown> | undefined;
	if (projection != null) {
		const limit = tokenLimit != null ? parseTokenLimit(tokenLimit, maxTokens) : undefined;
		if (limit != null) {
			const percent = (projection.totalTokens / limit) * 100;
			tokenLimitStatus = {
				limit,
				projectedUsage: projection.totalTokens,
				percentUsed: percent,
				status:
					projection.totalTokens > limit
						? 'exceeds'
						: projection.totalTokens > limit * BLOCKS_WARNING_THRESHOLD
							? 'warning'
							: 'ok',
			};
		}
	}

	const value: Record<string, unknown> = {
		id: block.id,
		startTime: formatRfc3339Millis(block.startTime),
		endTime: formatRfc3339Millis(block.endTime),
		actualEndTime: block.actualEndTime != null ? formatRfc3339Millis(block.actualEndTime) : null,
		isActive: block.isActive,
		isGap: block.isGap,
		entries: block.entries.length,
		tokenCounts: {
			inputTokens: block.tokenCounts.inputTokens,
			outputTokens: block.tokenCounts.outputTokens,
			cacheCreationInputTokens: block.tokenCounts.cacheCreationTokens,
			cacheReadInputTokens: block.tokenCounts.cacheReadTokens,
		},
		totalTokens: tokenCountsTotal(block.tokenCounts),
		costUSD: block.costUsd,
		models: block.models,
		burnRate: burnRate ?? null,
		projection: projection ?? null,
	};
	if (tokenLimitStatus != null) {
		value.tokenLimitStatus = tokenLimitStatus;
	}
	if (block.usageLimitResetTime != null) {
		value.usageLimitResetTime = formatRfc3339Millis(block.usageLimitResetTime);
	}
	return value;
}

function formatBlockModels(models: string[]): string {
	return models.length === 0 ? '-' : formatModelsMultiline(models);
}

function formatLocalBlockStart(timestamp: number, compact: boolean): string {
	const p = localParts(timestamp);
	const pad = (n: number): string => String(n).padStart(2, '0');
	if (compact) {
		return `${pad(p.month)}/${pad(p.day)}, ${pad(hour12(p.hour))}:${pad(p.minute)} ${amPm(p.hour)}`;
	}
	return `${p.month}/${p.day}/${p.year}, ${hour12(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${amPm(p.hour)}`;
}

function formatLocalBlockEnd(timestamp: number, compact: boolean): string {
	if (!compact) {
		return formatLocalBlockStart(timestamp, false);
	}
	const p = localParts(timestamp);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(hour12(p.hour))}:${pad(p.minute)} ${amPm(p.hour)}`;
}

function formatBlockTime(block: SessionBlock, compact: boolean): string {
	const start = formatLocalBlockStart(block.startTime, compact);
	if (block.isGap) {
		const end = formatLocalBlockEnd(block.endTime, compact);
		const duration = Math.trunc((block.endTime - block.startTime) / MILLIS_PER_HOUR);
		return compact
			? `${start}-${end}\n(${duration}h gap)`
			: `${start} - ${end} (${duration}h gap)`;
	}

	if (block.isActive) {
		const now = utcNow();
		const elapsed = Math.trunc((now - block.startTime) / MILLIS_PER_MINUTE);
		const remaining = Math.trunc((block.endTime - now) / MILLIS_PER_MINUTE);
		const elapsedHours = Math.trunc(elapsed / 60);
		const elapsedMinutes = remEuclid(elapsed, 60);
		const remainingHours = Math.trunc(remaining / 60);
		const remainingMinutes = remEuclid(remaining, 60);
		return compact
			? `${start}\n(${elapsedHours}h${elapsedMinutes}m/${remainingHours}h${remainingMinutes}m)`
			: `${start} (${elapsedHours}h ${elapsedMinutes}m elapsed, ${remainingHours}h ${remainingMinutes}m remaining)`;
	}

	const duration = block.actualEndTime != null
		? Math.trunc((block.actualEndTime - block.startTime) / MILLIS_PER_MINUTE)
		: 0;
	const hours = Math.trunc(duration / 60);
	const minutes = remEuclid(duration, 60);
	if (compact) {
		return hours > 0 ? `${start}\n(${hours}h${minutes}m)` : `${start}\n(${minutes}m)`;
	}
	return hours > 0 ? `${start} (${hours}h ${minutes}m)` : `${start} (${minutes}m)`;
}

function remEuclid(a: number, b: number): number {
	return ((a % b) + b) % b;
}

/** Mirrors `format_remaining_time`: truncating div + signed remainder. */
export function formatRemainingTime(minutes: number): string {
	const hours = Math.trunc(minutes / 60);
	const mins = minutes % 60;
	return hours > 0 ? `${hours}h ${mins}m left` : `${mins}m left`;
}

function printBlocksTable(
	blocks: SessionBlock[],
	tokenLimit: string | undefined,
	maxTokens: number,
	shared: SharedArgs,
): void {
	if (blocks.length === 0) {
		process.stderr.write('No Claude usage data found.\n');
		return;
	}
	const width = terminalWidth();
	const isTty = process.stdout.isTTY === true;
	const compact = shouldUseCompactLayout(shared, isTty, width, BLOCKS_COMPACT_WIDTH_THRESHOLD);
	const actualLimit = parseTokenLimit(tokenLimit, maxTokens);
	const hasLimit = actualLimit != null && actualLimit > 0;
	const style = terminalStyle(shared);
	const c = (value: string, col: Color): string => color(style, value, col);
	printBoxTitle('Claude Code Token Usage Report - Session Blocks', style);

	const headers = ['Block Start', 'Duration/Status', 'Models', 'Tokens'];
	const aligns: Align[] = ['left', 'left', 'left', 'right'];
	if (hasLimit) {
		headers.push('%');
		aligns.push('right');
	}
	headers.push('Cost');
	aligns.push('right');
	if (shared.noCost) {
		headers.pop();
		aligns.pop();
	}

	const table = new SimpleTable(headers, aligns, style).withTerminalWidth(width);
	for (const block of blocks) {
		if (block.isGap) {
			const row = [
				c(formatBlockTime(block, compact), 'grey'),
				c('(inactive)', 'grey'),
				c('-', 'grey'),
				c('-', 'grey'),
			];
			if (hasLimit) {
				row.push(c('-', 'grey'));
			}
			if (!shared.noCost) {
				row.push(c('-', 'grey'));
			}
			table.push(row);
			continue;
		}
		const total = tokenCountsTotal(block.tokenCounts);
		const row = [
			formatBlockTime(block, compact),
			block.isActive ? c('ACTIVE', 'green') : '',
			formatBlockModels(block.models),
			formatNumber(total),
		];
		if (hasLimit) {
			const percentage = (total / actualLimit!) * 100;
			const percentText = `${percentage.toFixed(1)}%`;
			row.push(percentage > 100 ? c(percentText, 'red') : percentText);
		}
		if (!shared.noCost) {
			row.push(formatCurrency(block.costUsd));
		}
		table.push(row);

		if (block.isActive) {
			if (hasLimit) {
				table.separator();
				const remaining = Math.max(0, actualLimit! - total);
				const remainingPercent = (Math.max(0, actualLimit! - total) / actualLimit!) * 100;
				const remainingRow = [
					c(`(assuming ${formatNumber(actualLimit!)} token limit)`, 'grey'),
					c('REMAINING', 'blue'),
					'',
					remaining > 0 ? formatNumber(remaining) : c('0', 'red'),
				];
				remainingRow.push(remainingPercent > 0 ? `${remainingPercent.toFixed(1)}%` : c('0.0%', 'red'));
				if (!shared.noCost) {
					remainingRow.push('');
				}
				table.push(remainingRow);
			}

			const projection = projectBlockUsage(block);
			if (projection != null) {
				table.separator();
				const projectedRow = [
					c('(assuming current burn rate)', 'grey'),
					c('PROJECTED', 'yellow'),
					'',
					hasLimit && projection.totalTokens > actualLimit!
						? c(formatNumber(projection.totalTokens), 'red')
						: formatNumber(projection.totalTokens),
				];
				if (hasLimit) {
					const percentage = (projection.totalTokens / actualLimit!) * 100;
					projectedRow.push(`${percentage.toFixed(1)}%`);
				}
				if (!shared.noCost) {
					projectedRow.push(formatCurrency(projection.totalCost));
				}
				table.push(projectedRow);
			}
		}
	}
	table.print();
}

function printActiveBlockDetail(
	block: SessionBlock,
	tokenLimit: string | undefined,
	maxTokens: number,
	shared: SharedArgs,
): void {
	const style = terminalStyle(shared);
	const c = (value: string, col: Color): string => color(style, value, col);
	printBoxTitle('Current Session Block Status', style);
	const now = utcNow();
	const elapsed = Math.trunc((now - block.startTime) / MILLIS_PER_MINUTE);
	const remaining = Math.trunc((block.endTime - now) / MILLIS_PER_MINUTE);
	const out = process.stdout;
	out.write(`Block Started:   ${formatUtcSecond(block.startTime)}\n`);
	out.write(`Time Elapsed:    ${Math.trunc(elapsed / 60)}h ${remEuclid(elapsed, 60)}m\n`);
	out.write(`Time Remaining:  ${c(`${Math.trunc(remaining / 60)}h ${remEuclid(remaining, 60)}m`, 'green')}\n`);
	out.write('\n');
	out.write(`${c('Current Usage:', 'blue')}\n`);
	out.write(`  Input Tokens:     ${formatNumber(block.tokenCounts.inputTokens)}\n`);
	out.write(`  Output Tokens:    ${formatNumber(block.tokenCounts.outputTokens)}\n`);
	if (!shared.noCost) {
		out.write(`  Total Cost:       ${formatCurrency(block.costUsd)}\n`);
	}

	const rate = calculateBurnRate(block);
	if (rate != null) {
		out.write('\n');
		out.write(`${c('Burn Rate:', 'blue')}\n`);
		out.write(`  Tokens/minute:    ${formatNumber(Math.round(rate.tokensPerMinute))}\n`);
		if (!shared.noCost) {
			out.write(`  Cost/hour:        ${formatCurrency(rate.costPerHour)}\n`);
		}
	}

	const projection = projectBlockUsage(block);
	if (projection != null) {
		out.write('\n');
		out.write(`${c('Projected Usage (if current rate continues):', 'blue')}\n`);
		out.write(`  Total Tokens:     ${formatNumber(projection.totalTokens)}\n`);
		if (!shared.noCost) {
			out.write(`  Total Cost:       ${formatCurrency(projection.totalCost)}\n`);
		}

		const limit = parseTokenLimit(tokenLimit, maxTokens);
		if (limit != null) {
			const current = tokenCountsTotal(block.tokenCounts);
			const remainingTokens = Math.max(0, limit - current);
			const percent = (projection.totalTokens / limit) * 100;
			const status
				= projection.totalTokens > limit
					? c('EXCEEDS LIMIT', 'red')
					: projection.totalTokens > limit * BLOCKS_WARNING_THRESHOLD
						? c('WARNING', 'yellow')
						: c('OK', 'green');
			out.write('\n');
			out.write(`${c('Token Limit Status:', 'blue')}\n`);
			out.write(`  Limit:            ${formatNumber(limit)} tokens\n`);
			out.write(`  Current Usage:    ${formatNumber(current)} (${((current / limit) * 100).toFixed(1)}%)\n`);
			out.write(`  Remaining:        ${formatNumber(remainingTokens)} tokens\n`);
			out.write(`  Projected Usage:  ${percent.toFixed(1)}% ${status}\n`);
		}
	}
}

export type BlocksArgs = {
	shared: SharedArgs;
	active: boolean;
	recent: boolean;
	tokenLimit?: string;
	sessionLength: number;
};

export async function runBlocks(args: BlocksArgs): Promise<void> {
	if (args.sessionLength <= 0) {
		throw new CliError('Session length must be a positive number');
	}
	const shared = args.shared;
	const entries = await loadEntries(shared, undefined);
	let blocks = identifySessionBlocks(entries, args.sessionLength);
	blocks = filterBlocksByDate(blocks, shared);
	sortBlocks(blocks, shared.order);

	if (args.recent) {
		const cutoff = Math.max(0, utcNow() - DEFAULT_RECENT_DAYS * MILLIS_PER_DAY);
		blocks = blocks.filter(block => block.startTime >= cutoff || block.isActive);
	}

	if (args.active) {
		blocks = blocks.filter(block => block.isActive);
	}

	let maxTokens = 0;
	for (const block of blocks) {
		if (!block.isGap && !block.isActive) {
			maxTokens = Math.max(maxTokens, tokenCountsTotal(block.tokenCounts));
		}
	}

	if (wantsJson(shared)) {
		const output = {
			blocks: blocks.map(block => blockJson(block, args.tokenLimit, maxTokens)),
		};
		await printJsonOrJq(output, shared.jq, shared.noCost);
		return;
	}

	if (args.active && blocks.length === 0) {
		process.stdout.write('No active session block found.\n');
		return;
	}
	if (args.active && blocks.length === 1) {
		printActiveBlockDetail(blocks[0]!, args.tokenLimit, maxTokens, shared);
		return;
	}
	printBlocksTable(blocks, args.tokenLimit, maxTokens, shared);
}
