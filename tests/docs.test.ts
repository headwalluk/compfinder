import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ExitCode } from '../src/cli/exit-codes.js';
import { SETTING_FLAGS, knownVariables, settingSpecs } from '../src/config.js';

const CLI_DOC = readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');
const CONFIGURATION_DOC = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');

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
});
