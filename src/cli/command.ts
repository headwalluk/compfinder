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
  /** Writes straight to stdout, for commands that stream their output (find --input). */
  write(text: string): void;
}

/** What a command returns. With --output=json, data is printed; with text, text is. */
export interface CommandResult {
  exitCode: ExitCodeValue;
  data: Record<string, unknown>;
  text: string;
  /** True when the command already wrote its output through write(); main then prints nothing more (D-22). */
  isStreamed?: boolean;
}

export interface Command {
  /** Words that select the command, such as ["config", "show"]. */
  path: string[];
  summary: string;
  usage: string;
  /** Flags the command accepts, beyond the global ones. */
  flags: readonly string[];
  /** Positional arguments allowed after the command's words; 0 when absent. */
  maxArguments?: number;
  /** Output formats the command supports. */
  outputs: readonly OutputFormat[];
  run(context: CommandContext): Promise<CommandResult>;
}
