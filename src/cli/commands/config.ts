import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SETTING_FLAGS } from '../../config.js';
import { packageFileUrl } from '../../package-files.js';
import type { Command } from '../command.js';
import { ExitCode } from '../exit-codes.js';

const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const SAMPLE_FILE_NAME = 'config.sample.toml';
/** Gap between the key, value and source columns. */
const COLUMN_GAP = 2;

export const configPathCommand: Command = {
  path: ['config', 'path'],
  summary: 'Show which config file is used, and whether it exists.',
  usage: 'compfinder config path [--config=PATH] [--output=text|json]',
  flags: [],
  outputs: ['text', 'json'],
  async run({ config }) {
    const state = config.configFileExists ? '' : '  (not created yet: run compfinder config init)';
    return {
      exitCode: ExitCode.success,
      data: { path: config.configPath, exists: config.configFileExists },
      text: `${config.configPath}${state}`,
    };
  },
};

export const configShowCommand: Command = {
  path: ['config', 'show'],
  summary: 'Show the effective settings and where each came from. API keys show only as set or unset.',
  usage: 'compfinder config show [--config=PATH] [setting flags] [--output=text|json]',
  flags: SETTING_FLAGS,
  outputs: ['text', 'json'],
  async run({ config }) {
    const rows = config.settings.map((setting) => ({
      key: setting.key,
      value: typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value),
      source: setting.source,
    }));
    const keyWidth = Math.max(...rows.map((row) => row.key.length)) + COLUMN_GAP;
    const valueWidth = Math.max(...rows.map((row) => row.value.length)) + COLUMN_GAP;
    const fileState = config.configFileExists ? '' : ' (not found; defaults apply)';
    const lines = [
      `Config file: ${config.configPath}${fileState}`,
      '',
      ...rows.map((row) => `${row.key.padEnd(keyWidth)}${row.value.padEnd(valueWidth)}${row.source}`),
    ];
    return {
      exitCode: ExitCode.success,
      data: { configPath: config.configPath, configFileExists: config.configFileExists, settings: config.settings },
      text: lines.join('\n'),
    };
  },
};

export const configInitCommand: Command = {
  path: ['config', 'init'],
  summary: 'Write a commented config file to the config path. Never overwrites an existing file.',
  usage: 'compfinder config init [--config=PATH] [--output=text|json]',
  flags: [],
  outputs: ['text', 'json'],
  async run({ config, logger }) {
    const sample = readFileSync(packageFileUrl(SAMPLE_FILE_NAME), 'utf8');
    let isWritten = false;
    try {
      mkdirSync(path.dirname(config.configPath), { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      writeFileSync(config.configPath, sample, { flag: 'wx', mode: CONFIG_FILE_MODE });
      isWritten = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      logger.debug('Config file already exists; not overwriting', { path: config.configPath });
    }
    return isWritten
      ? {
        exitCode: ExitCode.success,
        data: { path: config.configPath, written: true },
        text: `Wrote ${config.configPath}\nEdit it to add API keys and change settings. Run compfinder providers list to check.`,
      }
      : {
        exitCode: ExitCode.refused,
        data: { path: config.configPath, written: false, error: 'Config file already exists' },
        text: `${config.configPath} already exists. compfinder never overwrites it; edit it, or move it aside first.`,
      };
  },
};
