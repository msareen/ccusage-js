/**
 * Terminal table + box-title rendering, ported from the `ccusage-terminal`
 * crate (`table.rs`, `style.rs`, `title.rs`, `width.rs`, `terminal.rs`).
 *
 * Display-width math uses `Bun.stringWidth`, which is Unicode-aware and strips
 * ANSI escapes — matching the Rust `visible_width`/`char_display_width` helpers.
 */
import process from 'node:process';

export const DEFAULT_TERMINAL_WIDTH = 120;

export type Align = 'left' | 'right';

export type Color = 'blue' | 'green' | 'grey' | 'red' | 'yellow';

export type TerminalStyle = {
	color: boolean;
	logLevel?: number;
	noColor: boolean;
};

export function defaultTerminalStyle(): TerminalStyle {
	return { color: false, noColor: false };
}

// ---------------------------------------------------------------------------
// width
// ---------------------------------------------------------------------------

export function visibleWidth(value: string): number {
	return Bun.stringWidth(value);
}

export function containsAnsi(value: string): boolean {
	return value.includes('\x1b');
}

function charDisplayWidth(ch: string): number {
	return Bun.stringWidth(ch);
}

export function visibleWidthMaxLine(value: string): number {
	let max = 0;
	for (const line of value.split('\n')) {
		max = Math.max(max, visibleWidth(line));
	}
	return max;
}

// ---------------------------------------------------------------------------
// style / color
// ---------------------------------------------------------------------------

export function color(style: TerminalStyle, value: string, c: Color): string {
	if (!useColor(style)) {
		return value;
	}
	const code = { blue: 34, green: 32, grey: 90, red: 31, yellow: 33 }[c];
	return `\x1b[${code}m${value}\x1b[0m`;
}

function useColor(style: TerminalStyle): boolean {
	if (style.noColor || process.env.NO_COLOR != null) {
		return false;
	}
	return style.color || process.env.FORCE_COLOR != null || process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// terminal width
// ---------------------------------------------------------------------------

export function terminalWidth(): number {
	return selectTerminalWidth(process.env.COLUMNS, terminalSizeWidth());
}

function terminalSizeWidth(): number | undefined {
	const columns = process.stdout.columns;
	return typeof columns === 'number' && columns > 0 ? columns : undefined;
}

export function selectTerminalWidth(
	columns: string | undefined,
	detectedWidth: number | undefined,
): number {
	if (columns != null) {
		const parsed = Number.parseInt(columns, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	if (detectedWidth != null && detectedWidth > 0) {
		return detectedWidth;
	}
	return DEFAULT_TERMINAL_WIDTH;
}

// ---------------------------------------------------------------------------
// box title
// ---------------------------------------------------------------------------

export function printBoxTitle(title: string, style: TerminalStyle): void {
	if (style.logLevel === 0) {
		return;
	}
	for (const line of boxTitleLines(title, style)) {
		process.stdout.write(`${line}\n`);
	}
}

export function boxTitleLines(title: string, style: TerminalStyle): string[] {
	const titleLines = title.split('\n');
	let contentWidth = 0;
	for (const line of titleLines) {
		contentWidth = Math.max(contentWidth, visibleWidth(line));
	}
	contentWidth = Math.max(contentWidth, 40) + 2;
	const lines: string[] = [];
	lines.push('');
	lines.push(`╭${'─'.repeat(contentWidth + 2)}╮`);
	lines.push(`│${' '.repeat(contentWidth + 2)}│`);
	for (const line of titleLines) {
		const padding = Math.max(0, contentWidth - visibleWidth(line));
		const left = Math.floor(padding / 2);
		const right = padding - left;
		lines.push(`│ ${' '.repeat(left)}${color(style, line, 'blue')}${' '.repeat(right)} │`);
	}
	lines.push(`│${' '.repeat(contentWidth + 2)}│`);
	lines.push(`╰${'─'.repeat(contentWidth + 2)}╯`);
	lines.push('');
	return lines;
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

export class SimpleTable {
	private headers: string[];
	private aligns: Align[];
	private rows: (string[] | null)[] = [];
	private style: TerminalStyle;
	private terminalWidthValue = DEFAULT_TERMINAL_WIDTH;
	private compactDates = false;

	constructor(headers: string[], aligns: Align[], style: TerminalStyle) {
		this.headers = [...headers];
		this.aligns = aligns;
		this.style = style;
	}

	withTerminalWidth(width: number): this {
		this.terminalWidthValue = width;
		return this;
	}

	withDateCompaction(compactDates: boolean): this {
		this.compactDates = compactDates;
		return this;
	}

	push(row: string[]): void {
		this.rows.push(row);
	}

	separator(): void {
		this.rows.push(null);
	}

	columnCount(): number {
		return this.headers.length;
	}

	print(): void {
		for (const line of this.renderLines()) {
			process.stdout.write(`${line}\n`);
		}
	}

	renderLines(): string[] {
		const widths = this.columnWidths();
		const lines: string[] = [];
		lines.push(border('┌', '┬', '┐', widths));
		for (const headerRow of expandMultilineRow(this.headers, this.headers.length, widths)) {
			const colored = headerRow.map(header => color(this.style, header, 'blue'));
			lines.push(tableLine(colored, this.aligns, widths));
		}
		lines.push(border('├', '┼', '┤', widths));
		for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex++) {
			const row = this.rows[rowIndex]!;
			if (row != null) {
				const compacted = this.compactDateRow(row, widths);
				for (const physical of expandMultilineRow(compacted, this.headers.length, widths)) {
					lines.push(tableLine(physical, this.aligns, widths));
				}
			}
			else {
				lines.push(border('├', '┼', '┤', widths));
			}
			const nextRow = this.rows[rowIndex + 1];
			if (row != null && rowIndex + 1 < this.rows.length && nextRow != null) {
				lines.push(border('├', '┼', '┤', widths));
			}
		}
		lines.push(border('└', '┴', '┘', widths));
		return lines;
	}

	columnWidths(): number[] {
		const contentWidths = this.headers.map(visibleWidthMaxLine);
		for (const row of this.rows) {
			if (row == null) {
				continue;
			}
			for (let index = 0; index < row.length; index++) {
				const cellWidth = visibleWidthMaxLine(row[index]!);
				if (index < contentWidths.length) {
					contentWidths[index] = Math.max(contentWidths[index]!, cellWidth);
				}
			}
		}
		const widths = contentWidths.map((width, index) => {
			if (this.aligns[index] === 'right') {
				return Math.max(width + 3, 11);
			}
			if (index === 1) {
				return Math.max(width + 2, 15);
			}
			return Math.max(width + 2, 10);
		});
		const totalRequired = cliTableRequiredWidth(widths);
		const firstColumnMin = this.compactDates && totalRequired <= this.terminalWidthValue ? 12 : 10;
		return fitWidthsToTerminal(widths, this.aligns, this.terminalWidthValue, firstColumnMin);
	}

	private compactDateRow(row: string[], widths: number[]): string[] {
		if (!this.compactDates || (widths[0] ?? 0) > 10) {
			return [...row];
		}
		const out = [...row];
		if (out.length > 0) {
			const compact = compactDateCell(out[0]!);
			if (compact != null) {
				out[0] = compact;
			}
		}
		return out;
	}
}

function expandMultilineRow(row: string[], columnCount: number, widths: number[]): string[][] {
	const cells: string[][] = [];
	for (let index = 0; index < columnCount; index++) {
		const contentWidth = Math.max(0, (widths[index] ?? 0) - 2);
		const cell = row[index];
		let lines = cell != null ? wrapCellLines(cell, contentWidth) : [''];
		if (lines.length === 0) {
			lines = [''];
		}
		cells.push(lines);
	}
	const height = Math.max(1, ...cells.map(lines => lines.length));
	const result: string[][] = [];
	for (let lineIndex = 0; lineIndex < height; lineIndex++) {
		result.push(cells.map(lines => lines[lineIndex] ?? ''));
	}
	return result;
}

function fitWidthsToTerminal(
	widths: number[],
	aligns: Align[],
	terminalWidthValue: number,
	firstColumnMin: number,
): number[] {
	if (cliTableRequiredWidth(widths) <= terminalWidthValue) {
		return widths;
	}

	const minimums = widths.map((_, index) => {
		if (aligns[index] === 'right') {
			return 10;
		}
		if (index === 0) {
			return firstColumnMin;
		}
		if (index === 1) {
			return 12;
		}
		return 8;
	});

	const result = [...widths];
	const availableWidth = Math.max(0, terminalWidthValue - (result.length + 1));
	const totalContentWidth = result.reduce((sum, w) => sum + w, 0);
	if (totalContentWidth > 0) {
		const scale = availableWidth / totalContentWidth;
		for (let index = 0; index < result.length; index++) {
			const scaled = Math.floor(result[index]! * scale);
			result[index] = Math.max(scaled, minimums[index]!);
		}
	}

	while (cliTableRequiredWidth(result) > terminalWidthValue) {
		let bestIndex = -1;
		let bestWidth = -1;
		for (let index = 0; index < result.length; index++) {
			if (result[index]! > minimums[index]! && result[index]! > bestWidth) {
				bestWidth = result[index]!;
				bestIndex = index;
			}
		}
		if (bestIndex < 0) {
			break;
		}
		result[bestIndex] = result[bestIndex]! - 1;
	}
	return result;
}

function cliTableRequiredWidth(widths: number[]): number {
	return widths.reduce((sum, w) => sum + w, 0) + widths.length + 1;
}

function wrapCellLines(cell: string, width: number): string[] {
	if (width === 0) {
		return [''];
	}
	const lines: string[] = [];
	for (const line of cell.split('\n')) {
		if (visibleWidth(line) <= width) {
			lines.push(line);
			continue;
		}
		lines.push(...wrapCellLine(line, width));
	}
	return lines;
}

function splitWhitespace(value: string): string[] {
	return value.split(/\s+/).filter(word => word.length > 0);
}

function wrapCellLine(line: string, width: number): string[] {
	const words = splitWhitespace(line);
	if (words.length <= 1) {
		return [truncateVisible(line, width)];
	}

	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidateWidth
			= current === '' ? visibleWidth(word) : visibleWidth(current) + 1 + visibleWidth(word);
		if (candidateWidth <= width) {
			current = current === '' ? word : `${current} ${word}`;
		}
		else {
			if (current !== '') {
				lines.push(current);
			}
			current = visibleWidth(word) > width ? truncateVisible(word, width) : word;
		}
	}
	if (current !== '') {
		lines.push(current);
	}
	return lines;
}

function truncateVisible(value: string, width: number): string {
	if (visibleWidth(value) <= width) {
		return value;
	}
	if (width <= 1) {
		return '…';
	}
	let output = '';
	let currentWidth = 0;
	let index = 0;
	while (index < value.length) {
		if (value.charCodeAt(index) === 0x1b) {
			const start = index;
			index += 1;
			if (index < value.length && value[index] === '[') {
				index += 1;
				while (index < value.length && !isAsciiAlpha(value[index]!)) {
					index += 1;
				}
				if (index < value.length) {
					index += 1;
				}
			}
			output += value.slice(start, index);
			continue;
		}
		const ch = codePointAt(value, index);
		if (ch == null) {
			break;
		}
		const charWidth = charDisplayWidth(ch);
		if (currentWidth + charWidth >= width) {
			break;
		}
		output += ch;
		currentWidth += charWidth;
		index += ch.length;
	}
	if (containsAnsi(value) && !output.endsWith('\x1b[0m')) {
		output += '\x1b[0m';
	}
	output += '…';
	return output;
}

function codePointAt(value: string, index: number): string | undefined {
	const cp = value.codePointAt(index);
	return cp == null ? undefined : String.fromCodePoint(cp);
}

function isAsciiAlpha(ch: string): boolean {
	return /^[A-Za-z]$/.test(ch);
}

function compactDateCell(value: string): string | undefined {
	if (
		value.length === 10
		&& value[4] === '-'
		&& value[7] === '-'
		&& /^\d{4}$/.test(value.slice(0, 4))
		&& /^\d{2}$/.test(value.slice(5, 7))
		&& /^\d{2}$/.test(value.slice(8, 10))
	) {
		return `${value.slice(0, 4)}\n${value.slice(5)}`;
	}
	return undefined;
}

function tableLine(cells: string[], aligns: Align[], widths: number[]): string {
	let line = '│';
	for (let index = 0; index < widths.length; index++) {
		const cell = cells[index] ?? '';
		const align: Align = index === 0 && cell.startsWith('(assuming ')
			? 'right'
			: aligns[index] ?? 'left';
		line += ' ';
		line += padCell(cell, Math.max(0, widths[index]! - 2), align);
		line += ' ';
		line += '│';
	}
	return line;
}

function padCell(cell: string, width: number, align: Align): string {
	const visible = visibleWidth(cell);
	if (visible >= width) {
		return cell;
	}
	const padding = width - visible;
	return align === 'left' ? `${cell}${' '.repeat(padding)}` : `${' '.repeat(padding)}${cell}`;
}

function border(left: string, middle: string, right: string, widths: number[]): string {
	let line = left;
	for (let index = 0; index < widths.length; index++) {
		line += '─'.repeat(widths[index]!);
		line += index + 1 === widths.length ? right : middle;
	}
	return line;
}
