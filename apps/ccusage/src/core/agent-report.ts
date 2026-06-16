/** Shared agent report helpers ported from `rust/crates/ccusage/src/adapter/opencode/report.rs`.
 *
 * Basic agents (codex/gemini/...) render a uniform per-period JSON row and table
 * first-column label. The per-kind summarization differs slightly between agents
 * (e.g. session activity bounds), so each adapter owns its `summarizeEntries`. */
import type { AgentReportKind } from '../cli/parser.ts';
import type { UsageSummary } from './types.ts';
import { summaryTotalTokens } from './types.ts';

export function rowsKey(kind: AgentReportKind): string {
	switch (kind) {
		case 'daily': return 'daily';
		case 'weekly': return 'weekly';
		case 'monthly': return 'monthly';
		case 'session': return 'sessions';
	}
}

export function periodKey(kind: AgentReportKind): string {
	switch (kind) {
		case 'daily': return 'date';
		case 'weekly': return 'week';
		case 'monthly': return 'month';
		case 'session': return 'sessionId';
	}
}

export function firstColumn(kind: AgentReportKind): string {
	switch (kind) {
		case 'daily': return 'Date';
		case 'weekly': return 'Week';
		case 'monthly': return 'Month';
		case 'session': return 'Session';
	}
}

export function summaryPeriod(row: UsageSummary): string {
	return row.date ?? row.week ?? row.month ?? row.sessionId ?? '';
}

/** Mirrors `opencode::agent_summary_json`. */
export function agentSummaryJson(
	row: UsageSummary,
	kind: AgentReportKind,
	includeSessionMetadata: boolean,
): Record<string, unknown> {
	const value: Record<string, unknown> = {
		[periodKey(kind)]: summaryPeriod(row),
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		cacheReadTokens: row.cacheReadTokens,
		totalTokens: summaryTotalTokens(row),
		totalCost: row.totalCost,
		modelsUsed: row.modelsUsed,
	};
	if (row.credits != null) {
		value.credits = row.credits;
	}
	if (row.messageCount != null) {
		value.messageCount = row.messageCount;
	}
	if (includeSessionMetadata) {
		value.lastActivity = row.lastActivity ?? null;
		value.firstActivity = row.firstActivity ?? null;
		value.projectPath = row.projectPath ?? null;
	}
	return value;
}
