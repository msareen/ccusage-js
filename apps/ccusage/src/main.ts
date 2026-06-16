#!/usr/bin/env bun
/**
 * Bun-native ccusage entry point.
 *
 * Mirrors `rust/crates/ccusage/src/{main,cli}.rs`: build a `ConfigContext` from
 * the raw args, run the ported `ccusage-cli` parser, then dispatch the parsed
 * command. Parse failures print the message + usage hint and exit 2; runtime
 * `CliError`s print `Error: CliError("…")` and exit 1.
 */
import process from 'node:process';
import { version as pkgVersion } from '../package.json' with { type: 'json' };
import { ConfigContext } from './core/config.ts';
import { CliError, ParseError, cliErrorDisplay } from './cli/errors.ts';
import { parseFromWithConfig, type Cli, type Command } from './cli/parser.ts';
import { helpTextForArgs, versionText } from './cli/help.ts';
import { runBucket, runDaily, runSession, runWeekly } from './commands/reports.ts';
import { runBlocks } from './commands/blocks.ts';
import { runStatusline } from './commands/statusline.ts';
import { runCodex } from './commands/codex.ts';
import { runAgent } from './adapter/agents.ts';

const DEFAULT_SESSION_DURATION_HOURS = 5;

async function dispatch(command: Command): Promise<void> {
	switch (command.tag) {
		case 'Daily':
			await runDaily(command.value);
			return;
		case 'Monthly':
			await runBucket(command.value, 'monthly');
			return;
		case 'Weekly':
			await runWeekly(command.value.shared, command.value.startOfWeek);
			return;
		case 'Session':
			await runSession(command.value);
			return;
		case 'Blocks':
			await runBlocks(command.value);
			return;
		case 'Statusline':
			await runStatusline(command.value);
			return;
		case 'Agent':
			if (command.agent === 'codex') {
				await runCodex(command.value.shared, command.value.kind, command.value.codexSpeed);
				return;
			}
			await runAgent(command.agent, command.value);
			return;
	}
}

async function runCli(cli: Cli): Promise<void> {
	if (cli.command == null) {
		// Bare `ccusage` (no command) => Claude daily (the default agent).
		await runDaily({ shared: cli.shared, instances: false });
		return;
	}
	await dispatch(cli.command);
}

async function main(argv: string[]): Promise<number> {
	const config = ConfigContext.fromArgs(argv);
	let result;
	try {
		result = parseFromWithConfig(argv, config, DEFAULT_SESSION_DURATION_HOURS);
	}
	catch (error) {
		if (error instanceof ParseError) {
			process.stderr.write(`${error.message}\n`);
			process.stderr.write("Run 'ccusage --help' for usage.\n");
			return 2;
		}
		throw error;
	}

	if (result.kind === 'version') {
		process.stdout.write(`${versionText(pkgVersion)}\n`);
		return 0;
	}
	if (result.kind === 'help') {
		process.stdout.write(`${helpTextForArgs(result.args)}\n`);
		return 0;
	}

	try {
		await runCli(result.cli);
	}
	catch (error) {
		if (error instanceof CliError) {
			process.stderr.write(`${cliErrorDisplay(error.message)}\n`);
			return 1;
		}
		throw error;
	}
	return 0;
}

process.exitCode = await main(process.argv.slice(2));
