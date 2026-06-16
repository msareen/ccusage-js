/** Argument parser ported from `ccusage-cli/src/parser.rs` + `arg_parser.rs`.
 *
 * Produces a `Cli { command, shared }` or throws `ParseError`. Config values are
 * applied as defaults (before flags) via the `ConfigContext` apply functions. */
import type { SharedArgs, SortOrder, WeekDay } from '../core/options.ts';
import { defaultSharedArgs, normalizeDateBound } from '../core/options.ts';
import type { CostMode } from '../core/types.ts';
import type { CodexSpeed } from '../adapter/codex/speed.ts';
import type { CostSource, StatuslineArgs, VisualBurnRate } from '../commands/statusline.ts';
import { defaultStatuslineArgs } from '../commands/statusline.ts';
import { ParseError } from './errors.ts';
import {
	ConfigContext,
	applyConfigToAgentArgs,
	applyConfigToBlocksArgs,
	applyConfigToDailyArgs,
	applyConfigToShared,
	applyConfigToStatuslineArgs,
	applyConfigToWeeklyArgs,
	type BlocksArgs,
	type DailyArgs,
	type WeeklyArgs,
} from '../core/config.ts';

export type { BlocksArgs, DailyArgs, WeeklyArgs };

export type AgentReportKind = 'daily' | 'weekly' | 'monthly' | 'session';

export type AgentName = 'codex' | 'gemini';

export type AgentCommandArgs = {
	shared: SharedArgs;
	kind: AgentReportKind;
	codexSpeed: CodexSpeed;
};

export type SessionArgs = { shared: SharedArgs; id?: string };

export type Command =
	| { tag: 'Daily'; value: DailyArgs }
	| { tag: 'Monthly'; value: SharedArgs }
	| { tag: 'Weekly'; value: WeeklyArgs }
	| { tag: 'Session'; value: SessionArgs }
	| { tag: 'Blocks'; value: BlocksArgs }
	| { tag: 'Statusline'; value: StatuslineArgs }
	| { tag: 'Agent'; agent: AgentName; value: AgentCommandArgs };

export type Cli = { command: Command | undefined; shared: SharedArgs };

/** Result of parsing: a runnable CLI, or a control action (help/version) that
 * Rust handles by printing and exiting before building the command. */
export type ParseResult =
	| { kind: 'cli'; cli: Cli }
	| { kind: 'help'; args: string[] }
	| { kind: 'version' };

const STANDARD_AGENT_REPORTS: [string, AgentReportKind][] = [
	['daily', 'daily'], ['monthly', 'monthly'], ['session', 'session'],
];

class ArgParser {
	args: string[];
	private index = 0;
	private pendingValue: string | undefined;

	constructor(args: string[]) {
		this.args = args;
	}

	peek(): string | undefined {
		return this.args[this.index];
	}

	next(): string | undefined {
		const value = this.args[this.index];
		if (value !== undefined) {
			this.index += 1;
		}
		return value;
	}

	nextFlag(): string {
		this.pendingValue = undefined;
		const arg = this.next();
		if (arg === undefined) {
			throw new ParseError('Expected option but reached end of arguments');
		}
		const eq = arg.indexOf('=');
		if (eq >= 0) {
			const flag = arg.slice(0, eq);
			if (!flag.startsWith('-')) {
				throw new ParseError(`Expected option, got '${arg}'`);
			}
			this.pendingValue = arg.slice(eq + 1);
			return flag;
		}
		if (arg.startsWith('-')) {
			return arg;
		}
		throw new ParseError(`Expected option, got '${arg}'`);
	}

	valueFor(flag: string): string {
		if (this.pendingValue !== undefined) {
			const value = this.pendingValue;
			this.pendingValue = undefined;
			if (value.length === 0) {
				throw new ParseError(`Missing value for ${flag}`);
			}
			return value;
		}
		const value = this.next();
		if (value === undefined || value.startsWith('-')) {
			throw new ParseError(`Missing value for ${flag}`);
		}
		return value;
	}
}

const COMMANDS = new Set([
	'daily', 'monthly', 'weekly', 'session', 'blocks', 'statusline', 'claude', 'codex', 'gemini',
]);

const AGENT_COMMANDS = new Set(['claude', 'codex', 'gemini']);

function isCommand(arg: string): boolean {
	return COMMANDS.has(arg);
}

const SHARED_FLAGS = new Set([
	'-s', '--since', '-u', '--until', '-j', '--json', '-m', '--mode', '-d', '--debug',
	'--debug-samples', '-o', '--order', '-b', '--breakdown', '-O', '--offline', '--no-offline',
	'--color', '--no-color', '-z', '--timezone', '-q', '--jq', '--config', '--compact',
	'--single-thread', '--no-cost',
]);

function isSharedFlag(arg: string): boolean {
	const eq = arg.indexOf('=');
	const name = eq >= 0 ? arg.slice(0, eq) : arg;
	return SHARED_FLAGS.has(name);
}

const OPTION_TAKES_VALUE = new Set([
	'-s', '--since', '-u', '--until', '-m', '--mode', '--debug-samples', '-o', '--order',
	'-z', '--timezone', '-q', '--jq', '--config', '-p', '--project', '--project-aliases',
	'-w', '--start-of-week', '-i', '--id', '-t', '--token-limit', '-n', '--session-length',
	'-B', '--visual-burn-rate', '--cost-source', '--refresh-interval',
	'--context-low-threshold', '--context-medium-threshold', '--speed',
]);

/** Mirrors `parser::command_tokens`. */
function commandTokens(args: string[]): string[] {
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

const AGENT_DISPLAY_NAMES: Record<string, string> = {
	claude: 'Claude Code',
	codex: 'Codex',
	gemini: 'Gemini CLI',
};

function agentReportSupported(agent: string, report: string): boolean {
	switch (agent) {
		case 'claude':
			return ['daily', 'weekly', 'monthly', 'session', 'blocks', 'statusline'].includes(report);
		case 'codex': case 'gemini':
			return ['daily', 'monthly', 'session'].includes(report);
		default:
			return false;
	}
}

// --- pre-parse semantic validation (mirrors parser.rs free functions) ---

function normalizeLegacyAgentCommandArgs(args: string[]): void {
	const command = args[0];
	if (command == null) {
		return;
	}
	const colon = command.indexOf(':');
	if (colon < 0) {
		return;
	}
	const agent = command.slice(0, colon);
	const report = command.slice(colon + 1);
	if (!agentReportSupported(agent, report)) {
		return;
	}
	args.splice(0, 1, agent, report);
}

function reportFlagAliasError(args: string[]): string | undefined {
	const flag = args.find(arg =>
		['--daily', '--weekly', '--monthly', '--session', '--blocks', '--statusline'].includes(arg),
	);
	if (flag == null) {
		return undefined;
	}
	return `Report flags like ${flag} are not supported. Use "ccusage ${flag.replace(/^--/, '')}" instead.`;
}

function blocksCommandTokens(args: string[]): boolean {
	const tokens = commandTokens(args);
	return (tokens.length >= 1 && tokens[0] === 'blocks')
		|| (tokens.length >= 2 && tokens[0] === 'claude' && tokens[1] === 'blocks');
}

function agentFilterOptionError(args: string[]): string | undefined {
	const allowsShortActive = blocksCommandTokens(args);
	let flag: string | undefined;
	for (const arg of args) {
		if (arg === '--agent' || arg.startsWith('--agent=')) {
			flag = '--agent';
			break;
		}
		if ((arg === '-a' && !allowsShortActive) || arg.startsWith('-a=')) {
			flag = '-a';
			break;
		}
	}
	if (flag == null) {
		return undefined;
	}
	return `Agent filters like ${flag} are not supported. Use "ccusage <agent> <report>", for example "ccusage codex daily".`;
}

function unsupportedAgentReportError(args: string[]): string | undefined {
	const tokens = commandTokens(args);
	if (tokens.length < 2) {
		return undefined;
	}
	const [agent, report] = tokens as [string, string];
	if (!AGENT_COMMANDS.has(agent) || agentReportSupported(agent, report)) {
		return undefined;
	}
	const display = AGENT_DISPLAY_NAMES[agent]!;
	if (report === 'blocks' || report === 'statusline') {
		return `The "${report}" report is only available for Claude Code usage.\nUse "ccusage ${agent} daily" for ${display} usage reports.`;
	}
	return `The "${report}" report is not available for ${display} usage.\nUse "ccusage ${agent} daily" for ${display} usage reports.`;
}

// --- value parsers ---

function parseCostMode(value: string): CostMode {
	if (value === 'auto' || value === 'calculate' || value === 'display') {
		return value;
	}
	throw new ParseError(`Invalid cost mode '${value}'`);
}

function parseSortOrder(value: string): SortOrder {
	if (value === 'asc' || value === 'desc') {
		return value;
	}
	throw new ParseError(`Invalid sort order '${value}'`);
}

function parseWeekDay(value: string): WeekDay {
	const days: WeekDay[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
	if ((days as string[]).includes(value)) {
		return value as WeekDay;
	}
	throw new ParseError(`Invalid week day '${value}'`);
}

function parseCodexSpeed(value: string): CodexSpeed {
	if (value === 'auto' || value === 'standard' || value === 'fast') {
		return value;
	}
	throw new ParseError(`Invalid speed option '${value}'`);
}

function parseVisualBurnRate(value: string): VisualBurnRate {
	if (value === 'off' || value === 'emoji' || value === 'text' || value === 'emoji-text') {
		return value;
	}
	throw new ParseError(`Invalid visual burn rate '${value}'`);
}

function parseCostSource(value: string): CostSource {
	if (value === 'auto' || value === 'ccusage' || value === 'cc' || value === 'both') {
		return value;
	}
	throw new ParseError(`Invalid cost source '${value}'`);
}

function parseIntValue(value: string, flag: string): number {
	// Rust `str::parse::<u64/u8>` rejects non-integers, signs handled per-type; mimic strict integer.
	if (!/^\d+$/.test(value)) {
		throw new ParseError(`Invalid value for ${flag}`);
	}
	return Number.parseInt(value, 10);
}

function parseFloatValue(value: string, flag: string): number {
	const parsed = Number(value);
	if (value.trim() === '' || !Number.isFinite(parsed)) {
		throw new ParseError(`Invalid value for ${flag}`);
	}
	return parsed;
}

function parseSharedArg(parser: ArgParser, shared: SharedArgs): void {
	const flag = parser.nextFlag();
	switch (flag) {
		case '-s': case '--since': shared.since = normalizeDateBound(parser.valueFor('--since')); break;
		case '-u': case '--until': shared.until = normalizeDateBound(parser.valueFor('--until')); break;
		case '-j': case '--json': shared.json = true; break;
		case '-m': case '--mode': shared.mode = parseCostMode(parser.valueFor('--mode')); break;
		case '-d': case '--debug': shared.debug = true; break;
		case '--debug-samples': shared.debugSamples = parseIntValue(parser.valueFor('--debug-samples'), '--debug-samples'); break;
		case '-o': case '--order': shared.order = parseSortOrder(parser.valueFor('--order')); break;
		case '-b': case '--breakdown': shared.breakdown = true; break;
		case '-O': case '--offline': shared.offline = true; break;
		case '--no-offline': shared.noOffline = true; break;
		case '--color': shared.color = true; break;
		case '--no-color': shared.noColor = true; break;
		case '-z': case '--timezone': shared.timezone = parser.valueFor('--timezone'); break;
		case '-q': case '--jq': shared.jq = parser.valueFor('--jq'); break;
		case '--config': shared.config = parser.valueFor('--config'); break;
		case '--compact': shared.compact = true; break;
		case '--single-thread': shared.singleThread = true; break;
		case '--no-cost': shared.noCost = true; break;
		default: throw new ParseError(`Unknown option '${flag}'`);
	}
}

function parseSharedArgForCommand(parser: ArgParser, shared: SharedArgs): boolean {
	const arg = parser.peek();
	if (arg == null) {
		return false;
	}
	if (isSharedFlag(arg)) {
		parseSharedArg(parser, shared);
		return true;
	}
	return false;
}

function parseAgentReportKind(
	parser: ArgParser,
	agent: string,
	reports: [string, AgentReportKind][],
): AgentReportKind {
	const command = parser.peek();
	if (command == null) {
		return 'daily';
	}
	const match = reports.find(([report]) => report === command);
	if (match != null) {
		parser.next();
		return match[1];
	}
	if (!command.startsWith('-')) {
		throw new ParseError(`Unknown ${agent} command '${command}'`);
	}
	return 'daily';
}

function newAgentArgs(shared: SharedArgs, kind: AgentReportKind): AgentCommandArgs {
	return { shared, kind, codexSpeed: 'auto' };
}

function parseBasicAgentCommand(
	parser: ArgParser,
	shared: SharedArgs,
	agent: AgentName,
	reports: [string, AgentReportKind][],
): Command {
	const kind = parseAgentReportKind(parser, agent, reports);
	while (parser.peek() != null) {
		parseSharedArg(parser, shared);
	}
	return { tag: 'Agent', agent, value: newAgentArgs(shared, kind) };
}

function parseCodexCommand(parser: ArgParser, shared: SharedArgs, config: ConfigContext): Command {
	const kind = parseAgentReportKind(parser, 'codex', STANDARD_AGENT_REPORTS);
	const speed = { value: 'auto' as CodexSpeed };
	applyConfigToAgentArgs(speed, config);
	while (parser.peek() != null) {
		if (parseSharedArgForCommand(parser, shared)) {
			continue;
		}
		const flag = parser.nextFlag();
		if (flag === '--speed') {
			speed.value = parseCodexSpeed(parser.valueFor('--speed'));
		}
		else {
			throw new ParseError(`Unknown codex option '${flag}'`);
		}
	}
	return { tag: 'Agent', agent: 'codex', value: { shared, kind, codexSpeed: speed.value } };
}

function parseClaudeDailyCommand(parser: ArgParser, shared: SharedArgs, config: ConfigContext): Command {
	const args: DailyArgs = { shared, instances: false };
	applyConfigToDailyArgs(args, config);
	while (parser.peek() != null) {
		if (parseSharedArgForCommand(parser, args.shared)) {
			continue;
		}
		const flag = parser.nextFlag();
		switch (flag) {
			case '-i': case '--instances': args.instances = true; break;
			case '-p': case '--project': args.project = parser.valueFor('--project'); break;
			case '--project-aliases': args.projectAliases = parser.valueFor('--project-aliases'); break;
			default: throw new ParseError(`Unknown daily option '${flag}'`);
		}
	}
	return { tag: 'Daily', value: args };
}

function parseClaudeMonthlyCommand(parser: ArgParser, shared: SharedArgs): Command {
	while (parser.peek() != null) {
		parseSharedArg(parser, shared);
	}
	return { tag: 'Monthly', value: shared };
}

function parseClaudeWeeklyCommand(parser: ArgParser, shared: SharedArgs, config: ConfigContext): Command {
	const args: WeeklyArgs = { shared, startOfWeek: 'sunday' };
	applyConfigToWeeklyArgs(args, config);
	while (parser.peek() != null) {
		if (parseSharedArgForCommand(parser, args.shared)) {
			continue;
		}
		const flag = parser.nextFlag();
		if (flag === '-w' || flag === '--start-of-week') {
			args.startOfWeek = parseWeekDay(parser.valueFor('--start-of-week'));
		}
		else {
			throw new ParseError(`Unknown weekly option '${flag}'`);
		}
	}
	return { tag: 'Weekly', value: args };
}

function parseClaudeSessionCommand(parser: ArgParser, shared: SharedArgs): Command {
	const args: SessionArgs = { shared };
	while (parser.peek() != null) {
		if (parseSharedArgForCommand(parser, args.shared)) {
			continue;
		}
		const flag = parser.nextFlag();
		if (flag === '-i' || flag === '--id') {
			args.id = parser.valueFor('--id');
		}
		else {
			throw new ParseError(`Unknown session option '${flag}'`);
		}
	}
	return { tag: 'Session', value: args };
}

function parseBlocksCommand(
	parser: ArgParser,
	shared: SharedArgs,
	config: ConfigContext,
	defaultSessionDurationHours: number,
): Command {
	const args: BlocksArgs = { shared, active: false, recent: false, sessionLength: defaultSessionDurationHours };
	applyConfigToBlocksArgs(args, config);
	while (parser.peek() != null) {
		if (parseSharedArgForCommand(parser, args.shared)) {
			continue;
		}
		const flag = parser.nextFlag();
		switch (flag) {
			case '-a': case '--active': args.active = true; break;
			case '-r': case '--recent': args.recent = true; break;
			case '-t': case '--token-limit': args.tokenLimit = parser.valueFor('--token-limit'); break;
			case '-n': case '--session-length':
				args.sessionLength = parseFloatValue(parser.valueFor('--session-length'), '--session-length');
				break;
			default: throw new ParseError(`Unknown blocks option '${flag}'`);
		}
	}
	return { tag: 'Blocks', value: args };
}

function parseStatuslineCommand(parser: ArgParser, config: ConfigContext): Command {
	const args = defaultStatuslineArgs();
	applyConfigToStatuslineArgs(args, config);
	while (parser.peek() != null) {
		const flag = parser.nextFlag();
		switch (flag) {
			case '-O': case '--offline': args.offline = true; break;
			case '--no-offline': args.noOffline = true; break;
			case '-B': case '--visual-burn-rate':
				args.visualBurnRate = parseVisualBurnRate(parser.valueFor('--visual-burn-rate'));
				break;
			case '--cost-source':
				args.costSource = parseCostSource(parser.valueFor('--cost-source'));
				break;
			case '--cache': args.cache = true; break;
			case '--no-cache': args.noCache = true; break;
			case '--refresh-interval':
				args.refreshInterval = parseIntValue(parser.valueFor('--refresh-interval'), '--refresh-interval');
				break;
			case '--context-low-threshold':
				args.contextLowThreshold = parseIntValue(parser.valueFor('--context-low-threshold'), '--context-low-threshold');
				break;
			case '--context-medium-threshold':
				args.contextMediumThreshold = parseIntValue(parser.valueFor('--context-medium-threshold'), '--context-medium-threshold');
				break;
			case '-z': case '--timezone': args.timezone = parser.valueFor('--timezone'); break;
			case '--config': args.config = parser.valueFor('--config'); break;
			case '--debug': args.debug = true; break;
			default: throw new ParseError(`Unknown statusline option '${flag}'`);
		}
	}
	return { tag: 'Statusline', value: args };
}

function parseClaudeCommand(
	parser: ArgParser,
	shared: SharedArgs,
	config: ConfigContext,
	defaultSessionDurationHours: number,
): Command {
	const peeked = parser.peek();
	let command: string;
	if (peeked != null && ['daily', 'monthly', 'weekly', 'session', 'blocks', 'statusline'].includes(peeked)) {
		command = peeked;
		parser.next();
	}
	else if (peeked != null && !peeked.startsWith('-')) {
		throw new ParseError(`Unknown claude command '${peeked}'`);
	}
	else {
		command = 'daily';
	}
	switch (command) {
		case 'daily': return parseClaudeDailyCommand(parser, shared, config);
		case 'monthly': return parseClaudeMonthlyCommand(parser, shared);
		case 'weekly': return parseClaudeWeeklyCommand(parser, shared, config);
		case 'session': return parseClaudeSessionCommand(parser, shared);
		case 'blocks': return parseBlocksCommand(parser, shared, config, defaultSessionDurationHours);
		case 'statusline': return parseStatuslineCommand(parser, config);
		default: throw new ParseError('claude command is prevalidated');
	}
}

function parseCommand(
	command: string,
	parser: ArgParser,
	shared: SharedArgs,
	config: ConfigContext,
	defaultSessionDurationHours: number,
): Command {
	// Top-level report commands map to Claude (the default agent); `all` aggregator removed.
	switch (command) {
		case 'daily': return parseClaudeDailyCommand(parser, shared, config);
		case 'monthly': return parseClaudeMonthlyCommand(parser, shared);
		case 'weekly': return parseClaudeWeeklyCommand(parser, shared, config);
		case 'session': return parseClaudeSessionCommand(parser, shared);
		case 'blocks': return parseBlocksCommand(parser, shared, config, defaultSessionDurationHours);
		case 'statusline': return parseStatuslineCommand(parser, config);
		case 'claude': return parseClaudeCommand(parser, shared, config, defaultSessionDurationHours);
		case 'codex': return parseCodexCommand(parser, shared, config);
		case 'gemini': return parseBasicAgentCommand(parser, shared, 'gemini', STANDARD_AGENT_REPORTS);
		default: throw new ParseError(`Unknown command '${command}'`);
	}
}

function controlArg(args: string[]): 'help' | 'version' | undefined {
	if (args.some(arg => arg === '-v' || arg === '-V' || arg === '--version')) {
		return 'version';
	}
	if (args.some(arg => arg === '-h' || arg === '--help')) {
		return 'help';
	}
	return undefined;
}

/** Mirrors `Cli::parse_from_with_config`. Throws `ParseError` on failure. */
export function parseFromWithConfig(
	argv: string[],
	config: ConfigContext,
	defaultSessionDurationHours: number,
): ParseResult {
	const parser = new ArgParser([...argv]);
	normalizeLegacyAgentCommandArgs(parser.args);
	const control = controlArg(parser.args);
	if (control === 'version') {
		return { kind: 'version' };
	}
	if (control === 'help') {
		return { kind: 'help', args: [...parser.args] };
	}
	const aliasError = reportFlagAliasError(parser.args);
	if (aliasError != null) {
		throw new ParseError(aliasError);
	}
	const filterError = agentFilterOptionError(parser.args);
	if (filterError != null) {
		throw new ParseError(filterError);
	}
	const reportError = unsupportedAgentReportError(parser.args);
	if (reportError != null) {
		throw new ParseError(reportError);
	}
	const shared = defaultSharedArgs();
	applyConfigToShared(shared, config);
	while (parser.peek() != null) {
		const arg = parser.peek()!;
		if (isCommand(arg)) {
			break;
		}
		if (!arg.startsWith('-')) {
			throw new ParseError(`Unknown command '${arg}'`);
		}
		parseSharedArg(parser, shared);
	}
	let command: Command | undefined;
	const next = parser.next();
	if (next != null) {
		command = parseCommand(next, parser, cloneShared(shared), config, defaultSessionDurationHours);
	}
	const extra = parser.next();
	if (extra != null) {
		throw new ParseError(`Unexpected argument '${extra}'`);
	}
	return { kind: 'cli', cli: { command, shared } };
}

/** Rust passes `shared.clone()` into the command parser; the top-level `shared`
 * is preserved for the `None` (default all) path. */
function cloneShared(shared: SharedArgs): SharedArgs {
	return { ...shared, pricingOverrides: new Map(shared.pricingOverrides) };
}

export { ConfigContext };
