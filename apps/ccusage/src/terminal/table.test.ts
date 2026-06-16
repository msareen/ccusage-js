import { describe, expect, it } from 'bun:test';
import { SimpleTable, boxTitleLines, selectTerminalWidth } from './table.ts';
import type { Align, TerminalStyle } from './table.ts';

const NO_COLOR: TerminalStyle = { color: false, noColor: true };
const ALIGNS: Align[] = ['left', 'left', 'right', 'right', 'right'];
const HEADERS = ['Date', 'Models', 'Input', 'Output', 'Cost (USD)'];

describe('SimpleTable parity with Rust snapshots', () => {
	it('renders a full table with multiline cells and separators', () => {
		const table = new SimpleTable(HEADERS, ALIGNS, NO_COLOR).withTerminalWidth(120);
		table.push(['2026-05-18', '- claude-sonnet-4\n- gpt-5.2-codex', '1,234', '56', '$0.42']);
		table.push(['(assuming cache warmup)', '', '0', '0', '$0.00']);
		table.separator();
		table.push(['Total', '', '1,234', '56', '$0.42']);

		const expected = [
			'┌─────────────────────────┬───────────────────┬───────────┬───────────┬─────────────┐',
			'│ Date                    │ Models            │     Input │    Output │  Cost (USD) │',
			'├─────────────────────────┼───────────────────┼───────────┼───────────┼─────────────┤',
			'│ 2026-05-18              │ - claude-sonnet-4 │     1,234 │        56 │       $0.42 │',
			'│                         │ - gpt-5.2-codex   │           │           │             │',
			'├─────────────────────────┼───────────────────┼───────────┼───────────┼─────────────┤',
			'│ (assuming cache warmup) │                   │         0 │         0 │       $0.00 │',
			'├─────────────────────────┼───────────────────┼───────────┼───────────┼─────────────┤',
			'│ Total                   │                   │     1,234 │        56 │       $0.42 │',
			'└─────────────────────────┴───────────────────┴───────────┴───────────┴─────────────┘',
		].join('\n');
		expect(table.renderLines().join('\n')).toBe(expected);
	});

	it('renders a narrow table with wrapping, truncation, and compact dates', () => {
		const table = new SimpleTable(HEADERS, ALIGNS, NO_COLOR)
			.withTerminalWidth(56)
			.withDateCompaction(true);
		table.push([
			'2026-05-18',
			'- claude-sonnet-4-20250514\n- unusually-long-model-name-without-breaks',
			'123,456,789',
			'9,876,543',
			'$12345.67',
		]);

		const expected = [
			'┌──────────┬────────────┬──────────┬──────────┬──────────┐',
			'│ Date     │ Models     │    Input │   Output │     Cost │',
			'│          │            │          │          │    (USD) │',
			'├──────────┼────────────┼──────────┼──────────┼──────────┤',
			'│ 2026     │ -          │ 123,456… │ 9,876,5… │ $12345.… │',
			'│ 05-18    │ claude-so… │          │          │          │',
			'│          │ -          │          │          │          │',
			'│          │ unusually… │          │          │          │',
			'└──────────┴────────────┴──────────┴──────────┴──────────┘',
		].join('\n');
		expect(table.renderLines().join('\n')).toBe(expected);
	});

	it('renders the multiline box title layout', () => {
		const lines = boxTitleLines(
			'Coding (Agent) CLI Usage Report - Daily\nDetected: Claude, Codex',
			NO_COLOR,
		);
		const expected = [
			'',
			'╭────────────────────────────────────────────╮',
			'│                                            │',
			'│  Coding (Agent) CLI Usage Report - Daily   │',
			'│          Detected: Claude, Codex           │',
			'│                                            │',
			'╰────────────────────────────────────────────╯',
			'',
		].join('\n');
		expect(lines.join('\n')).toBe(expected);
	});
});

describe('selectTerminalWidth', () => {
	it('prefers COLUMNS over detected width', () => {
		expect(selectTerminalWidth('80', 100)).toBe(80);
	});
	it('ignores invalid COLUMNS', () => {
		expect(selectTerminalWidth('wide', 100)).toBe(100);
	});
	it('falls back to the default', () => {
		expect(selectTerminalWidth(undefined, undefined)).toBe(120);
	});
	it('ignores zero detected width', () => {
		expect(selectTerminalWidth(undefined, 0)).toBe(120);
	});
});
