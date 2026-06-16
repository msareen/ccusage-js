/** JSON output helpers ported from `rust/crates/ccusage/src/output.rs`. */
import { spawn } from 'node:child_process';
import process from 'node:process';
import type { ModelBreakdown, UsageSummary } from './types.ts';
import { summaryTotalTokens } from './types.ts';
import type { SharedArgs } from './options.ts';

export function wantsJson(shared: SharedArgs): boolean {
	return shared.json || shared.jq != null;
}

/** Mirrors serde serialization of `ModelBreakdown` (extra/missing fields skipped). */
function modelBreakdownJson(breakdown: ModelBreakdown): Record<string, unknown> {
	return {
		modelName: breakdown.modelName,
		inputTokens: breakdown.inputTokens,
		outputTokens: breakdown.outputTokens,
		cacheCreationTokens: breakdown.cacheCreationTokens,
		cacheReadTokens: breakdown.cacheReadTokens,
		cost: breakdown.cost,
	};
}

export function summaryJson(row: UsageSummary): Record<string, unknown> {
	const value: Record<string, unknown> = {
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		cacheReadTokens: row.cacheReadTokens,
		totalTokens: summaryTotalTokens(row),
		totalCost: row.totalCost,
		modelsUsed: row.modelsUsed,
		modelBreakdowns: row.modelBreakdowns.map(modelBreakdownJson),
	};
	if (row.date != null) {
		value.date = row.date;
	}
	if (row.month != null) {
		value.month = row.month;
	}
	if (row.week != null) {
		value.week = row.week;
	}
	if (row.project != null) {
		value.project = row.project;
	}
	if (row.credits != null) {
		value.credits = row.credits;
	}
	return value;
}

export function sessionSummaryJson(row: UsageSummary): Record<string, unknown> {
	const value: Record<string, unknown> = {
		sessionId: row.sessionId ?? null,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		cacheReadTokens: row.cacheReadTokens,
		totalTokens: summaryTotalTokens(row),
		totalCost: row.totalCost,
		lastActivity: row.lastActivity ?? null,
		firstActivity: row.firstActivity ?? null,
		modelsUsed: row.modelsUsed,
		modelBreakdowns: row.modelBreakdowns.map(modelBreakdownJson),
		projectPath: row.projectPath ?? null,
	};
	if (row.credits != null) {
		value.credits = row.credits;
	}
	return value;
}

export function totalsJson(rows: UsageSummary[]): Record<string, unknown> {
	let input = 0;
	let output = 0;
	let cacheCreate = 0;
	let cacheRead = 0;
	let extra = 0;
	let totalCost = 0;
	let credits = 0;
	for (const row of rows) {
		input += row.inputTokens;
		output += row.outputTokens;
		cacheCreate += row.cacheCreationTokens;
		cacheRead += row.cacheReadTokens;
		extra += row.extraTotalTokens;
		totalCost += row.totalCost;
		if (row.credits != null) {
			credits += row.credits;
		}
	}
	const value: Record<string, unknown> = {
		inputTokens: input,
		outputTokens: output,
		cacheCreationTokens: cacheCreate,
		cacheReadTokens: cacheRead,
		totalTokens: input + output + cacheCreate + cacheRead + extra,
		totalCost,
	};
	if (credits > 0) {
		value.credits = credits;
	}
	return value;
}

export function groupProjectOutput(rows: UsageSummary[]): Record<string, unknown> {
	const projects = new Map<string, Record<string, unknown>[]>();
	for (const row of rows) {
		const key = row.project ?? 'unknown';
		let list = projects.get(key);
		if (list == null) {
			list = [];
			projects.set(key, list);
		}
		list.push(summaryJson(row));
	}
	const out: Record<string, unknown> = {};
	for (const key of [...projects.keys()].sort()) {
		out[key] = projects.get(key)!;
	}
	return out;
}

export function stripCostJson(value: unknown): void {
	if (Array.isArray(value)) {
		for (const child of value) {
			stripCostJson(child);
		}
	}
	else if (value != null && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		delete obj.totalCost;
		delete obj.costUSD;
		delete obj.cost;
		for (const child of Object.values(obj)) {
			stripCostJson(child);
		}
	}
}

export async function printJsonOrJq(
	value: unknown,
	jq: string | undefined,
	noCost: boolean,
): Promise<void> {
	if (noCost) {
		stripCostJson(value);
	}
	if (jq != null) {
		await pipeToJq(value, jq);
		return;
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function pipeToJq(value: unknown, filter: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('jq', [filter], { stdio: ['pipe', 'inherit', 'inherit'] });
		child.on('error', error => reject(new Error(`failed to run jq: ${error.message}`)));
		child.on('exit', (status) => {
			if (status === 0) {
				resolve();
			}
			else {
				reject(new Error('jq failed'));
			}
		});
		child.stdin.write(`${JSON.stringify(value)}\n`);
		child.stdin.end();
	});
}

export function formatNumber(value: number): string {
	return Math.trunc(value).toLocaleString('en-US');
}

export function formatCurrency(value: number): string {
	// Match Rust `{:.2}` formatting of negative zero (empty `f64::sum()` is -0.0).
	if (Object.is(value, -0)) {
		return '$-0.00';
	}
	return `$${value.toFixed(2)}`;
}
