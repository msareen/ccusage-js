/** Help + version rendering, ported from `ccusage-cli/src/help.rs` + `help_codegen.rs`.
 *
 * The Rust build generated static help strings from `cli-help.json` /
 * `cli-commands.json`; here we render the same text at runtime from the same
 * specs so the output stays byte-for-byte identical. */
import optionSpecJson from '../data/cli-help.json' with { type: 'json' };
import commandSpecJson from '../data/cli-commands.json' with { type: 'json' };

type OptionEntry = {
	flags: string;
	description: string;
	default?: string;
	choices?: string[];
};

type CommandEntry = { name: string; description: string };

type HelpPage = {
	path: string[];
	description: string;
	usage: string;
	options?: string;
	commands?: CommandEntry[];
};

type CommandSpec = {
	combinedOptions: Record<string, string[]>;
	root: { usage: string[]; commands: CommandEntry[] };
	pages: HelpPage[];
};

const optionSets = optionSpecJson as unknown as Record<string, OptionEntry[]>;
const commandSpec = commandSpecJson as unknown as CommandSpec;

/** Mirrors `render_options`: a left-aligned OPTIONS block. */
function renderOptions(options: OptionEntry[]): string {
	const width = Math.max(36, ...options.map(option => option.flags.length));
	const lines = ['OPTIONS:'];
	for (const option of options) {
		let line = `  ${option.flags.padEnd(width)} ${option.description}`;
		const details: string[] = [];
		if (option.default != null) {
			details.push(`default: ${option.default}`);
		}
		if (option.choices != null && option.choices.length > 0) {
			details.push(`choices: ${option.choices.join(' | ')}`);
		}
		if (details.length > 0) {
			line += ` (${details.join(', ')})`;
		}
		lines.push(line);
	}
	return lines.join('\n');
}

/** Resolve a (possibly combined) option set name to its rendered OPTIONS block. */
function renderedOptionSet(name: string): string {
	const direct = optionSets[name];
	if (direct != null) {
		return renderOptions(direct);
	}
	const parts = commandSpec.combinedOptions[name];
	if (parts == null) {
		throw new Error(`missing option set ${name}`);
	}
	const optionLines = parts
		.flatMap(part => renderedOptionSet(part).split('\n').slice(1))
		.join('\n');
	return `OPTIONS:\n${optionLines}`;
}

function renderCommandLines(commands: CommandEntry[], minWidth: number): string[] {
	const width = Math.max(minWidth, ...commands.map(command => command.name.length));
	return commands.map(command => `  ${command.name.padEnd(width)} ${command.description}`);
}

function rootHelpText(): string {
	const lines = ['USAGE:'];
	for (const usage of commandSpec.root.usage) {
		lines.push(`  ${usage}`);
	}
	lines.push('');
	lines.push('COMMANDS:');
	lines.push(...renderCommandLines(commandSpec.root.commands, 26));
	lines.push('');
	lines.push('For more info, run any command with the `--help` flag:');
	for (const command of commandSpec.root.commands) {
		lines.push(`  ccusage ${command.name} --help`);
	}
	lines.push('');
	// Bare `ccusage` defaults to Claude daily, so show its options.
	lines.push(renderedOptionSet('claude_daily_options'));
	return lines.join('\n');
}

function commandHelp(description: string, usage: string, options: string): string {
	return [description, '', 'USAGE:', `  ${usage}`, '', options].join('\n');
}

function renderHelpPage(page: HelpPage): string {
	if (page.commands == null || page.commands.length === 0) {
		if (page.options == null) {
			throw new Error('command help pages with no subcommands require options');
		}
		return commandHelp(page.description, page.usage, renderedOptionSet(page.options));
	}
	const lines = [
		page.description,
		'',
		'USAGE:',
		`  ${page.usage}`,
		'',
		'COMMANDS:',
	];
	lines.push(...renderCommandLines(page.commands, 11));
	lines.push('');
	lines.push('For more info, run any command with the `--help` flag:');
	const prefix = page.usage.replace(/ <COMMANDS>$/, '');
	for (const command of page.commands) {
		lines.push(`  ${prefix} ${command.name} --help`);
	}
	return lines.join('\n');
}

const OPTION_TAKES_VALUE = new Set([
	'-s', '--since', '-u', '--until', '-m', '--mode', '--debug-samples', '-o', '--order',
	'-z', '--timezone', '-q', '--jq', '--config', '-p', '--project', '--project-aliases',
	'-w', '--start-of-week', '-i', '--id', '-t', '--token-limit', '-n', '--session-length',
	'-B', '--visual-burn-rate', '--cost-source', '--refresh-interval',
	'--context-low-threshold', '--context-medium-threshold', '--speed',
]);

/** Mirrors `parser::command_tokens`: positional tokens with flags/values removed. */
export function commandTokens(args: string[]): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (arg.startsWith('-')) {
			index += OPTION_TAKES_VALUE.has(arg) && !arg.includes('=') ? 2 : 1;
			continue;
		}
		tokens.push(arg);
		index += 1;
	}
	return tokens;
}

function findHelpPage(tokens: string[]): HelpPage | undefined {
	return commandSpec.pages.find(
		page => page.path.length === tokens.length
			&& page.path.every((expected, i) => expected === tokens[i]),
	);
}

/** Help text for the given args (already stripped of the program name). */
export function helpTextForArgs(args: string[]): string {
	const tokens = commandTokens(args);
	const page = findHelpPage(tokens);
	return page == null ? rootHelpText() : renderHelpPage(page);
}

export function versionText(version: string): string {
	return `ccusage ${version}`;
}
