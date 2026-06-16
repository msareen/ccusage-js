/** Usage-table rendering, ported from the table half of `output.rs`. */
import process from 'node:process';
import type { SharedArgs } from './options.ts';
import type { ModelBreakdown, UsageSummary } from './types.ts';
import { summaryTotalTokens } from './types.ts';
import { formatProjectName, parseProjectAliases, shortModelName } from './project-names.ts';
import { totalsJson } from './output.ts';
import type { Align, Color, TerminalStyle } from '../terminal/table.ts';
import {
	SimpleTable,
	color,
	printBoxTitle,
	terminalWidth,
} from '../terminal/table.ts';

export const USAGE_COMPACT_WIDTH_THRESHOLD = 100;

function logLevel(): number | undefined {
	const raw = process.env.LOG_LEVEL;
	if (raw == null) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : undefined;
}

export function terminalStyle(shared: SharedArgs): TerminalStyle {
	return { color: shared.color, logLevel: logLevel(), noColor: shared.noColor };
}

export function shouldUseCompactLayout(
	shared: SharedArgs,
	isStdoutTty: boolean,
	width: number,
	compactWidthThreshold: number,
): boolean {
	return shared.compact || (isStdoutTty && width < compactWidthThreshold);
}

export function formatNumber(value: number): string {
	return Math.trunc(value).toLocaleString('en-US');
}

export function formatCurrency(value: number): string {
	// Rust `format!("${:.2}", v)` keeps the sign of negative zero (e.g. an empty
	// `f64::sum()` yields -0.0); JS `toFixed` drops it, so restore it here.
	if (Object.is(value, -0)) {
		return '$-0.00';
	}
	return `$${value.toFixed(2)}`;
}

export function formatModelsMultiline(models: string[]): string {
	const shortened = [...new Set(models.map(shortModelName))].sort();
	return shortened.map(model => `- ${model}`).join('\n');
}

function truncateRfc3339ToDate(value: string): string {
	return value.length >= 10 ? value.slice(0, 10) : value;
}

function rowLabel(row: UsageSummary): string {
	return row.date ?? row.month ?? row.week ?? row.sessionId ?? '';
}

export function missingPricingWarningsForModels(
	models: Iterable<string>,
	offline: boolean,
): string[] {
	const sorted = [...new Set(models)].sort();
	return sorted.map(model =>
		offline
			? `WARN  Missing embedded pricing for ${model}; cost excludes this model. Run without --offline or update ccusage after pricing is added.`
			: `WARN  Missing pricing for ${model}; cost excludes this model. Update pricing or run again after LiteLLM has the model.`,
	);
}

function missingPricingWarnings(rows: UsageSummary[], offline: boolean): string[] {
	const models: string[] = [];
	for (const row of rows) {
		for (const breakdown of row.modelBreakdowns) {
			if (breakdown.missingPricing) {
				models.push(breakdown.modelName);
			}
		}
	}
	return missingPricingWarningsForModels(models, offline);
}

function projectHeaderRow(columnCount: number, project: string, shared: SharedArgs): string[] {
	const row = Array.from({ length: columnCount }, () => '');
	if (row.length > 0) {
		row[0] = color(terminalStyle(shared), `Project: ${project}`, 'blue');
	}
	return row;
}

function pushBreakdownRows(
	table: SimpleTable,
	row: UsageSummary,
	compact: boolean,
	includeLastActivity: boolean,
	shared: SharedArgs,
): void {
	const style = terminalStyle(shared);
	const grey = (value: string): string => color(style, value, 'grey');
	for (const breakdown of row.modelBreakdowns) {
		const total
			= breakdown.inputTokens
			+ breakdown.outputTokens
			+ breakdown.cacheCreationTokens
			+ breakdown.cacheReadTokens;
		const values = compact
			? [
					grey(`  └─ ${shortModelName(breakdown.modelName)}`),
					'',
					grey(formatNumber(breakdown.inputTokens)),
					grey(formatNumber(breakdown.outputTokens)),
					grey(formatCurrency(breakdown.cost)),
				]
			: [
					grey(`  └─ ${shortModelName(breakdown.modelName)}`),
					'',
					grey(formatNumber(breakdown.inputTokens)),
					grey(formatNumber(breakdown.outputTokens)),
					grey(formatNumber(breakdown.cacheCreationTokens)),
					grey(formatNumber(breakdown.cacheReadTokens)),
					grey(formatNumber(total)),
					grey(formatCurrency(breakdown.cost)),
				];
		if (shared.noCost) {
			values.pop();
		}
		if (includeLastActivity) {
			values.push('');
		}
		table.push(values);
	}
}

export function printUsageTable(
	title: string,
	firstColumn: string,
	rows: UsageSummary[],
	shared: SharedArgs,
	groupProjects: boolean,
	projectAliases: string | undefined,
): void {
	if (rows.length === 0) {
		process.stderr.write('No usage data found.\n');
		return;
	}
	const width = terminalWidth();
	const isTty = process.stdout.isTTY === true;
	const compact = shouldUseCompactLayout(shared, isTty, width, USAGE_COMPACT_WIDTH_THRESHOLD);
	const includeLastActivity = rows.some(row => row.lastActivity != null);
	const style = terminalStyle(shared);
	printBoxTitle(title, style);

	let headers = compact
		? [firstColumn, 'Models', 'Input', 'Output', 'Cost (USD)']
		: [firstColumn, 'Models', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total Tokens', 'Cost (USD)'];
	let aligns: Align[] = compact
		? ['left', 'left', 'right', 'right', 'right']
		: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'];
	if (shared.noCost) {
		headers = headers.slice(0, -1);
		aligns = aligns.slice(0, -1);
	}
	if (includeLastActivity) {
		headers.push('Last Activity');
		aligns.push('left');
	}

	const table = new SimpleTable(headers, aligns, style)
		.withTerminalWidth(width)
		.withDateCompaction(true);
	const aliases = parseProjectAliases(projectAliases);
	let currentProject: string | undefined;
	for (const row of rows) {
		if (groupProjects && row.project != null) {
			if (currentProject !== row.project) {
				if (currentProject != null) {
					table.separator();
				}
				table.push(projectHeaderRow(
					table.columnCount(),
					formatProjectName(row.project, aliases),
					shared,
				));
				currentProject = row.project;
			}
		}
		const label = rowLabel(row);
		const models = formatModelsMultiline(row.modelsUsed);
		const totalTokens = summaryTotalTokens(row);
		const values = compact
			? [label, models, formatNumber(row.inputTokens), formatNumber(row.outputTokens), formatCurrency(row.totalCost)]
			: [
					label,
					models,
					formatNumber(row.inputTokens),
					formatNumber(row.outputTokens),
					formatNumber(row.cacheCreationTokens),
					formatNumber(row.cacheReadTokens),
					formatNumber(totalTokens),
					formatCurrency(row.totalCost),
				];
		if (shared.noCost) {
			values.pop();
		}
		if (includeLastActivity) {
			values.push(truncateRfc3339ToDate(row.lastActivity ?? ''));
		}
		table.push(values);
		if (shared.breakdown) {
			pushBreakdownRows(table, row, compact, includeLastActivity, shared);
		}
	}

	const totals = totalsJson(rows);
	const input = (totals.inputTokens as number) ?? 0;
	const output = (totals.outputTokens as number) ?? 0;
	const cacheCreate = (totals.cacheCreationTokens as number) ?? 0;
	const cacheRead = (totals.cacheReadTokens as number) ?? 0;
	const totalCost = (totals.totalCost as number) ?? 0;
	const totalTokens = (totals.totalTokens as number) ?? input + output + cacheCreate + cacheRead;
	table.separator();
	const yellow = (value: string): string => color(style, value, 'yellow');
	const totalRow = compact
		? [yellow('Total'), '', yellow(formatNumber(input)), yellow(formatNumber(output)), yellow(formatCurrency(totalCost))]
		: [
				yellow('Total'),
				'',
				yellow(formatNumber(input)),
				yellow(formatNumber(output)),
				yellow(formatNumber(cacheCreate)),
				yellow(formatNumber(cacheRead)),
				yellow(formatNumber(totalTokens)),
				yellow(formatCurrency(totalCost)),
			];
	if (shared.noCost) {
		totalRow.pop();
	}
	if (includeLastActivity) {
		totalRow.push('');
	}
	table.push(totalRow);
	table.print();

	for (const warning of missingPricingWarnings(rows, shared.offline)) {
		process.stderr.write(`${warning}\n`);
	}
	if (compact) {
		process.stderr.write('\nRunning in Compact Mode\n');
		process.stderr.write('Expand terminal width to see cache metrics and total tokens\n');
	}
}

export { color, type Color };
