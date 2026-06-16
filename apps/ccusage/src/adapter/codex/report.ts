/** Codex JSON + table report builder, ported from `adapter/codex/report.rs`. */
import process from 'node:process';
import type { PricingMap } from '../../core/pricing.ts';
import { missingPricingModelForTokenTotal } from '../../core/cost.ts';
import type { SharedArgs } from '../../core/options.ts';
import {
	formatCurrency,
	formatModelsMultiline,
	formatNumber,
	missingPricingWarningsForModels,
	terminalStyle,
} from '../../core/table-output.ts';
import type { Align } from '../../terminal/table.ts';
import { SimpleTable, color, printBoxTitle, terminalWidth } from '../../terminal/table.ts';
import type { CodexGroup, CodexModelUsage } from './types.ts';
import type { CodexReportKind } from './aggregate.ts';
import type { CodexSpeed } from './speed.ts';

function rowsKey(kind: CodexReportKind): string {
	return kind === 'session' ? 'sessions' : kind;
}

function periodKey(kind: CodexReportKind): string {
	switch (kind) {
		case 'daily':
			return 'date';
		case 'weekly':
			return 'week';
		case 'monthly':
			return 'month';
		case 'session':
			return 'sessionId';
	}
}

export function nonCachedInputTokens(inputTokens: number, cachedInputTokens: number): number {
	return Math.max(0, inputTokens - cachedInputTokens);
}

export function reportFromGroups(
	groups: Map<string, CodexGroup>,
	kind: CodexReportKind,
	pricing: PricingMap,
	speed: CodexSpeed,
): Record<string, unknown> {
	const periods = [...groups.keys()].sort();
	const rows = periods.map(period => groupJson(period, groups.get(period)!, kind, pricing, speed));
	return {
		[rowsKey(kind)]: rows,
		totals: totalsJson(groups, pricing, speed),
	};
}

function groupJson(
	period: string,
	group: CodexGroup,
	kind: CodexReportKind,
	pricing: PricingMap,
	speed: CodexSpeed,
): Record<string, unknown> {
	const cost = calculateGroupCost(group, pricing, speed);
	const models: Record<string, unknown> = {};
	for (const model of [...group.models.keys()].sort()) {
		models[model] = modelUsageJson(group.models.get(model)!);
	}
	const row: Record<string, unknown> = {
		[periodKey(kind)]: period,
		inputTokens: nonCachedInputTokens(group.inputTokens, group.cachedInputTokens),
		cacheCreationTokens: 0,
		cacheReadTokens: group.cachedInputTokens,
		outputTokens: group.outputTokens,
		reasoningOutputTokens: group.reasoningOutputTokens,
		totalTokens: group.totalTokens,
		costUSD: cost,
		models,
	};
	if (kind === 'session') {
		row.lastActivity = group.lastActivity ?? null;
		const separator = period.lastIndexOf('/');
		row.sessionFile = separator < 0 ? period : period.slice(separator + 1);
		row.directory = separator < 0 ? '' : period.slice(0, separator);
	}
	return row;
}

function modelUsageJson(usage: CodexModelUsage): Record<string, unknown> {
	return {
		inputTokens: nonCachedInputTokens(usage.inputTokens, usage.cachedInputTokens),
		cacheCreationTokens: 0,
		cacheReadTokens: usage.cachedInputTokens,
		outputTokens: usage.outputTokens,
		reasoningOutputTokens: usage.reasoningOutputTokens,
		totalTokens: usage.totalTokens,
		isFallback: usage.isFallback,
	};
}

function totalsJson(
	groups: Map<string, CodexGroup>,
	pricing: PricingMap,
	speed: CodexSpeed,
): Record<string, unknown> {
	let input = 0;
	let cached = 0;
	let output = 0;
	let reasoning = 0;
	let total = 0;
	let cost = 0;
	for (const group of groups.values()) {
		input += nonCachedInputTokens(group.inputTokens, group.cachedInputTokens);
		cached += group.cachedInputTokens;
		output += group.outputTokens;
		reasoning += group.reasoningOutputTokens;
		total += group.totalTokens;
		cost += calculateGroupCost(group, pricing, speed);
	}
	return {
		inputTokens: input,
		cacheCreationTokens: 0,
		cacheReadTokens: cached,
		outputTokens: output,
		reasoningOutputTokens: reasoning,
		totalTokens: total,
		costUSD: cost,
	};
}

export function calculateCodexModelCost(
	model: string,
	usage: CodexModelUsage,
	pricing: PricingMap,
	speed: CodexSpeed,
): number {
	const entry = pricing.find(model);
	if (entry == null) {
		return 0;
	}
	const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
	const multiplier
		= speed === 'fast' ? (entry.fastMultiplier === 1.0 ? 2.0 : entry.fastMultiplier) : 1.0;
	const cacheRead = entry.cacheReadExplicit ? entry.cacheRead : entry.input;
	return (
		(nonCachedInput * entry.input
			+ usage.cachedInputTokens * cacheRead
			+ usage.outputTokens * entry.output)
		* multiplier
	);
}

export function calculateGroupCost(
	group: CodexGroup,
	pricing: PricingMap,
	speed: CodexSpeed,
): number {
	let cost = 0;
	for (const [model, usage] of group.models) {
		cost += calculateCodexModelCost(model, usage, pricing, speed);
	}
	return cost;
}

export function codexModelMissingPricing(
	model: string,
	usage: CodexModelUsage,
	pricing: PricingMap,
): boolean {
	const total = Math.max(usage.totalTokens, usage.inputTokens + usage.outputTokens);
	return missingPricingModelForTokenTotal(model, total, pricing) != null;
}

export function codexMissingPricingModels(
	groups: Map<string, CodexGroup>,
	pricing: PricingMap,
): string[] {
	const models = new Set<string>();
	for (const group of groups.values()) {
		for (const [model, usage] of group.models) {
			if (codexModelMissingPricing(model, usage, pricing)) {
				models.add(model);
			}
		}
	}
	return [...models].sort();
}

function firstColumnLabel(kind: CodexReportKind): string {
	switch (kind) {
		case 'daily':
			return 'Date';
		case 'weekly':
			return 'Week';
		case 'monthly':
			return 'Month';
		case 'session':
			return 'Session';
	}
}

function reportLabel(kind: CodexReportKind): string {
	switch (kind) {
		case 'daily':
			return 'Daily';
		case 'weekly':
			return 'Weekly';
		case 'monthly':
			return 'Monthly';
		case 'session':
			return 'Session';
	}
}

/** Mirrors `print_table_from_groups`. */
export function printTableFromGroups(
	groups: Map<string, CodexGroup>,
	kind: CodexReportKind,
	pricing: PricingMap,
	speed: CodexSpeed,
	shared: SharedArgs,
): void {
	if (groups.size === 0) {
		process.stderr.write('No Codex usage data found.\n');
		return;
	}
	const style = terminalStyle(shared);
	printBoxTitle(`Codex Token Usage Report - ${reportLabel(kind)}`, style);

	let headers = [
		firstColumnLabel(kind),
		'Models',
		'Input',
		'Output',
		'Reasoning',
		'Cache Read',
		'Total Tokens',
		'Cost (USD)',
	];
	let aligns: Align[] = ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'];
	if (shared.noCost) {
		headers = headers.slice(0, -1);
		aligns = aligns.slice(0, -1);
	}
	const table = new SimpleTable(headers, aligns, style)
		.withTerminalWidth(terminalWidth())
		.withDateCompaction(true);

	let totalInput = 0;
	let totalCached = 0;
	let totalOutput = 0;
	let totalReasoning = 0;
	let totalTokens = 0;
	let totalCost = 0;
	for (const label of [...groups.keys()].sort()) {
		const group = groups.get(label)!;
		const input = nonCachedInputTokens(group.inputTokens, group.cachedInputTokens);
		const cost = calculateGroupCost(group, pricing, speed);
		totalInput += input;
		totalCached += group.cachedInputTokens;
		totalOutput += group.outputTokens;
		totalReasoning += group.reasoningOutputTokens;
		totalTokens += group.totalTokens;
		totalCost += cost;
		const models = formatModelsMultiline([...group.models.keys()]);
		const row = [
			label,
			models,
			formatNumber(input),
			formatNumber(group.outputTokens),
			formatNumber(group.reasoningOutputTokens),
			formatNumber(group.cachedInputTokens),
			formatNumber(group.totalTokens),
			formatCurrency(cost),
		];
		if (shared.noCost) {
			row.pop();
		}
		table.push(row);
	}
	table.separator();
	const yellow = (value: string): string => color(style, value, 'yellow');
	const totalRow = [
		yellow('Total'),
		'',
		yellow(formatNumber(totalInput)),
		yellow(formatNumber(totalOutput)),
		yellow(formatNumber(totalReasoning)),
		yellow(formatNumber(totalCached)),
		yellow(formatNumber(totalTokens)),
		yellow(formatCurrency(totalCost)),
	];
	if (shared.noCost) {
		totalRow.pop();
	}
	table.push(totalRow);
	table.print();

	for (const warning of missingPricingWarningsForModels(
		codexMissingPricingModels(groups, pricing),
		shared.offline,
	)) {
		process.stderr.write(`${warning}\n`);
	}
}
