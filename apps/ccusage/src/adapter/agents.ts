/** Agent dispatch. Only the gemini adapter routes here; claude and codex are
 * dispatched directly in `main.ts`. */
import { CliError } from '../cli/errors.ts';
import type { AgentCommandArgs, AgentName } from '../cli/parser.ts';
import { runGemini } from './gemini/run.ts';

export async function runAgent(agent: AgentName, args: AgentCommandArgs): Promise<void> {
	switch (agent) {
		case 'gemini':
			await runGemini(args);
			return;
		default:
			throw new CliError(`agent '${agent}' is not supported`);
	}
}
