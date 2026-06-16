/** Gemini data-directory discovery ported from `adapter/gemini/paths.rs`. */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const GEMINI_DATA_DIR_ENV = 'GEMINI_DATA_DIR';

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	}
	catch {
		return false;
	}
}

/** Mirrors `gemini::paths`. */
function geminiPaths(): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const envPaths = process.env[GEMINI_DATA_DIR_ENV];
	if (envPaths != null) {
		for (const raw of envPaths.split(',').map(s => s.trim()).filter(s => s.length > 0)) {
			if (isDir(raw) && !seen.has(raw)) {
				seen.add(raw);
				paths.push(raw);
			}
		}
		return paths;
	}

	const p = path.join(homedir(), '.gemini', 'tmp');
	if (isDir(p) && !seen.has(p)) {
		seen.add(p);
		paths.push(p);
	}
	return paths;
}

function collectFilesWithExtension(dir: string, extension: string, files: string[]): void {
	let entries: import('node:fs').Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	}
	catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(`.${extension}`)) {
			files.push(full);
		}
		else if (entry.isDirectory()) {
			collectFilesWithExtension(full, extension, files);
		}
	}
}

/** Mirrors `gemini::discover_log_files`: collect `.json` and `.jsonl` files, sorted + deduped. */
export function discoverLogFiles(): string[] {
	const files: string[] = [];
	for (const root of geminiPaths()) {
		collectFilesWithExtension(root, 'json', files);
		collectFilesWithExtension(root, 'jsonl', files);
	}
	files.sort();
	const deduped: string[] = [];
	for (const file of files) {
		if (deduped.length === 0 || deduped[deduped.length - 1] !== file) {
			deduped.push(file);
		}
	}
	return deduped;
}
