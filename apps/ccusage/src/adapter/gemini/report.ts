/** Gemini report builder ported from `adapter/gemini/report.rs`. */
import type { AgentReportKind } from '../../cli/parser.ts';
import type { LoadedEntry, UsageSummary } from '../../core/types.ts';
import { summarizeByKey, summarizeSummariesByBucket } from '../../core/summary.ts';
import { totalsJson } from '../../core/output.ts';
import { agentSummaryJson, rowsKey } from '../../core/agent-report.ts';

/** Mirrors `gemini::summarize_entries`. */
export function summarizeEntries(entries: LoadedEntry[], kind: AgentReportKind): UsageSummary[] {
	switch (kind) {
		case 'daily':
			return summarizeByKey(entries, entry => entry.date, date => [date, undefined]);
		case 'monthly':
			return summarizeSummariesByBucket(
				summarizeEntries(entries, 'daily'),
				'monthly',
				'sunday',
			);
		case 'weekly':
			return summarizeSummariesByBucket(
				summarizeEntries(entries, 'daily'),
				'weekly',
				'sunday',
			);
		case 'session': {
			const rows = summarizeByKey(entries, entry => entry.sessionId, id => [id, undefined]);
			for (const row of rows) {
				row.sessionId = row.date;
				row.date = undefined;
			}
			return rows;
		}
	}
}

/** Mirrors `gemini::report_from_rows`. */
export function reportFromRows(rows: UsageSummary[], kind: AgentReportKind): Record<string, unknown> {
	return {
		[rowsKey(kind)]: rows.map(row => agentSummaryJson(row, kind, false)),
		totals: totalsJson(rows),
	};
}
