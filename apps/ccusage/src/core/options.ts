/** Shared CLI option types (subset of `ccusage-cli` crate types). */
import type { CostMode } from './types.ts';
import type { PricingOverride } from './pricing.ts';

export type SortOrder = 'asc' | 'desc';

export type WeekDay = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export type BucketKind = 'monthly' | 'weekly';

/** Mirrors `normalize_date_bound`: drop hyphens so YYYY-MM-DD == YYYYMMDD. */
export function normalizeDateBound(value: string): string {
	return value.replace(/-/g, '');
}

/** Options shared across all report commands (`SharedArgs`). */
export type SharedArgs = {
	json: boolean;
	jq?: string;
	since?: string;
	until?: string;
	mode: CostMode;
	debug: boolean;
	debugSamples: number;
	order: SortOrder;
	breakdown: boolean;
	offline: boolean;
	noOffline: boolean;
	singleThread: boolean;
	color: boolean;
	noColor: boolean;
	timezone?: string;
	compact: boolean;
	noCost: boolean;
	config?: string;
	pricingOverrides: Map<string, PricingOverride>;
};

export function defaultSharedArgs(): SharedArgs {
	return {
		json: false,
		mode: 'auto',
		debug: false,
		debugSamples: 5,
		order: 'asc',
		breakdown: false,
		offline: false,
		noOffline: false,
		singleThread: false,
		color: false,
		noColor: false,
		compact: false,
		noCost: false,
		pricingOverrides: new Map(),
	};
}
