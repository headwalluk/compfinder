import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { ParsedArgs } from './args.js';
import type { ExitCodeValue } from './exit-codes.js';

/** Output formats selected with --output. */
export const OUTPUT_FORMATS = ['text', 'json', 'csv'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface CommandContext {
  args: ParsedArgs;
  config: Config;
  output: OutputFormat;
  logger: Logger;
  /** True when text output may use colour: config allows it and stdout is a terminal. */
  colour: boolean;
}

/** What a command returns. With --output=json, data is printed; with text, text is. */
export interface CommandResult {
  exitCode: ExitCodeValue;
  data: Record<string, unknown>;
  text: string;
}

export interface Command {
  /** Words that select the command, such as ["config", "show"]. */
  path: string[];
  summary: string;
  usage: string;
  /** Flags the command accepts, beyond the global ones. */
  flags: readonly string[];
  /** Output formats the command supports. */
  outputs: readonly OutputFormat[];
  run(context: CommandContext): Promise<CommandResult>;
}
