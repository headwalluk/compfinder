import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ExitCode } from '../src/cli/exit-codes.js';
import { SETTING_FLAGS, knownVariables, settingSpecs } from '../src/config.js';
import { PROVIDER_RUN_STATUSES } from '../src/lookup/errors.js';
import { ERROR_CODES } from '../src/messages/error-codes.js';
import { RULE_IDS } from '../src/scoring/rules.js';

const CLI_DOC = readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');
const CONFIGURATION_DOC = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
const OUTPUT_DOC = readFileSync(new URL('../docs/output.md', import.meta.url), 'utf8');
const CONFIDENCE_DOC = readFileSync(new URL('../docs/confidence.md', import.meta.url), 'utf8');

describe('documentation agrees with the code', () => {
  test('every exit code is in the table in docs/cli.md', () => {
    for (const [name, code] of Object.entries(ExitCode)) {
      assert.match(CLI_DOC, new RegExp(`^\\| ${code} \\| ${name} \\|`, 'm'), `exit code ${code} ${name}`);
    }
  });

  test('every setting flag is in docs/cli.md', () => {
    for (const flag of SETTING_FLAGS) {
      assert.match(CLI_DOC, new RegExp(`--${flag}\\b`), `--${flag}`);
    }
  });

  test('every setting and environment variable is in docs/configuration.md', () => {
    for (const spec of settingSpecs('')) {
      const documentedKey = spec.key.startsWith('priority.') ? 'priority.<field>' : spec.key;
      const isProviderSetting = spec.key.startsWith('providers.') && spec.key.endsWith('.enabled');
      const expected = isProviderSetting ? 'providers.<name>.enabled' : documentedKey;
      assert.ok(CONFIGURATION_DOC.includes(`\`${expected}\``), `${spec.key} documented`);
    }
    for (const variable of knownVariables()) {
      assert.ok(CONFIGURATION_DOC.includes(`\`${variable}\``), `${variable} documented`);
    }
  });

  test('every confidence rule is in docs/confidence.md', () => {
    for (const rule of RULE_IDS) {
      assert.ok(CONFIDENCE_DOC.includes(`\`${rule}\``), `${rule} documented`);
    }
  });

  test('every error code, with its exit code, and every provider status is in docs/output.md', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      assert.match(OUTPUT_DOC, new RegExp(`^\\| \`${code.replace('.', '\\.')}\` \\| ${entry.exitCode} \\|`, 'm'), `${code} documented`);
    }
    for (const status of PROVIDER_RUN_STATUSES) {
      assert.match(OUTPUT_DOC, new RegExp(`^\\| \`${status}\` \\|`, 'm'), `${status} documented`);
    }
  });
});
