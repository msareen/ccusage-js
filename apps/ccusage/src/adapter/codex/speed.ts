/** Codex speed-tier resolution, ported from `adapter/codex/speed.rs`. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { codexHomePaths } from './paths.ts';

export type CodexSpeed = 'auto' | 'standard' | 'fast';

/** Resolve `auto` by reading `service_tier` from any Codex `config.toml`. */
export function resolveCodexSpeed(requested: CodexSpeed): CodexSpeed {
	if (requested !== 'auto') {
		return requested;
	}
	return detectCodexFastServiceTier() ? 'fast' : 'standard';
}

function detectCodexFastServiceTier(): boolean {
	for (const home of codexHomePaths()) {
		let content: string;
		try {
			content = readFileSync(path.join(home, 'config.toml'), 'utf8');
		}
		catch {
			continue;
		}
		if (codexConfigRequestsFastServiceTier(content)) {
			return true;
		}
	}
	return false;
}

/** Mirrors `codex_config_requests_fast_service_tier`. */
export function codexConfigRequestsFastServiceTier(content: string): boolean {
	for (const rawLine of content.split('\n')) {
		const setting = (rawLine.split('#')[0] ?? '').trim();
		const eq = setting.indexOf('=');
		if (eq < 0) {
			continue;
		}
		const key = setting.slice(0, eq).trim();
		if (key !== 'service_tier') {
			continue;
		}
		const value = setting.slice(eq + 1).trim().replace(/^['"]+|['"]+$/g, '');
		if (value === 'fast' || value === 'priority') {
			return true;
		}
	}
	return false;
}
