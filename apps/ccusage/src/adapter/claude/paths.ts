/** Claude data-directory discovery ported from `adapter/claude/paths.rs`. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	}
	catch {
		return false;
	}
}

function expandHomePath(raw: string): string {
	if (raw === '~') {
		return homedir();
	}
	if (raw.startsWith('~/')) {
		return path.join(homedir(), raw.slice(2));
	}
	return raw;
}

function normalizeClaudeConfigPath(raw: string): string {
	const expanded = expandHomePath(raw);
	if (path.basename(expanded) === 'projects' && isDir(expanded)) {
		return path.dirname(expanded);
	}
	return expanded;
}

/** Mirrors `claude_paths`. Throws on an invalid CLAUDE_CONFIG_DIR. */
export function claudePaths(): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const envPaths = process.env.CLAUDE_CONFIG_DIR;
	if (envPaths != null) {
		for (const raw of envPaths.split(',').map(s => s.trim()).filter(s => s.length > 0)) {
			const p = normalizeClaudeConfigPath(raw);
			if (isDir(path.join(p, 'projects')) && !seen.has(p)) {
				seen.add(p);
				paths.push(p);
			}
		}
		if (paths.length > 0) {
			return paths;
		}
		throw new Error(
			`No valid Claude data directories found in CLAUDE_CONFIG_DIR. Expected each path to be a Claude config directory containing 'projects/', or the 'projects/' directory itself: ${envPaths}`,
		);
	}

	const home = homedir();
	const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
	for (const p of [path.join(xdg, 'claude'), path.join(home, '.claude')]) {
		if (isDir(path.join(p, 'projects')) && !seen.has(p)) {
			seen.add(p);
			paths.push(p);
		}
	}
	return paths;
}

export function isProjectPathSegment(value: string): boolean {
	return (
		value.length > 0
		&& value !== '.'
		&& value !== '..'
		&& !value.includes('/')
		&& !value.includes('\\')
	);
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

/** Mirrors `usage_files`: discover JSONL files, sorted by path string. */
export function usageFiles(paths: string[], projectFilter: string | undefined): string[] {
	const files: string[] = [];
	for (const root of paths) {
		const projectsDir = path.join(root, 'projects');
		if (projectFilter != null && isProjectPathSegment(projectFilter)) {
			collectFilesWithExtension(path.join(projectsDir, projectFilter), 'jsonl', files);
		}
		else {
			collectFilesWithExtension(projectsDir, 'jsonl', files);
		}
	}
	files.sort();
	return files;
}

function pathComponents(p: string): string[] {
	return p.split(/[/\\]/).filter(part => part.length > 0);
}

/** Mirrors `extract_project`: the segment immediately after `projects`. */
export function extractProject(filePath: string): string {
	let sawProjects = false;
	for (const part of pathComponents(filePath)) {
		if (sawProjects) {
			return part.trim().length === 0 ? 'unknown' : part;
		}
		if (part === 'projects') {
			sawProjects = true;
		}
	}
	return 'unknown';
}

/** Mirrors `extract_session_parts`: returns [sessionId, projectPath]. */
export function extractSessionParts(filePath: string): [string, string] {
	const parts = pathComponents(filePath);
	const projectsIndex = parts.indexOf('projects');
	const relative = projectsIndex >= 0 ? parts.slice(projectsIndex + 1) : parts;
	const last = relative[relative.length - 1];
	const fileSessionId = last != null && last.endsWith('.jsonl')
		? last.slice(0, -'.jsonl'.length)
		: undefined;
	const fileSession = fileSessionId != null && fileSessionId.length > 0 ? fileSessionId : undefined;

	if (relative.length === 2 && fileSession != null) {
		return [fileSession, relative[0]!];
	}
	if (relative.length >= 4 && relative[relative.length - 2] === 'subagents') {
		const sessionId = relative[relative.length - 3]!;
		const projectPath = relative.slice(0, relative.length - 3).join(path.sep);
		return [sessionId, projectPath.length === 0 ? 'Unknown Project' : projectPath];
	}
	const sessionId = relative[Math.max(0, relative.length - 2)] ?? 'unknown';
	const projectPath = relative.length > 2
		? relative.slice(0, relative.length - 2).join(path.sep)
		: 'Unknown Project';
	return [sessionId, projectPath];
}

export function fileExists(p: string): boolean {
	return existsSync(p);
}
