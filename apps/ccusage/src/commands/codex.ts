/** Codex report command handler, ported from `adapter/codex/mod.rs::run`. */
import { PricingMap } from '../core/pricing.ts';
import { printJsonOrJq, wantsJson } from '../core/output.ts';
import type { SharedArgs } from '../core/options.ts';
import type { CodexReportKind } from '../adapter/codex/aggregate.ts';
import { loadGroups } from '../adapter/codex/aggregate.ts';
import { printTableFromGroups, reportFromGroups } from '../adapter/codex/report.ts';
import type { CodexSpeed } from '../adapter/codex/speed.ts';
import { resolveCodexSpeed } from '../adapter/codex/speed.ts';

export async function runCodex(
	shared: SharedArgs,
	kind: CodexReportKind,
	requestedSpeed: CodexSpeed,
): Promise<void> {
	const pricing = await PricingMap.loadWithOverrides(shared.offline, shared.pricingOverrides);
	const groups = loadGroups(shared, kind);
	const speed = resolveCodexSpeed(requestedSpeed);

	if (wantsJson(shared)) {
		const output = reportFromGroups(groups, kind, pricing, speed);
		await printJsonOrJq(output, shared.jq, shared.noCost);
		return;
	}
	printTableFromGroups(groups, kind, pricing, speed, shared);
}
