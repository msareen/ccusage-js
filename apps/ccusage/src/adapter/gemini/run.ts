/** Gemini command runner ported from `adapter/gemini/mod.rs`. */
import type { AgentCommandArgs } from '../../cli/parser.ts';
import { PricingMap } from '../../core/pricing.ts';
import { sortSummaries } from '../../core/summary.ts';
import { printJsonOrJq, wantsJson } from '../../core/output.ts';
import { printUsageTable } from '../../core/table-output.ts';
import { firstColumn, summaryPeriod } from '../../core/agent-report.ts';
import { filterLoadedEntriesByDate } from '../claude/loader.ts';
import { loadEntries } from './loader.ts';
import { reportFromRows, summarizeEntries } from './report.ts';

export async function runGemini(args: AgentCommandArgs): Promise<void> {
	const shared = args.shared;
	const pricing = await PricingMap.loadWithOverrides(shared.offline, shared.pricingOverrides);
	const entries = filterLoadedEntriesByDate(loadEntries(shared, pricing), shared);
	const rows = summarizeEntries(entries, args.kind);
	sortSummaries(rows, shared.order, summaryPeriod);

	if (wantsJson(shared)) {
		await printJsonOrJq(reportFromRows(rows, args.kind), shared.jq, shared.noCost);
		return;
	}
	printUsageTable(
		'Gemini CLI Token Usage Report',
		firstColumn(args.kind),
		rows,
		shared,
		false,
		undefined,
	);
}
