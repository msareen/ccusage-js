import { describe, expect, it } from 'bun:test';
import { formatDateTz, parseIsoDate, parseTsTimestamp, weekdayFromSunday } from './date.ts';
import { tieredCost } from './cost.ts';
import { PricingMap } from './pricing.ts';
import { weekStart } from './summary.ts';

describe('parseTsTimestamp', () => {
	it('parses a Z timestamp without millis', () => {
		expect(parseTsTimestamp('2026-01-02T10:00:00Z')).toBe(Date.UTC(2026, 0, 2, 10, 0, 0));
	});

	it('parses a timestamp with milliseconds', () => {
		expect(parseTsTimestamp('2026-01-02T10:00:00.250Z')).toBe(Date.UTC(2026, 0, 2, 10, 0, 0, 250));
	});

	it('applies a positive timezone offset', () => {
		expect(parseTsTimestamp('2026-01-02T10:00:00+09:00')).toBe(Date.UTC(2026, 0, 2, 1, 0, 0));
	});

	it('rejects malformed input', () => {
		expect(parseTsTimestamp('not-a-timestamp')).toBeUndefined();
		expect(parseTsTimestamp('2026-13-02T10:00:00Z')).toBeUndefined();
	});
});

describe('tieredCost', () => {
	it('uses the flat rate below the 200k threshold', () => {
		expect(tieredCost(1000, 2, 5)).toBe(2000);
	});

	it('applies the above-200k rate to the overflow', () => {
		expect(tieredCost(200_001, 1, 10)).toBe(200_000 * 1 + 1 * 10);
	});

	it('ignores the above rate when none is provided', () => {
		expect(tieredCost(300_000, 1, undefined)).toBe(300_000);
	});
});

describe('PricingMap fuzzy matching', () => {
	const map = PricingMap.loadEmbedded();

	it('matches a date-suffixed Sonnet alias to the base model', () => {
		const direct = map.find('claude-sonnet-4');
		const aliased = map.find('claude-sonnet-4-20250514');
		expect(aliased).toBeDefined();
		expect(aliased?.input).toBe(direct?.input);
	});

	it('resolves a built-in model exactly', () => {
		const opus = map.find('claude-opus-4-8');
		expect(opus?.input).toBe(5e-6);
		expect(opus?.output).toBe(25e-6);
	});
});

describe('date helpers', () => {
	it('computes the weekday from Sunday', () => {
		// 2026-01-02 is a Friday => 5
		expect(weekdayFromSunday(parseIsoDate('2026-01-02')!)).toBe(5);
	});

	it('computes a Sunday-based week start', () => {
		expect(weekStart('2026-01-02', 'sunday')).toBe('2025-12-28');
	});

	it('computes a Monday-based week start', () => {
		expect(weekStart('2026-01-02', 'monday')).toBe('2025-12-29');
	});

	it('formats UTC dates in a fixed zone', () => {
		expect(formatDateTz(Date.UTC(2026, 0, 2, 23, 0, 0), 'UTC')).toBe('2026-01-02');
		expect(formatDateTz(Date.UTC(2026, 0, 2, 23, 0, 0), 'Asia/Tokyo')).toBe('2026-01-03');
	});
});
