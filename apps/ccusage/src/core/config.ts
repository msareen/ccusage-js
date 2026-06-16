/** Config-file discovery and option merging, ported from `config.rs` +
 * the `from_map` extractors in `config_schema.rs`.
 *
 * Config values act as defaults applied before CLI flags, layered most-general
 * to most-specific (defaults → command → agent → agent:command). */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { SharedArgs, WeekDay } from './options.ts';
import type { CostMode } from './types.ts';
import type { PricingOverride } from './pricing.ts';
import type { CodexSpeed } from '../adapter/codex/speed.ts';
import type { CostSource, StatuslineArgs, VisualBurnRate } from '../commands/statusline.ts';
import { normalizeDateBound } from './options.ts';

type JsonObject = Record<string, unknown>;

/** Args common enough to be mutated by the agent-specific config layer. */
export type DailyArgs = {
	shared: SharedArgs;
	instances: boolean;
	project?: string;
	projectAliases?: string;
};

export type WeeklyArgs = { shared: SharedArgs; startOfWeek: WeekDay };

export type BlocksArgs = {
	shared: SharedArgs;
	active: boolean;
	recent: boolean;
	tokenLimit?: string;
	sessionLength: number;
};

const AGENT_COMMANDS = new Set([
	'claude', 'codex', 'opencode', 'amp', 'droid', 'codebuff', 'hermes', 'pi',
	'goose', 'kilo', 'qwen', 'copilot', 'gemini', 'kimi', 'openclaw',
]);

const REPORT_COMMANDS = new Set([
	'daily', 'monthly', 'weekly', 'session', 'blocks', 'statusline',
]);

type ConfigCommand = { raw: string; agent?: string; report: string };

export class ConfigContext {
	private readonly value: JsonObject | undefined;
	private readonly command: ConfigCommand;

	private constructor(value: JsonObject | undefined, command: ConfigCommand) {
		this.value = value;
		this.command = command;
	}

	static fromArgs(args: string[]): ConfigContext {
		const command = detectConfigCommand(args);
		const value = loadConfigValue(scanConfigPath(args));
		return new ConfigContext(value, command);
	}

	/** Internal constructor for tests. */
	static forTest(value: JsonObject, command: ConfigCommand): ConfigContext {
		return new ConfigContext(value, command);
	}

	optionMaps(): JsonObject[] {
		const maps: JsonObject[] = [];
		const root = this.value;
		if (root == null) {
			return maps;
		}
		const defaults = objectAt(root, 'defaults');
		if (defaults != null) {
			maps.push(defaults);
		}
		const commands = objectAt(root, 'commands');
		if (commands != null) {
			const raw = objectAt(commands, this.command.raw);
			if (raw != null) {
				maps.push(raw);
			}
			if (this.command.agent != null) {
				const report = objectAt(commands, this.command.report);
				if (report != null) {
					maps.push(report);
				}
				const colonName = `${this.command.agent}:${this.command.report}`;
				const agentReport = objectAt(commands, colonName);
				if (agentReport != null) {
					maps.push(agentReport);
				}
			}
		}
		const agent = this.command.agent != null ? objectAt(root, this.command.agent) : undefined;
		if (agent != null) {
			const agentDefaults = objectAt(agent, 'defaults');
			if (agentDefaults != null) {
				maps.push(agentDefaults);
			}
			const agentCommands = objectAt(agent, 'commands');
			const command = agentCommands != null ? objectAt(agentCommands, this.command.report) : undefined;
			if (command != null) {
				maps.push(command);
			}
		}
		return maps;
	}
}

function objectAt(object: JsonObject, key: string): JsonObject | undefined {
	const value = object[key];
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function loadConfigValue(explicit: string | undefined): JsonObject | undefined {
	const paths = explicit != null ? [explicit] : discoverConfigPaths();
	for (const p of paths) {
		let content: string;
		try {
			content = readFileSync(p, 'utf8');
		}
		catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		}
		catch {
			continue;
		}
		if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as JsonObject;
		}
	}
	return undefined;
}

function discoverConfigPaths(): string[] {
	const paths: string[] = [];
	paths.push(path.join(process.cwd(), '.ccusage', 'ccusage.json'));
	for (const dir of claudeConfigDirs()) {
		paths.push(path.join(dir, 'ccusage.json'));
	}
	return paths;
}

function claudeConfigDirs(): string[] {
	const env = process.env.CLAUDE_CONFIG_DIR;
	if (env != null) {
		return env.split(',').map(s => s.trim()).filter(s => s.length > 0);
	}
	const home = homedir();
	return [path.join(home, '.config', 'claude'), path.join(home, '.claude')];
}

function scanConfigPath(args: string[]): string | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		const eq = arg.indexOf('=');
		if (eq >= 0) {
			const flag = arg.slice(0, eq);
			const value = arg.slice(eq + 1);
			if (flag === '--config' && value.length > 0) {
				return value;
			}
		}
		else if (arg === '--config') {
			return args[index + 1];
		}
		index += 1;
	}
	return undefined;
}

function detectConfigCommand(args: string[]): ConfigCommand {
	const tokens = commandTokens(args);
	const first = tokens[0];
	if (first == null) {
		return { raw: 'daily', report: 'daily' };
	}
	const colon = first.indexOf(':');
	if (colon >= 0) {
		const agent = first.slice(0, colon);
		const report = first.slice(colon + 1);
		return { raw: `${agent} ${report}`, agent, report };
	}
	if (AGENT_COMMANDS.has(first)) {
		const candidate = tokens[1];
		const report = candidate != null && REPORT_COMMANDS.has(candidate) ? candidate : 'daily';
		return { raw: `${first} ${report}`, agent: first, report };
	}
	return { raw: first, report: first };
}

const OPTION_TAKES_VALUE = new Set([
	'-s', '--since', '-u', '--until', '-m', '--mode', '--debug-samples', '-o', '--order',
	'-z', '--timezone', '-q', '--jq', '--config', '-t', '--token-limit', '-n', '--session-length',
	'-w', '--start-of-week', '-p', '--project', '--project-aliases', '--speed',
	'-B', '--visual-burn-rate', '--cost-source', '--refresh-interval',
	'--context-low-threshold', '--context-medium-threshold',
]);

/** Mirrors the config-side `command_tokens` (its option list differs slightly from the parser's). */
function commandTokens(args: string[]): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		const eq = arg.indexOf('=');
		if (eq >= 0) {
			const flag = arg.slice(0, eq);
			if (flag.startsWith('-')) {
				index += 1;
				continue;
			}
		}
		if (arg.startsWith('-')) {
			index += OPTION_TAKES_VALUE.has(arg) ? 2 : 1;
			continue;
		}
		tokens.push(arg);
		index += 1;
	}
	return tokens;
}

// --- typed option extractors (mirror config_schema `from_map`) ---

function stringOption(map: JsonObject, key: string): string | undefined {
	const value = map[key];
	return typeof value === 'string' ? value : undefined;
}

function boolOption(map: JsonObject, key: string): boolean | undefined {
	const value = map[key];
	return typeof value === 'boolean' ? value : undefined;
}

function numberOption(map: JsonObject, key: string): number | undefined {
	const value = map[key];
	return typeof value === 'number' ? value : undefined;
}

function enumOption<T extends string>(map: JsonObject, key: string, allowed: readonly T[]): T | undefined {
	const value = map[key];
	return typeof value === 'string' && (allowed as readonly string[]).includes(value)
		? value as T
		: undefined;
}

const COST_MODES = ['auto', 'calculate', 'display'] as const;
const SORT_ORDERS = ['desc', 'asc'] as const;
const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const CODEX_SPEEDS = ['auto', 'standard', 'fast'] as const;
const VISUAL_BURN_RATES = ['off', 'emoji', 'text', 'emoji-text'] as const;
const COST_SOURCES = ['auto', 'ccusage', 'cc', 'both'] as const;

// Config JSON keys (camelCase) → `PricingOverride` fields (snake_case).
const PRICING_FIELDS: Record<string, keyof PricingOverride> = {
	inputCostPerToken: 'input_cost_per_token',
	outputCostPerToken: 'output_cost_per_token',
	cacheCreationInputTokenCost: 'cache_creation_input_token_cost',
	cacheReadInputTokenCost: 'cache_read_input_token_cost',
	inputCostPerTokenAbove200kTokens: 'input_cost_per_token_above_200k_tokens',
	outputCostPerTokenAbove200kTokens: 'output_cost_per_token_above_200k_tokens',
	cacheCreationInputTokenCostAbove200kTokens: 'cache_creation_input_token_cost_above_200k_tokens',
	cacheReadInputTokenCostAbove200kTokens: 'cache_read_input_token_cost_above_200k_tokens',
	maxInputTokens: 'max_input_tokens',
	fastMultiplier: 'fast_multiplier',
};

function pricingOverrideMapOption(map: JsonObject, key: string): Map<string, PricingOverride> | undefined {
	const raw = objectAt(map, key);
	if (raw == null) {
		return undefined;
	}
	const result = new Map<string, PricingOverride>();
	for (const [model, value] of Object.entries(raw)) {
		if (value == null || typeof value !== 'object') {
			continue;
		}
		const override: PricingOverride = {};
		for (const [jsonKey, field] of Object.entries(PRICING_FIELDS)) {
			const n = (value as JsonObject)[jsonKey];
			if (typeof n === 'number') {
				(override as Record<string, number>)[field] = n;
			}
		}
		result.set(model, override);
	}
	return result;
}

function modelLabelAliasesOption(map: JsonObject, key: string): Map<string, string> | undefined {
	const raw = objectAt(map, key);
	if (raw == null) {
		return undefined;
	}
	const result = new Map<string, string>();
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === 'string') {
			result.set(k, v);
		}
	}
	return result.size === 0 ? undefined : result;
}

// --- apply functions (mirror config.rs) ---

function applySharedOptions(shared: SharedArgs, options: JsonObject): void {
	const since = stringOption(options, 'since');
	if (since != null) {
		shared.since = normalizeDateBound(since);
	}
	const until = stringOption(options, 'until');
	if (until != null) {
		shared.until = normalizeDateBound(until);
	}
	const json = boolOption(options, 'json');
	if (json != null) {
		shared.json = json;
	}
	const mode = enumOption<CostMode>(options, 'mode', COST_MODES);
	if (mode != null) {
		shared.mode = mode;
	}
	const debug = boolOption(options, 'debug');
	if (debug != null) {
		shared.debug = debug;
	}
	const debugSamples = numberOption(options, 'debugSamples');
	if (debugSamples != null && Number.isInteger(debugSamples) && debugSamples >= 0) {
		shared.debugSamples = debugSamples;
	}
	const order = enumOption(options, 'order', SORT_ORDERS);
	if (order != null) {
		shared.order = order;
	}
	const breakdown = boolOption(options, 'breakdown');
	if (breakdown != null) {
		shared.breakdown = breakdown;
	}
	const offline = boolOption(options, 'offline');
	if (offline != null) {
		shared.offline = offline;
	}
	const noOffline = boolOption(options, 'noOffline');
	if (noOffline != null) {
		shared.noOffline = noOffline;
	}
	const color = boolOption(options, 'color');
	if (color != null) {
		shared.color = color;
	}
	const noColor = boolOption(options, 'noColor');
	if (noColor != null) {
		shared.noColor = noColor;
	}
	const timezone = stringOption(options, 'timezone');
	if (timezone != null) {
		shared.timezone = timezone;
	}
	const jq = stringOption(options, 'jq');
	if (jq != null) {
		shared.jq = jq;
	}
	const compact = boolOption(options, 'compact');
	if (compact != null) {
		shared.compact = compact;
	}
	const singleThread = boolOption(options, 'singleThread');
	if (singleThread != null) {
		shared.singleThread = singleThread;
	}
	const noCost = boolOption(options, 'noCost');
	if (noCost != null) {
		shared.noCost = noCost;
	}
	const pricingOverrides = pricingOverrideMapOption(options, 'pricingOverrides');
	if (pricingOverrides != null) {
		mergePricingOverrides(shared.pricingOverrides, pricingOverrides);
	}
}

function mergePricingOverrides(
	current: Map<string, PricingOverride>,
	incoming: Map<string, PricingOverride>,
): void {
	for (const [model, override] of incoming) {
		const entry = current.get(model) ?? {};
		for (const field of Object.values(PRICING_FIELDS)) {
			const value = (override as Record<string, number | undefined>)[field];
			if (value != null) {
				(entry as Record<string, number>)[field] = value;
			}
		}
		current.set(model, entry);
	}
}

export function applyConfigToShared(shared: SharedArgs, config: ConfigContext): void {
	for (const options of config.optionMaps()) {
		applySharedOptions(shared, options);
	}
}

export function applyConfigToDailyArgs(args: DailyArgs, config: ConfigContext): void {
	for (const options of config.optionMaps()) {
		const instances = boolOption(options, 'instances');
		if (instances != null) {
			args.instances = instances;
		}
		const project = stringOption(options, 'project');
		if (project != null) {
			args.project = project;
		}
		const projectAliases = stringOption(options, 'projectAliases');
		if (projectAliases != null) {
			args.projectAliases = projectAliases;
		}
	}
}

export function applyConfigToWeeklyArgs(args: WeeklyArgs, config: ConfigContext): void {
	for (const options of config.optionMaps()) {
		const day = enumOption<WeekDay>(options, 'startOfWeek', WEEK_DAYS);
		if (day != null) {
			args.startOfWeek = day;
		}
	}
}

export function applyConfigToBlocksArgs(args: BlocksArgs, config: ConfigContext): void {
	for (const options of config.optionMaps()) {
		const active = boolOption(options, 'active');
		if (active != null) {
			args.active = active;
		}
		const recent = boolOption(options, 'recent');
		if (recent != null) {
			args.recent = recent;
		}
		const tokenLimit = stringOption(options, 'tokenLimit');
		if (tokenLimit != null) {
			args.tokenLimit = tokenLimit;
		}
		const sessionLength = numberOption(options, 'sessionLength');
		if (sessionLength != null) {
			args.sessionLength = sessionLength;
		}
	}
}

export function applyConfigToStatuslineArgs(args: StatuslineArgs, config: ConfigContext): void {
	for (const options of config.optionMaps()) {
		const offline = boolOption(options, 'offline');
		if (offline != null) {
			args.offline = offline;
		}
		const noOffline = boolOption(options, 'noOffline');
		if (noOffline != null) {
			args.noOffline = noOffline;
		}
		const visualBurnRate = enumOption<VisualBurnRate>(options, 'visualBurnRate', VISUAL_BURN_RATES);
		if (visualBurnRate != null) {
			args.visualBurnRate = visualBurnRate;
		}
		const costSource = enumOption<CostSource>(options, 'costSource', COST_SOURCES);
		if (costSource != null) {
			args.costSource = costSource;
		}
		const cache = boolOption(options, 'cache');
		if (cache != null) {
			args.cache = cache;
		}
		const noCache = boolOption(options, 'noCache');
		if (noCache != null) {
			args.noCache = noCache;
		}
		const refreshInterval = numberOption(options, 'refreshInterval');
		if (refreshInterval != null && Number.isInteger(refreshInterval) && refreshInterval >= 0) {
			args.refreshInterval = refreshInterval;
		}
		const low = numberOption(options, 'contextLowThreshold');
		if (low != null && Number.isInteger(low) && low >= 0 && low <= 255) {
			args.contextLowThreshold = low;
		}
		const medium = numberOption(options, 'contextMediumThreshold');
		if (medium != null && Number.isInteger(medium) && medium >= 0 && medium <= 255) {
			args.contextMediumThreshold = medium;
		}
		const timezone = stringOption(options, 'timezone');
		if (timezone != null) {
			args.timezone = timezone;
		}
		const debug = boolOption(options, 'debug');
		if (debug != null) {
			args.debug = debug;
		}
		const aliases = modelLabelAliasesOption(options, 'modelLabelAliases');
		if (aliases != null) {
			args.modelLabelAliases = aliases;
		}
	}
}

export function applyConfigToAgentArgs(
	codexSpeed: { value: CodexSpeed },
	config: ConfigContext,
): void {
	for (const options of config.optionMaps()) {
		const speed = enumOption<CodexSpeed>(options, 'speed', CODEX_SPEEDS);
		if (speed != null) {
			codexSpeed.value = speed;
		}
	}
}
