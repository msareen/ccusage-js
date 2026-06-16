/** CLI error types mirroring the two Rust error paths.
 *
 * - `ParseError` mirrors `Cli::parse` failures: the message is printed followed
 *   by the usage hint and the process exits with code 2.
 * - `CliError` mirrors `main() -> Result<(), CliError>`: Rust prints the error
 *   with its `Debug` impl as `Error: CliError("…")` and exits with code 1. */

export class ParseError extends Error {}

export class CliError extends Error {}

/** Reproduce Rust's `{:?}` formatting of a `String`. */
function rustDebugString(value: string): string {
	let out = '"';
	for (const ch of value) {
		switch (ch) {
			case '\\': out += '\\\\'; break;
			case '"': out += '\\"'; break;
			case '\n': out += '\\n'; break;
			case '\r': out += '\\r'; break;
			case '\t': out += '\\t'; break;
			case '\0': out += '\\0'; break;
			default: {
				const code = ch.codePointAt(0)!;
				// Rust escapes C0/C1 control characters; printable chars (incl. emoji) stay literal.
				if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
					out += `\\u{${code.toString(16)}}`;
				}
				else {
					out += ch;
				}
			}
		}
	}
	out += '"';
	return out;
}

/** The exact stderr text Rust prints for a `CliError` returned from `main`. */
export function cliErrorDisplay(message: string): string {
	return `Error: CliError(${rustDebugString(message)})`;
}
