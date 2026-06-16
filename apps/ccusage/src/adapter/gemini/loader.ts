/** Gemini entry loading ported from `adapter/gemini/loader.rs`. */
import type { LoadedEntry } from '../../core/types.ts';
import type { SharedArgs } from '../../core/options.ts';
import type { PricingMap } from '../../core/pricing.ts';
import { isValidTimezone } from '../../core/date.ts';
import { discoverLogFiles } from './paths.ts';
import { eventToLoaded, parseJsonFile, parseJsonlFile, type GeminiUsageEvent } from './parser.ts';

export function loadEntries(shared: SharedArgs, pricing: PricingMap): LoadedEntry[] {
	const tz = isValidTimezone(shared.timezone);
	const events: GeminiUsageEvent[] = [];
	for (const file of discoverLogFiles()) {
		if (file.endsWith('.jsonl')) {
			events.push(...parseJsonlFile(file));
		}
		else {
			events.push(...parseJsonFile(file));
		}
	}
	events.sort((a, b) => a.timestamp - b.timestamp);
	return events.map(event => eventToLoaded(event, tz, shared.mode, pricing));
}
