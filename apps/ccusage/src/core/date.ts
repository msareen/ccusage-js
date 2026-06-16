/**
 * Date / timezone utilities ported from `rust/crates/ccusage/src/date_utils.rs`.
 *
 * Timestamps are epoch milliseconds (numbers). Timezone-aware date bucketing is
 * done with `Intl.DateTimeFormat` (IANA zones); the Rust version uses jiff.
 */

export const MILLIS_PER_SECOND = 1000;
export const MILLIS_PER_MINUTE = 60 * MILLIS_PER_SECOND;
export const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE;
export const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;

export type IsoDate = { year: number; month: number; day: number };

export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 1: case 3: case 5: case 7: case 8: case 10: case 12:
			return 31;
		case 4: case 6: case 9: case 11:
			return 30;
		case 2:
			return isLeapYear(year) ? 29 : 28;
		default:
			return 0;
	}
}

export function isoDateFromYmd(year: number, month: number, day: number): IsoDate | undefined {
	if (month < 1 || month > 12 || day === 0 || day > daysInMonth(year, month)) {
		return undefined;
	}
	return { year, month, day };
}

/** Days since the Unix epoch for a civil date (Howard Hinnant's algorithm). */
export function daysFromCivil(year: number, month: number, day: number): number {
	const y = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const mp = month + (month > 2 ? -3 : 9);
	const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

export function daysSinceEpoch(date: IsoDate): number {
	return daysFromCivil(date.year, date.month, date.day);
}

/** Weekday with Sunday = 0, matching `IsoDate::weekday_from_sunday`. */
export function weekdayFromSunday(date: IsoDate): number {
	return mod(daysSinceEpoch(date) + 4, 7);
}

export function checkedAddDays(date: IsoDate, days: number): IsoDate | undefined {
	const total = daysSinceEpoch(date) + days;
	return civilFromDays(total);
}

export function civilFromDays(daysInput: number): IsoDate {
	const days = daysInput + 719468;
	const era = Math.floor(days / 146097);
	const doe = days - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	let year = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);
	year += month <= 2 ? 1 : 0;
	return { year, month, day };
}

function mod(a: number, b: number): number {
	return ((a % b) + b) % b;
}

function parseDigits(value: string): number | undefined {
	if (value.length === 0) {
		return undefined;
	}
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 48 || c > 57) {
			return undefined;
		}
	}
	return Number(value);
}

/** Parse a timezone offset like `Z` or `+09:00` into minutes. */
export function parseTimezoneOffset(bytes: string): number | undefined {
	if (bytes === 'Z') {
		return 0;
	}
	if (bytes.length !== 6 || (bytes[0] !== '+' && bytes[0] !== '-') || bytes[3] !== ':') {
		return undefined;
	}
	const hh = parseDigits(bytes.slice(1, 3));
	const mm = parseDigits(bytes.slice(4, 6));
	if (hh == null || mm == null) {
		return undefined;
	}
	const offset = hh * 60 + mm;
	return bytes[0] === '+' ? offset : -offset;
}

/**
 * Parse an RFC3339 timestamp into epoch millis. Mirrors `parse_ts_timestamp`:
 * accepts `YYYY-MM-DDTHH:MM:SS` with optional `.mmm` and a `Z`/`±HH:MM` zone.
 */
export function parseTsTimestamp(value: string): number | undefined {
	const len = value.length;
	let millis = 0;
	let tzStart: number;
	const c19 = value[19];
	if ((len === 20 || len === 25) && (c19 === 'Z' || c19 === '+' || c19 === '-')) {
		tzStart = 19;
	}
	else if ((len === 24 || len === 29) && c19 === '.') {
		const ms = parseDigits(value.slice(20, 23));
		if (ms == null) {
			return undefined;
		}
		millis = ms;
		tzStart = 23;
	}
	else {
		return undefined;
	}

	if (value[4] !== '-' || value[7] !== '-' || value[10] !== 'T' || value[13] !== ':' || value[16] !== ':') {
		return undefined;
	}
	const year = parseDigits(value.slice(0, 4));
	const month = parseDigits(value.slice(5, 7));
	const day = parseDigits(value.slice(8, 10));
	const hour = parseDigits(value.slice(11, 13));
	const minute = parseDigits(value.slice(14, 16));
	const second = parseDigits(value.slice(17, 19));
	if (year == null || month == null || day == null || hour == null || minute == null || second == null) {
		return undefined;
	}
	if (hour > 23 || minute > 59 || second > 59) {
		return undefined;
	}
	const tzOffset = parseTimezoneOffset(value.slice(tzStart));
	if (tzOffset == null) {
		return undefined;
	}
	const date = isoDateFromYmd(year, month, day);
	if (date == null) {
		return undefined;
	}
	const ts
		= daysSinceEpoch(date) * MILLIS_PER_DAY
		+ hour * MILLIS_PER_HOUR
		+ minute * MILLIS_PER_MINUTE
		+ second * MILLIS_PER_SECOND
		+ millis;
	return ts - tzOffset * MILLIS_PER_MINUTE;
}

export function parseIsoDate(value: string): IsoDate | undefined {
	if (value.length !== 10 || value[4] !== '-' || value[7] !== '-') {
		return undefined;
	}
	const year = parseDigits(value.slice(0, 4));
	const month = parseDigits(value.slice(5, 7));
	const day = parseDigits(value.slice(8, 10));
	if (year == null || month == null || day == null) {
		return undefined;
	}
	return isoDateFromYmd(year, month, day);
}

export function formatDateParts(year: number, month: number, day: number): string {
	const y = String(year).padStart(4, '0');
	const m = String(month).padStart(2, '0');
	const d = String(day).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

export function formatNaiveDate(date: IsoDate): string {
	return formatDateParts(date.year, date.month, date.day);
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timezone: string | undefined): Intl.DateTimeFormat {
	const key = timezone ?? '';
	let fmt = dateFormatterCache.get(key);
	if (fmt == null) {
		fmt = new Intl.DateTimeFormat('en-CA', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		dateFormatterCache.set(key, fmt);
	}
	return fmt;
}

/**
 * Format epoch millis as `YYYY-MM-DD` in the given IANA timezone (system zone
 * when undefined). Mirrors `format_date_tz`.
 */
export function formatDateTz(timestamp: number, timezone?: string): string {
	const parts = dateFormatter(timezone).formatToParts(new Date(timestamp));
	let year = '';
	let month = '';
	let day = '';
	for (const part of parts) {
		if (part.type === 'year') {
			year = part.value;
		}
		else if (part.type === 'month') {
			month = part.value;
		}
		else if (part.type === 'day') {
			day = part.value;
		}
	}
	return `${year}-${month}-${day}`;
}

/** UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` for a timestamp (`format_rfc3339_millis`). */
export function formatRfc3339Millis(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

export function utcNow(): number {
	return Date.now();
}

export function floorToHour(timestamp: number): number {
	return Math.floor(timestamp / MILLIS_PER_HOUR) * MILLIS_PER_HOUR;
}

/** Local-timezone calendar parts (`local_parts`). JS `Date` getters are local. */
export type LocalParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

export function localParts(timestamp: number): LocalParts {
	const d = new Date(timestamp);
	return {
		year: d.getFullYear(),
		month: d.getMonth() + 1,
		day: d.getDate(),
		hour: d.getHours(),
		minute: d.getMinutes(),
		second: d.getSeconds(),
	};
}

/** UTC `YYYY-MM-DD HH:MM:SS` (`format_utc_second`). */
export function formatUtcSecond(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

export function hour12(hour: number): number {
	const h = hour % 12;
	return h === 0 ? 12 : h;
}

export function amPm(hour: number): string {
	return hour < 12 ? 'AM' : 'PM';
}

/** Validate that an IANA timezone string is usable (`parse_tz`). */
export function isValidTimezone(timezone: string | undefined): string | undefined {
	if (timezone == null) {
		return undefined;
	}
	try {
		// Throws RangeError for unknown zones.
		new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
		return timezone;
	}
	catch {
		return undefined;
	}
}
