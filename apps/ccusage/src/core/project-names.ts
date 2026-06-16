/** Project-name + model-name shortening, ported from `project_names.rs`. */

export function parseProjectAliases(raw: string | undefined): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const pair of (raw ?? '').split(',')) {
		const eq = pair.indexOf('=');
		if (eq < 0) {
			continue;
		}
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (key.length > 0 && value.length > 0) {
			aliases.set(key, value);
		}
	}
	return aliases;
}

export function formatProjectName(project: string, aliases: Map<string, string>): string {
	const direct = aliases.get(project);
	if (direct != null) {
		return direct;
	}
	const parsed = parseProjectName(project);
	return aliases.get(parsed) ?? parsed;
}

function isWindowsUsersPath(project: string): boolean {
	return (
		(project.length >= 10
			&& project[1] === ':'
			&& project[2] === '\\'
			&& project.slice(3).startsWith('Users\\'))
		|| project.startsWith('\\Users\\')
	);
}

function trimChars(value: string, chars: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && chars.includes(value[start]!)) {
		start += 1;
	}
	while (end > start && chars.includes(value[end - 1]!)) {
		end -= 1;
	}
	return value.slice(start, end);
}

const MEANINGLESS_SEGMENTS = new Set([
	'dev', 'development', 'feat', 'feature', 'fix', 'bug', 'test',
	'staging', 'prod', 'production', 'main', 'master', 'branch',
]);

function parseProjectName(project: string): string {
	if (project === '' || project === 'unknown') {
		return 'Unknown Project';
	}
	let cleaned = project;
	if (isWindowsUsersPath(cleaned)) {
		const segments = cleaned.split('\\');
		const index = segments.indexOf('Users');
		if (index >= 0) {
			if (index + 3 < segments.length) {
				cleaned = segments.slice(index + 3).join('-');
			}
			else if (index + 2 < segments.length) {
				cleaned = segments.slice(index + 2).join('-');
			}
		}
	}
	else if (cleaned.startsWith('-Users-') || cleaned.startsWith('/Users/')) {
		const separator = cleaned.startsWith('-Users-') ? '-' : '/';
		const segments = cleaned.split(separator).filter(segment => segment.length > 0);
		const index = segments.indexOf('Users');
		if (index >= 0) {
			if (index + 3 < segments.length) {
				cleaned = segments.slice(index + 3).join('-');
			}
			else if (index + 2 < segments.length) {
				cleaned = segments.slice(index + 2).join('-');
			}
		}
	}
	else {
		cleaned = trimChars(cleaned, '/\\-');
	}
	if (
		cleaned.split('-').length >= 5
		&& [...cleaned].every(ch => /[0-9a-fA-F]/.test(ch) || ch === '-' || ch === '.')
	) {
		const parts = cleaned.split('-');
		cleaned = parts.slice(Math.max(0, parts.length - 2)).join('-');
	}
	const doubleDash = cleaned.indexOf('--');
	if (doubleDash >= 0) {
		cleaned = cleaned.slice(0, doubleDash);
	}
	if (cleaned.includes('-') && cleaned.length > 20) {
		const meaningful = cleaned
			.split('-')
			.filter(segment => segment.length > 2 && !MEANINGLESS_SEGMENTS.has(segment.toLowerCase()));
		if (meaningful.length >= 2) {
			const lastTwo = meaningful.slice(meaningful.length - 2).join('-');
			if (lastTwo.length >= 6) {
				cleaned = lastTwo;
			}
			else if (meaningful.length >= 3) {
				cleaned = meaningful.slice(meaningful.length - 3).join('-');
			}
		}
	}
	cleaned = trimChars(cleaned, '/\\-');
	return cleaned === '' ? project : cleaned;
}

export function shortModelName(model: string): string {
	let stripped = model;
	if (stripped.startsWith('anthropic/claude-')) {
		stripped = stripped.slice('anthropic/claude-'.length);
	}
	else if (stripped.startsWith('claude-')) {
		stripped = stripped.slice('claude-'.length);
	}
	const parts = stripped.split('-');
	if (parts.length >= 3 && parts[parts.length - 1]!.length === 8) {
		return parts.slice(0, parts.length - 1).join('-');
	}
	return stripped;
}
