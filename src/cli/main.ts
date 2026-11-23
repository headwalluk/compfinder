import { ConfigError, SETTING_FLAGS, loadConfigFromEnvironment, type ConfigOverrides, type SettingFlag } from '../config.js';
import { createLogger } from '../logger.js';
import { packageVersion } from '../package-files.js';
import { booleanFlag, parseArgs, stringFlag, type ParsedArgs } from './args.js';
import { OUTPUT_FORMATS, type Command, type CommandResult, type OutputFormat } from './command.js';
import { configInitCommand, configPathCommand, configShowCommand } from './commands/config.js';
import { providersListCommand } from './commands/providers.js';
import { ExitCode } from './exit-codes.js';

const CLI_NAME = 'compfinder';
const COMMANDS: Command[] = [providersListCommand, configInitCommand, configPathCommand, configShowCommand];
/** Flags every command accepts. */
const GLOBAL_FLAGS = ['output', 'help', 'config'];
const DEFAULT_OUTPUT: OutputFormat = 'text';
/** Hints for flags people commonly reach for that compfinder doesn't have. */
const FLAG_HINTS: Record<string, string> = { json: 'Use --output=json.', csv: 'Use --output=csv.' };

/** Finds the command whose path matches the leading words. */
function findCommand(args: ParsedArgs): Command | undefined {
  return COMMANDS.find((command) => command.path.every((word, position) => args.words[position] === word));
}

/** Lists every command with its summary. */
function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.path.join(' ').length), 'version'.length);
  const lines = COMMANDS.map((command) => `  ${CLI_NAME} ${command.path.join(' ').padEnd(width)}  ${command.summary}`);
  return [
    `${CLI_NAME} ${packageVersion()}`,
    '',
    'Commands:',
    ...lines,
    `  ${CLI_NAME} ${'version'.padEnd(width)}  Show the version.`,
    '',
    'Every command takes --output=text|json (default text), --config=PATH and --help.',
    'Exit codes are listed in docs/cli.md.',
  ].join('\n');
}

/** A usage error, listing the problems. */
function usageResult(problems: string[], withHelp: boolean): CommandResult {
  const text = withHelp ? `${problems.join('\n')}\n\n${helpText()}` : problems.join('\n');
  return { exitCode: ExitCode.usage, data: { error: 'Usage error', problems }, text };
}

/** Lists everything wrong with how a command was invoked. */
function invocationProblems(command: Command, args: ParsedArgs, output: OutputFormat): string[] {
  const problems: string[] = [];
  const accepted = new Set([...GLOBAL_FLAGS, ...command.flags]);
  for (const name of args.flags.keys()) {
    if (!accepted.has(name)) {
      problems.push(`Unknown option --${name} for ${command.path.join(' ')}. ${FLAG_HINTS[name] ?? ''}`.trimEnd());
    }
  }
  const extraWords = args.words.slice(command.path.length);
  if (extraWords.length > 0) {
    problems.push(`Unexpected argument: ${extraWords.map((word) => `"${word}"`).join(' ')}.`);
  }
  if (!command.outputs.includes(output)) {
    problems.push(`--output=${output} isn't available for ${command.path.join(' ')}; use ${command.outputs.join(' or ')}.`);
  }
  return problems;
}

/** Collects the setting flags that were given, for the config reader. */
function configOverrides(args: ParsedArgs): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  for (const name of SETTING_FLAGS) {
    const value = args.flags.get(name);
    if (value !== undefined) {
      overrides[name as SettingFlag] = value;
    }
  }
  return overrides;
}

/** Loads config and runs a command; configuration problems become an invalidConfig result. */
async function runCommand(command: Command, args: ParsedArgs, output: OutputFormat): Promise<CommandResult> {
  let result: CommandResult;
  try {
    const config = loadConfigFromEnvironment(configOverrides(args));
    const logger = createLogger({ level: config.logLevel, tag: CLI_NAME, stderrOnly: true });
    for (const warning of config.warnings) {
      logger.warn(warning);
    }
    const colour = config.colour && process.stdout.isTTY;
    result = await command.run({ args, config, output, logger, colour });
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    result = { exitCode: ExitCode.invalidConfig, data: { error: 'Invalid configuration', problems: error.problems }, text: error.message };
  }
  return result;
}

/** Runs the CLI and resolves to the process exit code. */
async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const outputValue = stringFlag(args, 'output') ?? DEFAULT_OUTPUT;
  const output = OUTPUT_FORMATS.find((format) => format === outputValue);
  const command = findCommand(args);
  const firstWord = args.words[0];
  const problems = [...args.problems];
  if (output === undefined) {
    problems.push(`--output must be one of ${OUTPUT_FORMATS.join(', ')}; got "${outputValue}".`);
  }
  let result: CommandResult;

  if (problems.length > 0 || output === undefined) {
    result = usageResult(problems, false);
  } else if (firstWord === 'version' && args.words.length === 1) {
    result = { exitCode: ExitCode.success, data: { version: packageVersion() }, text: packageVersion() };
  } else if (firstWord === undefined || firstWord === 'help' || (command !== undefined && booleanFlag(args, 'help'))) {
    result = {
      exitCode: ExitCode.success,
      data: { commands: COMMANDS.map((entry) => ({ command: entry.path.join(' '), summary: entry.summary, usage: entry.usage })) },
      text: command === undefined ? helpText() : `${command.summary}\n\nUsage: ${command.usage}`,
    };
  } else if (command === undefined) {
    result = usageResult([`Unknown command: ${args.words.map((word) => `"${word}"`).join(' ')}. Every invocation starts with a command.`], true);
  } else {
    const invocation = invocationProblems(command, args, output);
    result = invocation.length > 0 ? usageResult(invocation, false) : await runCommand(command, args, output);
  }

  if (output === 'json') {
    console.log(JSON.stringify({ ok: result.exitCode === ExitCode.success, exitCode: result.exitCode, ...result.data }));
  } else if (result.text !== '') {
    const write = result.exitCode === ExitCode.success ? console.log : console.error;
    write(result.text);
  }
  return result.exitCode;
}

// Never process.exit() here: it drops output still queued for a pipe.
main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = ExitCode.failure;
  });
