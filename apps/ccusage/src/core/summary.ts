/** Aggregation ported from `rust/crates/ccusage/src/summary.rs`. */
import type { BucketKind, SharedArgs, SortOrder, WeekDay } from './options.ts';
import type { LoadedEntry, ModelBreakdown, UsageSummary } from './types.ts';
import {
	addUsage,
	cacheCreationTokenCount,
	newModelBreakdown,
	newTokenCounts,
	newUsageSummary,
} from './types.ts';
import { checkedAddDays, formatNaiveDate, formatRfc3339Millis, parseIsoDate, weekdayFromSunday } from './date.ts';

class UsageAccumulator {
	private counts = newTokenCounts();
	private cost = 0;
	private credits: number | undefined;
	private messageCount: number | undefined;
	private models: string[] = [];
	private breakdowns: ModelBreakdown[] = [];
	private breakdownIndexes = new Map<string, number>();

	addEntry(entry: LoadedEntry): void {
		const usage = entry.data.message.usage;
		addUsage(this.counts, usage);
		this.counts.extraTotalTokens += entry.extraTotalTokens;
		this.cost += entry.cost;
		if (entry.credits != null) {
			this.credits = (this.credits ?? 0) + entry.credits;
		}
		if (entry.messageCount != null) {
			this.messageCount = (this.messageCount ?? 0) + entry.messageCount;
		}
		const model = entry.model;
		if (model != null) {
			let index = this.breakdownIndexes.get(model);
			if (index == null) {
				index = this.breakdowns.length;
				this.breakdownIndexes.set(model, index);
				this.models.push(model);
				this.breakdowns.push(newModelBreakdown(model));
			}
			const breakdown = this.breakdowns[index]!;
			breakdown.inputTokens += usage.input_tokens;
			breakdown.outputTokens += usage.output_tokens;
			breakdown.cacheCreationTokens += cacheCreationTokenCount(usage);
			breakdown.cacheReadTokens += usage.cache_read_input_tokens;
			breakdown.extraTotalTokens += entry.extraTotalTokens;
			breakdown.cost += entry.cost;
			if (entry.missingPricingModel != null) {
				breakdown.missingPricing = true;
			}
		}
	}

	intoSummary(): UsageSummary {
		this.breakdowns.sort((a, b) => b.cost - a.cost);
		const summary = newUsageSummary();
		summary.inputTokens = this.counts.inputTokens;
		summary.outputTokens = this.counts.outputTokens;
		summary.cacheCreationTokens = this.counts.cacheCreationTokens;
		summary.cacheReadTokens = this.counts.cacheReadTokens;
		summary.extraTotalTokens = this.counts.extraTotalTokens;
		summary.totalCost = this.cost;
		summary.credits = this.credits;
		summary.messageCount = this.messageCount;
		summary.modelsUsed = this.models;
		summary.modelBreakdowns = this.breakdowns;
		return summary;
	}
}

export function summarizeByKey(
	entries: LoadedEntry[],
	keyFn: (entry: LoadedEntry) => string,
	metaFn: (key: string) => [string, string | undefined],
): UsageSummary[] {
	const groups = new Map<string, UsageAccumulator>();
	for (const entry of entries) {
		const key = keyFn(entry);
		let acc = groups.get(key);
		if (acc == null) {
			acc = new UsageAccumulator();
			groups.set(key, acc);
		}
		acc.addEntry(entry);
	}
	// Rust uses a BTreeMap (sorted keys). Callers re-sort, but match anyway.
	const rows: UsageSummary[] = [];
	for (const key of [...groups.keys()].sort()) {
		const [date, project] = metaFn(key);
		const summary = groups.get(key)!.intoSummary();
		summary.date = date;
		summary.project = project;
		rows.push(summary);
	}
	return rows;
}

export class SessionAccumulator {
	private usage = new UsageAccumulator();
	private latest: { timestamp: number; sessionId: string; projectPath: string } | undefined;
	private earliest: number | undefined;
	private versions = new Set<string>();

	addEntry(entry: LoadedEntry): void {
		this.usage.addEntry(entry);
		if (this.latest == null || entry.timestamp > this.latest.timestamp) {
			this.latest = {
				timestamp: entry.timestamp,
				sessionId: entry.sessionId,
				projectPath: entry.projectPath,
			};
		}
		if (this.earliest == null || entry.timestamp < this.earliest) {
			this.earliest = entry.timestamp;
		}
		if (entry.data.version != null) {
			this.versions.add(entry.data.version);
		}
	}

	intoSummary(): UsageSummary {
		if (this.latest == null) {
			throw new Error('empty session group');
		}
		const summary = this.usage.intoSummary();
		summary.sessionId = this.latest.sessionId;
		summary.projectPath = this.latest.projectPath;
		summary.lastActivity = formatRfc3339Millis(this.latest.timestamp);
		summary.firstActivity = this.earliest != null ? formatRfc3339Millis(this.earliest) : undefined;
		summary.versions = [...this.versions].sort();
		return summary;
	}
}

export function summarizeSummariesByBucket(
	rows: UsageSummary[],
	kind: BucketKind,
	start: WeekDay,
): UsageSummary[] {
	const groups = new Map<string, UsageSummary[]>();
	for (const row of rows) {
		const date = row.date;
		if (date == null) {
			continue;
		}
		const bucket = kind === 'monthly'
			? (date.length >= 7 ? date.slice(0, 7) : date)
			: (weekStart(date, start) ?? date);
		let list = groups.get(bucket);
		if (list == null) {
			list = [];
			groups.set(bucket, list);
		}
		list.push(row);
	}

	const result: UsageSummary[] = [];
	for (const bucket of [...groups.keys()].sort()) {
		const summary = aggregateSummaries(groups.get(bucket)!);
		if (kind === 'monthly') {
			summary.month = bucket;
		}
		else {
			summary.week = bucket;
		}
		result.push(summary);
	}
	return result;
}

function aggregateSummaries(rows: UsageSummary[]): UsageSummary {
	const summary = newUsageSummary();
	const seenModels = new Set<string>();
	const breakdownIndexes = new Map<string, number>();

	for (const row of rows) {
		summary.inputTokens += row.inputTokens;
		summary.outputTokens += row.outputTokens;
		summary.cacheCreationTokens += row.cacheCreationTokens;
		summary.cacheReadTokens += row.cacheReadTokens;
		summary.extraTotalTokens += row.extraTotalTokens;
		summary.totalCost += row.totalCost;
		if (row.credits != null) {
			summary.credits = (summary.credits ?? 0) + row.credits;
		}
		if (row.messageCount != null) {
			summary.messageCount = (summary.messageCount ?? 0) + row.messageCount;
		}
		for (const model of row.modelsUsed) {
			if (!seenModels.has(model)) {
				seenModels.add(model);
				summary.modelsUsed.push(model);
			}
		}
		for (const item of row.modelBreakdowns) {
			let index = breakdownIndexes.get(item.modelName);
			if (index == null) {
				index = summary.modelBreakdowns.length;
				breakdownIndexes.set(item.modelName, index);
				summary.modelBreakdowns.push(newModelBreakdown(item.modelName));
			}
			const breakdown = summary.modelBreakdowns[index]!;
			breakdown.inputTokens += item.inputTokens;
			breakdown.outputTokens += item.outputTokens;
			breakdown.cacheCreationTokens += item.cacheCreationTokens;
			breakdown.cacheReadTokens += item.cacheReadTokens;
			breakdown.extraTotalTokens += item.extraTotalTokens;
			breakdown.cost += item.cost;
			breakdown.missingPricing ||= item.missingPricing;
		}
	}
	summary.modelBreakdowns.sort((a, b) => b.cost - a.cost);
	return summary;
}

export function filterAndSortSummaries(
	rows: UsageSummary[],
	shared: SharedArgs,
	dateFn: (row: UsageSummary) => string,
): UsageSummary[] {
	let result = rows;
	if (shared.since != null || shared.until != null) {
		result = result.filter((row) => {
			const date = dateFn(row).replace(/-/g, '');
			return (
				(shared.since == null || date >= shared.since)
				&& (shared.until == null || date <= shared.until)
			);
		});
	}
	sortSummaries(result, shared.order, dateFn);
	return result;
}

export function sortSummaries(
	rows: UsageSummary[],
	order: SortOrder,
	dateFn: (row: UsageSummary) => string,
): void {
	rows.sort((a, b) => {
		const da = dateFn(a);
		const db = dateFn(b);
		const cmp = da < db ? -1 : da > db ? 1 : 0;
		return order === 'asc' ? cmp : -cmp;
	});
}

export function weekStart(date: string, start: WeekDay): string | undefined {
	const iso = parseIsoDate(date);
	if (iso == null) {
		return undefined;
	}
	const startNum: Record<WeekDay, number> = {
		sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
	};
	const day = weekdayFromSunday(iso);
	const shift = ((day - startNum[start]) % 7 + 7) % 7;
	const shifted = checkedAddDays(iso, -shift);
	return shifted != null ? formatNaiveDate(shifted) : undefined;
}
