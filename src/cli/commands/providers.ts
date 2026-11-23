import { checkProviders } from '../../lookup/engine.js';
import { PROVIDER_DECLARATIONS, PROVIDER_NAMES, DEFAULT_FIELD_PRIORITY, isProviderName } from '../../providers/declarations.js';
import { builtInProviders } from '../../providers/registry.js';
import { providerStatus } from '../../providers/status.js';
import type { Command, CommandResult } from '../command.js';
import { ExitCode } from '../exit-codes.js';

/** Gap between the name and status columns. */
const COLUMN_GAP = 3;

export const providersListCommand: Command = {
  path: ['providers', 'list'],
  summary: 'List the built-in providers and whether each is configured. Makes no network calls.',
  usage: 'compfinder providers list [--output=text|json]',
  flags: [],
  outputs: ['text', 'json'],
  async run({ config }) {
    const providers = PROVIDER_NAMES.map((name) => {
      const declaration = PROVIDER_DECLARATIONS[name];
      const report = providerStatus(declaration, config.providers[name]);
      const defaultPriority: Record<string, number> = {};
      for (const field of declaration.supplies) {
        defaultPriority[field] = DEFAULT_FIELD_PRIORITY[field].indexOf(name) + 1;
      }
      return {
        name,
        status: report.status,
        missing: report.missing,
        summary: declaration.summary,
        stage: declaration.stage,
        metered: declaration.metered,
        inputs: declaration.inputs,
        supplies: declaration.supplies,
        defaultPriority,
      };
    });
    const nameWidth = Math.max(...providers.map((provider) => provider.name.length)) + COLUMN_GAP;
    const statusWidth = Math.max(...providers.map((provider) => provider.status.length)) + COLUMN_GAP;
    const lines = providers.map((provider) => {
      const detail = provider.missing === null ? '' : `(${provider.missing})`;
      return `${provider.name.padEnd(nameWidth)}${provider.status.padEnd(statusWidth)}${detail}`.trimEnd();
    });
    return { exitCode: ExitCode.success, data: { providers }, text: lines.join('\n') };
  },
};

export const providersCheckCommand: Command = {
  path: ['providers', 'check'],
  summary: 'Prove each configured provider\'s credentials with one cheap live call. Never prints a key.',
  usage: 'compfinder providers check [provider] [--output=text|json]',
  flags: [],
  maxArguments: 1,
  outputs: ['text', 'json'],
  async run({ args, config, logger }) {
    const requested = args.words[2];
    let result: CommandResult;
    if (requested !== undefined && !isProviderName(requested)) {
      result = {
        exitCode: ExitCode.usage,
        data: { error: `Unknown provider ${requested}`, problems: [`"${requested}" isn't a provider. Providers are ${PROVIDER_NAMES.join(', ')}.`] },
        text: `"${requested}" isn't a provider. Providers are ${PROVIDER_NAMES.join(', ')}.`,
      };
    } else {
      const checks = await checkProviders({ providers: builtInProviders(config), config, logger, ...(requested === undefined ? {} : { only: [requested] }) });
      const failed = checks.filter((check) => !['ok', 'skipped', 'not_configured'].includes(check.status));
      const nameWidth = Math.max(...checks.map((check) => check.name.length)) + COLUMN_GAP;
      const statusWidth = Math.max(...checks.map((check) => check.status.length)) + COLUMN_GAP;
      result = {
        exitCode: failed.length > 0 ? ExitCode.failure : ExitCode.success,
        data: { providers: checks },
        text: checks.map((check) => `${check.name.padEnd(nameWidth)}${check.status.padEnd(statusWidth)}${check.detail === null ? '' : `(${check.detail})`}`.trimEnd()).join('\n'),
      };
    }
    return result;
  },
};
